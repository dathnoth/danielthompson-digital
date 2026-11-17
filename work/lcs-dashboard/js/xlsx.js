// Reads Excel (.xlsx) and CSV files in the browser into plain tables, the same shape
// server.py produces: { file, modified, sheets: [{ name, rows: [[cell, ...], ...] }] }.
// An .xlsx file is a zip of XML files; this reads just the parts needed for cell values.

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const pad = (n) => String(n).padStart(2, "0");

// exactRows: rows stay at their row number (rows the file leaves out come back empty),
// instead of being listed one after another
export async function readSpreadsheet(file, { exactRows = false } = {}) {
  const modified = new Date(file.lastModified);
  const entry = {
    file: file.name,
    modified: `${modified.getFullYear()}-${pad(modified.getMonth() + 1)}-${pad(modified.getDate())}T${pad(modified.getHours())}:${pad(modified.getMinutes())}:${pad(modified.getSeconds())}`,
  };
  try {
    entry.sheets = /\.csv$/i.test(file.name)
      ? [{ name: file.name, rows: parseCsvRows((await file.text()).replace(/^\uFEFF/, "")) }]
      : await readXlsx(await file.arrayBuffer(), exactRows);
  } catch (err) {
    entry.error = err.message;
  }
  return entry;
}

// ---------- zip ----------

export async function unzip(buffer) {
  const view = new DataView(buffer);
  let end = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("Not an Excel (.xlsx) file");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const files = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Damaged Excel file");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, p + 46, nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    files.set(name, { method, data: new Uint8Array(buffer, start, size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const bytes = async (name) => {
    const f = files.get(name);
    if (!f) throw new Error(`Missing ${name}`);
    if (f.method === 0) return f.data;
    const stream = new Blob([f.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  return {
    names: () => [...files.keys()],
    has: (name) => files.has(name),
    bytes,
    text: async (name) => decoder.decode(await bytes(name)),
  };
}

// ---------- xlsx ----------

const xml = (text) => new DOMParser().parseFromString(text, "application/xml");
const all = (node, tag) => [...node.getElementsByTagNameNS("*", tag)];
const kids = (node, tag) => [...(node?.childNodes ?? [])].filter((c) => c.nodeType === 1 && c.localName === tag);
const textOf = (node) => all(node, "t").map((t) => t.textContent).join("");

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function excelDate(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(Number(serial) * 86400) * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

async function readXlsx(buffer, exactRows) {
  const zip = await unzip(buffer);
  const shared = zip.has("xl/sharedStrings.xml") ? kids(xml(await zip.text("xl/sharedStrings.xml")).documentElement, "si").map(textOf) : [];

  const dateStyles = new Set();
  if (zip.has("xl/styles.xml")) {
    const styles = xml(await zip.text("xl/styles.xml"));
    const custom = new Map(all(styles, "numFmt").map((f) => [Number(f.getAttribute("numFmtId")), f.getAttribute("formatCode") ?? ""]));
    kids(all(styles, "cellXfs")[0], "xf").forEach((xf, i) => {
      const id = Number(xf.getAttribute("numFmtId") ?? 0);
      const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "").toLowerCase();
      if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && /[dmyh]/.test(code))) dateStyles.add(i);
    });
  }

  const workbook = xml(await zip.text("xl/workbook.xml"));
  const rels = xml(await zip.text("xl/_rels/workbook.xml.rels"));
  const targets = new Map(all(rels, "Relationship").map((r) => [r.getAttribute("Id"), r.getAttribute("Target")]));

  const sheets = [];
  for (const sheet of all(workbook, "sheet")) {
    let target = targets.get(sheet.getAttributeNS(REL_NS, "id") ?? sheet.getAttribute("r:id")).replace(/^\//, "");
    if (!target.startsWith("xl/")) target = `xl/${target}`;
    const doc = xml(await zip.text(target));
    const rows = [];
    for (const row of all(doc, "row")) {
      const values = [];
      for (const c of kids(row, "c")) {
        const kind = c.getAttribute("t");
        const style = Number(c.getAttribute("s") ?? 0);
        const v = kids(c, "v")[0];
        let value;
        if (kind === "inlineStr") value = textOf(c);
        else if (!v) continue;
        else if (kind === "s") value = shared[Number(v.textContent)];
        else if (kind === "str" || kind === "e") value = v.textContent;
        else if (kind === "b") value = v.textContent === "1";
        else if (dateStyles.has(style)) value = excelDate(v.textContent);
        else value = Number(v.textContent);
        values[colIndex(c.getAttribute("r"))] = value;
      }
      const cells = Array.from(values, (v) => (v === undefined ? null : v));
      if (exactRows) rows[Number(row.getAttribute("r")) - 1] = cells;
      else rows.push(cells);
    }
    sheets.push({ name: sheet.getAttribute("name"), rows: Array.from(rows, (r) => r ?? []) });
  }
  return sheets;
}

// ---------- csv ----------

function parseCsvRows(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

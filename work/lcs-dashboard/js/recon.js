// "Cash summary workbook" box at the bottom of the dashboard: builds Val's monthly
// "CL Cash Summary Daily and Bank Recon" workbook for a chosen month. It fills a blank copy
// of her October 2026 workbook (recon-template.xlsx, every formula kept) with each day's
// Sales report and Close day report from CuisineIQ, exactly where she pastes them by hand.
// During the month it fills the days up to yesterday and leaves the rest for a later run.

import { unzip, readSpreadsheet } from "./xlsx.js";

const DAYS_PER_REQUEST = 7; // what /api/recon allows (src/recon.js)
const FIRST_ROW = 15; // Daily Sales: the 1st of the month is on row 15, the 31st on row 45
const PASTE_OFFSET = 10; // the Close day report goes in column K onwards instead of A
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const pad = (n) => String(n).padStart(2, "0");

// `previous`: last month's finished workbook (a File), for "Outstanding prv month".
// Returns { blob, fileName, note }
export async function buildReconWorkbook(month, onProgress = () => {}, { previous } = {}) {
  const [year, mon] = month.split("-").map(Number);
  const monthName = (y, m) => new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const outstanding = previous ? await outstandingFrom(previous, monthName(mon === 1 ? year - 1 : year, mon === 1 ? 12 : mon - 1)) : null;
  const dayCount = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const today = new Date();
  const thisMonth = year === today.getFullYear() && mon === today.getMonth() + 1;
  if (year > today.getFullYear() || (year === today.getFullYear() && mon > today.getMonth() + 1)) {
    throw new Error("That month hasn't started yet.");
  }
  const lastDay = thisMonth ? today.getDate() - 1 : dayCount; // today isn't over yet
  if (!lastDay) throw new Error("The 1st isn't over yet, so there's nothing to fill in. Try again tomorrow.");

  const days = [];
  for (let start = 1; start <= lastDay; start += DAYS_PER_REQUEST) {
    const end = Math.min(start + DAYS_PER_REQUEST - 1, lastDay);
    onProgress(`Fetching ${start}–${end} of ${lastDay} days from CuisineIQ…`);
    const res = await fetch(`api/recon?from=${month}-${pad(start)}&to=${month}-${pad(end)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `CuisineIQ couldn't be reached (${res.status}).`);
    days.push(...body.days);
  }

  onProgress("Building the workbook…");
  const res = await fetch("recon-template.xlsx", { cache: "no-store" });
  if (!res.ok) throw new Error("The workbook template is missing.");
  const zip = await unzip(await res.arrayBuffer());
  const files = new Map();
  for (const name of zip.names()) files.set(name, await zip.bytes(name));
  const docs = new Map(); // XML files that are being changed
  const doc = (name) => {
    if (!docs.has(name)) docs.set(name, new DOMParser().parseFromString(new TextDecoder().decode(files.get(name)), "application/xml"));
    return docs.get(name);
  };

  const workbook = doc("xl/workbook.xml");
  const rels = doc("xl/_rels/workbook.xml.rels");
  const relOf = (sheet) => [...rels.getElementsByTagName("Relationship")].find((r) => r.getAttribute("Id") === sheet.getAttributeNS(REL_NS, "id"));
  const sheetFile = (rel) => rel.getAttribute("Target").replace(/^\//, "").replace(/^(?!xl\/)/, "xl/");
  const sheets = new Map([...workbook.getElementsByTagName("sheet")].map((s) => [s.getAttribute("name"), s]));
  const sheetDoc = (name) => doc(sheetFile(relOf(sheets.get(name))));

  const summary = sheetDoc("Daily Sales");
  const title = cell(summary, "A1");
  setCell(summary, "A1", title.textContent.replace(/month of .*/, `month of ${monthName(year, mon)}`));
  if (outstanding != null) setCell(summary, OUTSTANDING_PREVIOUS, outstanding);
  setCell(sheetDoc("1"), "I1", excelDate(`${month}-01`));

  for (const { day, salesReport, closeDay } of days) {
    const d = Number(day.slice(8));
    const row = FIRST_ROW + d - 1;
    // No row when there were no sales that day: Vatable Sales and VAT stay blank
    const sales = salesReport.find((r) => String(r[0] ?? "").startsWith(day));
    const col = (name) => salesReport.find((r) => r.includes("Amount Excl. Vat"))?.indexOf(name);
    if (sales) {
      setCell(summary, `B${row}`, sales[col("Amount Excl. Vat") ?? 2]);
      setCell(summary, `E${row}`, sales[col("Vat amount 15%") ?? 3]);
    }

    // Paste the Close day report, leaving the template's formulas where it has them
    const tab = sheetDoc(String(d));
    closeDay.forEach((cells, r) => cells.forEach((value, c) => {
      if (value !== null && value !== "") setCell(tab, `${columnName(c + PASTE_OFFSET)}${r + 1}`, value);
    }));
  }

  // Shorter months: drop the tabs for days that don't exist, and their links on Daily Sales
  for (let d = dayCount + 1; d <= 31; d++) {
    const sheet = sheets.get(String(d));
    const rel = relOf(sheet);
    const file = sheetFile(rel);
    files.delete(file);
    docs.delete(file);
    for (const o of [...doc("[Content_Types].xml").getElementsByTagName("Override")]) {
      if (o.getAttribute("PartName") === `/${file}`) o.remove();
    }
    rel.remove();
    sheet.remove();
    for (const c of ["A", "B", "C", "E", "G", "H", "I", "J", "K", "M", "N", "O", "P", "Q", "T"]) clearCell(summary, `${c}${FIRST_ROW + d - 1}`);
  }

  for (const [name, d] of docs) files.set(name, new TextEncoder().encode(new XMLSerializer().serializeToString(d)));
  return {
    blob: new Blob([await zipFiles(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    // Named like Val's (YYMM); a part-month one says which days it has
    fileName: `CL Cash Summary Daily and Bank Recon ${month.slice(2, 4)}${month.slice(5, 7)}${lastDay < dayCount ? ` (1-${lastDay})` : ""}.xlsx`,
    note: outstanding != null ? `Outstanding prv month: Rs ${outstanding.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}, carried over from last month's workbook.` : null,
  };
}

// Daily Sales: cash takings not yet banked. This month's "Outstanding cur month" becomes
// next month's "Outstanding prv month" (her September 2026 workbook ties out this way).
const OUTSTANDING_PREVIOUS = "V56";
const OUTSTANDING_CURRENT = { row: 57, col: 21 }; // V57, =AF53

// Reads "Outstanding cur month" from last month's workbook, as Excel last worked it out
async function outstandingFrom(file, expectedMonth) {
  const { sheets, error } = await readSpreadsheet(file, { exactRows: true });
  if (error) throw new Error(`Last month's workbook couldn't be read: ${error}`);
  const rows = sheets?.find((s) => s.name === "Daily Sales")?.rows;
  if (!rows || !String(rows[0]?.[0] ?? "").includes("month of")) throw new Error("That file isn't a cash summary workbook (it has no Daily Sales page).");
  if (!String(rows[0][0]).includes(expectedMonth)) {
    throw new Error(`That workbook is for ${String(rows[0][0]).replace(/.*month of /, "")}, not ${expectedMonth}.`);
  }
  const value = rows[OUTSTANDING_CURRENT.row - 1]?.[OUTSTANDING_CURRENT.col];
  if (typeof value !== "number") throw new Error("Last month's workbook has no Outstanding cur month figure saved. Open it in Excel, save it, and try again.");
  return Math.round(value * 100) / 100;
}

// ---------- cells ----------

function columnName(index) {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const columnIndex = (ref) => [...ref.match(/[A-Z]+/)[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const rowIndex = (ref) => Number(ref.match(/\d+/)[0]);

// Days since 30 Dec 1899, how Excel stores dates
const excelDate = (iso) => (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000;

// The <c> element for a cell, made (in order) if the sheet doesn't have it yet
function cell(sheet, ref, create = true) {
  const ns = sheet.documentElement.namespaceURI;
  const data = sheet.getElementsByTagNameNS(ns, "sheetData")[0];
  const r = rowIndex(ref);
  let row = [...data.children].find((x) => Number(x.getAttribute("r")) >= r);
  if (!row || Number(row.getAttribute("r")) !== r) {
    if (!create) return null;
    const made = sheet.createElementNS(ns, "row");
    made.setAttribute("r", r);
    data.insertBefore(made, row ?? null);
    row = made;
  }
  const col = columnIndex(ref);
  let c = [...row.children].find((x) => columnIndex(x.getAttribute("r")) >= col);
  if (!c || c.getAttribute("r") !== ref) {
    if (!create) return null;
    const made = sheet.createElementNS(ns, "c");
    made.setAttribute("r", ref);
    row.insertBefore(made, c ?? null);
    c = made;
  }
  return c;
}

// Writes a value, keeping the cell's formatting. Cells with a formula keep the formula.
function setCell(sheet, ref, value) {
  const c = cell(sheet, ref);
  const ns = sheet.documentElement.namespaceURI;
  if ([...c.children].some((x) => x.localName === "f")) return;
  c.replaceChildren();
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(value)) value = excelDate(value);
  if (typeof value === "number") {
    c.setAttribute("t", "n");
    c.appendChild(sheet.createElementNS(ns, "v")).textContent = String(value);
  } else {
    c.setAttribute("t", "inlineStr");
    const t = c.appendChild(sheet.createElementNS(ns, "is")).appendChild(sheet.createElementNS(ns, "t"));
    t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
    t.textContent = String(value);
  }
}

// Empties a cell, formula included, keeping its formatting
function clearCell(sheet, ref) {
  const c = cell(sheet, ref, false);
  if (!c) return;
  c.replaceChildren();
  c.removeAttribute("t");
}

// ---------- zip ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zipFiles(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const [name, data] of files) {
    const packed = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 8, true); // deflate
    local.setUint32(14, crc, true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, 8, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, packed.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    parts.push(local, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const size = central.reduce((a, p) => a + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.size, true);
  end.setUint16(10, files.size, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end]);
}

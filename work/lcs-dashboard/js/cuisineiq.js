// Understands CuisineIQ's Excel exports: works out what each file is, merges overlapping
// exports and builds the dataset described in data-source.js. Pure functions with no
// fetching, so the same code runs in the browser and in scripts/push-to-d1.mjs.

import { CONFIG } from "./config.js";

export const DAY_MS = 86400000;
export const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export class NoExportsError extends Error {}

// =====================================================================
// CuisineIQ Excel exports (files in data/exports/, turned into tables by server.py)
// =====================================================================

const normalise = (s) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();

// `body` is what server.py's /api/exports returns: { files: [{ file, modified, sheets: [{ name, rows }] }] }
export function buildFromExports(body, { labels, paymentSections, creditNoteSections, bestSellerExcludeCategories }) {
  const matchers = Object.fromEntries(Object.entries(labels).map(([k, list]) => [k, new Set(list.map(normalise))]));
  const files = [];
  const reports = { sales: [], productSold: [], productList: [], payments: [], creditNotes: [] };
  const sectionTitles = {
    payments: new Map(Object.entries(paymentSections).map(([title, name]) => [normalise(title), name])),
    creditNotes: new Set(creditNoteSections.map(normalise)),
  };

  for (const f of body.files ?? []) {
    if (f.error) { files.push({ file: f.file, type: "Unreadable file", used: false, note: f.error }); continue; }
    let recognised = false;
    let fileMeta = {};
    for (const sheet of f.sheets) {
      const found = [readReport(sheet.rows, matchers), ...readSectionedReports(sheet.rows, matchers, sectionTitles)].filter(Boolean);
      for (const report of found) {
        recognised = true;
        // Some workbooks only state the period on their first sheet
        report.meta = { ...fileMeta, ...report.meta };
        fileMeta = { ...fileMeta, ...report.meta };
        Object.assign(report, { file: f.file, printed: report.meta.printDate ?? parseDate(f.modified), modified: parseDate(f.modified) });
        reports[report.type].push(report);
      }
      fileMeta = { ...readMeta(sheet.rows, sheet.rows.length, matchers), ...fileMeta };
    }
    if (!recognised) files.push({ file: f.file, type: "Not recognised", used: false, note: "No familiar CuisineIQ column headings found." });
  }

  if (!reports.sales.length) {
    throw new NoExportsError(
      reports.productSold.length || reports.productList.length
        ? "No CuisineIQ sales report found in data/exports/ (needed for daily totals)."
        : "No CuisineIQ exports found in data/exports/."
    );
  }

  const newestFirst = (a, b) => b.printed - a.printed || b.modified - a.modified;

  // Sales reports: merge by day; when several exports include the same day, the most
  // recently printed one wins (so a fresh export replaces a half-finished day).
  const daily = new Map();
  for (const r of reports.sales.sort(newestFirst)) {
    let used = 0;
    for (const day of r.salesRows) {
      if (daily.has(dayKey(day.date))) continue;
      daily.set(dayKey(day.date), { ...day, printed: r.printed });
      used++;
    }
    files.push({
      file: r.file,
      type: "Sales report",
      used: used > 0,
      note: `${rangeText(r)} · printed ${dateTimeText(r.printed)}` + (used ? "" : " · every day already covered by a newer export"),
    });
  }

  // Product list: newest one; identical copies are reported as duplicates.
  let catalogue = null;
  const seenLists = new Map();
  for (const r of reports.productList.sort(newestFirst)) {
    const signature = JSON.stringify(r.listRows);
    const duplicateOf = seenLists.get(signature);
    seenLists.set(signature, seenLists.get(signature) ?? r.file);
    const used = !catalogue;
    if (used) catalogue = r.listRows;
    files.push({
      file: r.file,
      type: "POS product list",
      used,
      note: duplicateOf ? `identical to ${duplicateOf}` : used ? `${r.listRows.length} products · printed ${dateTimeText(r.printed)}` : "replaced by a newer product list",
    });
  }
  const priceByName = new Map();
  const categoryByName = new Map();
  for (const p of catalogue ?? []) {
    const key = normalise(p.name);
    priceByName.set(key, priceByName.has(key) && priceByName.get(key) !== p.price ? null : p.price); // null = several prices
    if (p.category) categoryByName.set(key, p.category);
  }

  // Product sold: the export covering the longest period (newest if tied).
  let products = null;
  const bySpan = (a, b) => (b.meta.toDate - b.meta.fromDate) - (a.meta.toDate - a.meta.fromDate) || newestFirst(a, b);
  for (const r of reports.productSold.sort(bySpan)) {
    const used = !products;
    if (used) {
      const exclude = new Set(bestSellerExcludeCategories.map(normalise));
      products = {
        from: r.meta.fromDate,
        to: r.meta.toDate,
        printed: r.printed,
        excludeFromBestSellers: (category) => exclude.has(normalise(category)),
        items: r.soldRows
          .filter((p) => p.quantity || p.revenue)
          .map((p) => ({
            ...p,
            category: p.category || categoryByName.get(normalise(p.name)) || "Uncategorised",
            price: priceByName.get(normalise(p.name)) ?? null,
          })),
      };
    }
    const samePeriod = !used && +r.meta.fromDate === +products.from && +r.meta.toDate === +products.to;
    const covered = !used && r.meta.fromDate >= products.from && r.meta.toDate <= products.to;
    files.push({
      file: r.file,
      type: "Product sold",
      used,
      note: `${rangeText(r)} · printed ${dateTimeText(r.printed)}` +
        (samePeriod ? " · same period as the export used (duplicate)" : covered ? " · inside the period of the export used" : ""),
    });
  }

  const days = [...daily.values()].sort((a, b) => a.date - b.date);
  addPayments(days, reports.payments, files);
  addRefunds(days, reports.creditNotes, files);
  const newestSales = reports.sales[0];
  const lastDay = days[days.length - 1].date;
  // The export only says when it was printed. If that was during the last day, that day is unfinished.
  const asOf = newestSales.printed && dayKey(newestSales.printed) === dayKey(lastDay)
    ? newestSales.printed
    : new Date(+lastDay + DAY_MS - 1000);

  return {
    isSample: false,
    shopName: reports.productSold[0]?.outlet ?? null,
    currency: CONFIG.currency,
    asOf,
    daily: days,
    lines: null,
    products,
    catalogue,
    files,
  };
}

// How customers paid, per day, from the till-closing ("Close day") export. It lists every
// card, Juice and customer-account payment with its date; cash isn't itemised, so cash is
// worked out as the day's total sales minus the other payments.
function addPayments(days, reports, files) {
  if (!reports.length) return;
  // The same payment can appear in several overlapping exports: count each one once.
  const counts = new Map();
  for (const r of reports) {
    const inFile = new Map();
    for (const e of r.entries) {
      const key = `${e.method}|${e.reference}|${e.amount}|${dayKey(e.date)}`;
      inFile.set(key, (inFile.get(key) ?? 0) + 1);
    }
    for (const [key, n] of inFile) counts.set(key, Math.max(counts.get(key) ?? 0, n));
  }
  const byDay = new Map();
  for (const [key, n] of counts) {
    const [method, , amount, day] = key.split("|");
    const totals = byDay.get(day) ?? {};
    totals[method] = (totals[method] ?? 0) + Number(amount) * n;
    byDay.set(day, totals);
  }
  // Transactions: ticket numbers restart at 1 each day on each till, so the highest one
  // seen on a till is how many tickets it rang up. Cash tickets aren't listed but still use
  // up numbers; only cash tickets after a till's last card payment are missed.
  const lastTicket = new Map(); // "day|till" → highest sequence number
  for (const r of reports) {
    for (const e of r.entries) {
      const m = e.reference.match(/^([A-Z]\d{3})(\d{6})(\d+)$/);
      if (!m) continue;
      const key = `${dayKey(e.date)}|${m[1]}`;
      lastTicket.set(key, Math.max(lastTicket.get(key) ?? 0, +m[3]));
    }
  }
  const ticketsByDay = new Map();
  for (const [key, n] of lastTicket) {
    const day = key.slice(0, 10);
    ticketsByDay.set(day, (ticketsByDay.get(day) ?? 0) + n);
  }

  const from = new Date(Math.min(...reports.map((r) => r.meta.fromDate ?? r.firstDate)));
  const to = new Date(Math.max(...reports.map((r) => r.meta.toDate ?? r.lastDate)));
  for (const d of days) {
    if (d.date < from || d.date > to) continue;
    const other = byDay.get(dayKey(d.date)) ?? {};
    const nonCash = Object.values(other).reduce((a, v) => a + v, 0);
    d.payments = { Cash: Math.max(0, d.sales - nonCash), ...other };
    if (ticketsByDay.has(dayKey(d.date))) d.transactions = ticketsByDay.get(dayKey(d.date));
  }
  for (const r of reports) {
    files.push({
      file: r.file,
      type: "Till closing (payments)",
      used: true,
      note: `${whole(r.entries.length)} card, Juice and account payments · ${rangeText(r)}`,
    });
  }
}

// Refunds per day, from the credit notes in the ticket journal.
function addRefunds(days, reports, files) {
  if (!reports.length) return;
  const byTicket = new Map(); // the same credit note can be in several exports
  for (const r of reports) for (const n of r.notes) byTicket.set(n.ticket, n);
  const byDay = new Map();
  for (const n of byTicket.values()) byDay.set(dayKey(n.date), (byDay.get(dayKey(n.date)) ?? 0) + n.amount);
  const from = new Date(Math.min(...reports.map((r) => r.meta.fromDate ?? r.firstDate)));
  const to = new Date(Math.max(...reports.map((r) => r.meta.toDate ?? r.lastDate)));
  for (const d of days) {
    if (d.date >= from && d.date <= to) d.refund = byDay.get(dayKey(d.date)) ?? 0;
  }
  for (const r of reports) {
    files.push({ file: r.file, type: "Ticket journal (refunds)", used: true, note: `${whole(r.notes.length)} credit notes · ${rangeText(r)}` });
  }
}

const whole = (n) => n.toLocaleString(CONFIG.locale);

// Splits a sheet into titled sections: a row with a single text cell (the title), then a
// heading row, then data rows up to the next blank row.
function sections(rows) {
  const filled = (r) => (r ?? []).filter((v) => v !== null && v !== "").length;
  const out = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const r = rows[i];
    if (filled(r) !== 1 || typeof r.find((v) => v !== null && v !== "") !== "string" || filled(rows[i + 1]) < 2) continue;
    const body = [];
    for (let j = i + 2; j < rows.length && filled(rows[j]) > 0; j++) body.push(rows[j]);
    out.push({ title: r.find((v) => v !== null && v !== ""), header: rows[i + 1], body });
  }
  return out;
}

// CuisineIQ ticket numbers look like I0012603020053 / T0022611010012: a letter, a 3-digit
// till number, the date as YYMMDD, then a sequence number.
// ASSUMPTION: inferred from the exports, where it matches the listed dates in 22,715 of 22,717 rows.
function dateFromTicket(ticket) {
  const m = String(ticket ?? "").match(/^[A-Z]\d{3}(\d{2})(\d{2})(\d{2})\d+$/);
  return m ? new Date(2000 + +m[1], +m[2] - 1, +m[3]) : null;
}

// Reports made of several titled sections: the till-closing details (payments) and the
// ticket journal (credit notes).
function readSectionedReports(rows, m, titles) {
  const found = [];
  const meta = readMeta(rows, rows.length, m);
  const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
  const col = (header, key) => header.findIndex((v) => m[key].has(normalise(v)));
  const entries = [];
  const notes = [];
  for (const sec of sections(rows)) {
    const title = normalise(sec.title);
    if (titles.payments.has(title)) {
      const amount = col(sec.header, "amount");
      const date = col(sec.header, "date");
      const ref = col(sec.header, "invoice");
      if (amount < 0) continue;
      for (const r of sec.body) {
        const d = (date >= 0 && parseDate(r[date])) || dateFromTicket(r[ref]);
        if (!d) continue;
        entries.push({ method: titles.payments.get(title), date: startOfDate(d), amount: num(r[amount]), reference: ref >= 0 ? String(r[ref] ?? "") : "" });
      }
    } else if (titles.creditNotes.has(title)) {
      const ticket = col(sec.header, "ticket");
      if (ticket < 0) continue;
      for (const r of sec.body) {
        const d = dateFromTicket(r[ticket]);
        if (!d) continue;
        // Refunded amount = the money columns of the row (they're negative)
        const amount = Math.abs(r.reduce((a, v, i) => (i !== ticket && typeof v === "number" ? a + v : a), 0));
        notes.push({ ticket: String(r[ticket]), date: d, amount });
      }
    }
  }
  const span = (list) => ({ firstDate: Math.min(...list.map((e) => +e.date)), lastDate: Math.max(...list.map((e) => +e.date)) });
  if (entries.length) found.push({ type: "payments", meta, entries, ...span(entries) });
  if (notes.length) found.push({ type: "creditNotes", meta, notes, ...span(notes) });
  return found;
}

const startOfDate = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// "Print date", "From date", "To date" found above row `end`.
function readMeta(rows, end, m) {
  const meta = {};
  for (const row of rows.slice(0, end)) {
    for (const key of ["printDate", "fromDate", "toDate"]) {
      if (meta[key]) continue;
      const i = row.findIndex((v) => m[key].has(normalise(v)));
      if (i >= 0) meta[key] = parseDate(row.slice(i + 1).find((v) => v !== null && v !== ""));
    }
  }
  return meta;
}

// Recognise one sheet: find the heading row, read the report details above it
// ("Print date", "From date", ...) and the rows below it.
function readReport(rows, m) {
  const cell = (row, key) => row.findIndex((v) => m[key].has(normalise(v)));
  const headerAt = rows.findIndex((row) =>
    (cell(row, "date") >= 0 && cell(row, "amountInclVat") >= 0) ||
    (cell(row, "product") >= 0 && (cell(row, "quantity") >= 0 || cell(row, "price") >= 0))
  );
  if (headerAt < 0) return null;
  const header = rows[headerAt];
  const col = (key) => cell(header, key);

  const meta = readMeta(rows, headerAt, m);
  const body = rows.slice(headerAt + 1).filter((r) => r.some((v) => v !== null && v !== ""));
  const num = (v) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/[^0-9.\-]/g, "")) || 0);
  const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

  if (col("date") >= 0 && col("amountInclVat") >= 0) {
    const salesRows = [];
    for (const r of body) {
      const date = parseDate(r[col("date")]);
      if (!date) continue; // e.g. the "Total" row
      salesRows.push({
        date: new Date(date.getFullYear(), date.getMonth(), date.getDate()),
        sales: num(r[col("amountInclVat")]),
        discount: col("discount") >= 0 ? Math.abs(num(r[col("discount")])) : 0,
        ...(col("amountExclVat") >= 0 && { exclVat: num(r[col("amountExclVat")]) }),
        ...(col("vat") >= 0 && { vat: num(r[col("vat")]) }),
      });
    }
    return { type: "sales", meta, salesRows };
  }

  if (col("quantity") >= 0 && col("productAmount") >= 0) {
    const soldRows = body
      .filter((r) => str(r[col("product")]))
      .map((r) => ({
        name: str(r[col("product")]),
        category: col("category") >= 0 ? str(r[col("category")]) : "",
        quantity: num(r[col("quantity")]),
        revenue: num(r[col("productAmount")]),
      }));
    const outlet = col("outlet") >= 0 ? str(body.find((r) => str(r[col("outlet")]))?.[col("outlet")]) || null : null;
    return { type: "productSold", meta, soldRows, outlet };
  }

  if (col("price") >= 0) {
    const listRows = body
      .filter((r) => str(r[col("product")]))
      .map((r) => ({
        category: col("category") >= 0 ? str(r[col("category")]) : "",
        name: str(r[col("product")]),
        price: num(r[col("price")]),
        ...(col("qtySold") >= 0 && { qtySold: num(r[col("qtySold")]) }),
      }));
    return { type: "productList", meta, listRows };
  }
  return null;
}

const dateText = (d) => d.toLocaleDateString(CONFIG.locale, { day: "numeric", month: "short", year: "numeric" });
const dateTimeText = (d) => (d ? `${dateText(d)}, ${d.toLocaleTimeString(CONFIG.locale, { hour: "2-digit", minute: "2-digit" })}` : "unknown");
const rangeText = (r) =>
  r.meta.fromDate && r.meta.toDate
    ? +r.meta.fromDate === +r.meta.toDate ? dateText(r.meta.fromDate) : `${dateText(r.meta.fromDate)} – ${dateText(r.meta.toDate)}`
    : "period not stated";


// =====================================================================
// Sending a dataset over the network (dates become text and back)
// =====================================================================

const DATE_FIELDS = ["asOf", "date", "from", "to", "printed"];
const pad = (n) => String(n).padStart(2, "0");
// Shop-local time without a time zone, so a day stays the same day wherever it's viewed
const localIso = (d) => `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function serialiseDataset(ds) {
  return JSON.stringify(ds, function (key, value) {
    if (key === "excludeFromBestSellers") return undefined;
    const raw = this[key];
    return raw instanceof Date ? localIso(raw) : value;
  });
}

export function reviveDataset(json, { bestSellerExcludeCategories }) {
  const ds = JSON.parse(json, (key, value) => (DATE_FIELDS.includes(key) && typeof value === "string" ? parseDate(value) : value));
  if (ds.products) {
    const exclude = new Set(bestSellerExcludeCategories.map(normalise));
    ds.products.excludeFromBestSellers = (category) => exclude.has(normalise(category));
  }
  return ds;
}

// =====================================================================
// Helpers
// =====================================================================

export function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (/T.*([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s); // has a time zone
  // 2026-11-02T08:15:00 / 2026-11-02 08:15 – shop-local time
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  // 02/11/2026 10:14 – CuisineIQ prints day/month/year
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return null;
}


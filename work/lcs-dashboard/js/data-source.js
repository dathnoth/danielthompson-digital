// Data loading. Everything that knows about *where* sales come from, and what
// CuisineIQ's reports look like, lives here. The rest of the dashboard only sees
// one "dataset" object:
//
//   {
//     isSample:  true/false,
//     shopName:  "COFFEE LOUNGE LTD" or null,
//     currency:  "MUR",
//     asOf:      Date,     // how up to date the figures are
//     daily:     [{ date, sales, discount, exclVat?, vat?, refund?, orders? }],   // always present
//     lines:     [{ orderId, at, product, category, quantity, unitPrice, gross,
//                   discount, refund, net, paymentType }] or null,             // item-level, timed
//     products:  { from, to, items: [{ name, category, quantity, revenue, price }] } or null,
//     catalogue: [{ category, name, price }] or null,
//     files:     [{ file, type, used, note }],   // what was read, for the "About this data" box
//     footTraffic: [{ date, visitors, entries, exits, staff, hours: [{ hour, visitors }] }] or null,
//                // people through the door per day, from the counter on the shop's PC
//   }
//
// `sales` is always what customers paid, VAT included, after discounts.
// Optional fields are left out when a source doesn't provide them, and the
// dashboard hides whatever it can't show.


import { CONFIG } from "./config.js";
import { buildFromExports, reviveDataset, parseDate, dayKey, DAY_MS, NoExportsError } from "./cuisineiq.js";

export async function loadDataset() {
  switch (CONFIG.source) {
    case "sample":
      return loadSample(CONFIG.sample);
    case "exports":
      return loadExports(CONFIG.exports);
    case "cloud":
      return loadFromCloud(CONFIG.cloud);
    case "cuisineiq-api":
      return loadFromCuisineIqApi(CONFIG["cuisineiq-api"]);
    case "auto":
      // Online: the Cloudflare database. On this computer: the files in data/exports/.
      // If neither has data, the sample.
      try {
        return await loadFromCloud(CONFIG.cloud);
      } catch (err) {
        if (!(err instanceof NoExportsError)) throw err;
        try {
          return await loadExports(CONFIG.exports);
        } catch (err2) {
          if (!(err2 instanceof NoExportsError)) throw err2;
          const sample = await loadSample(CONFIG.sample);
          sample.fallbackReason = err2.message;
          return sample;
        }
      }
    default:
      throw new Error(`Unknown data source "${CONFIG.source}" in js/config.js`);
  }
}

// =====================================================================
// Cloudflare database (D1), served by the Worker in src/worker.js
// =====================================================================

async function loadFromCloud({ url }) {
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    throw new NoExportsError("Couldn't reach the online database.");
  }
  if (res.status === 404) throw new NoExportsError("No online database here.");
  if (res.status === 401) { location.reload(); throw new Error("Please enter the PIN again."); }
  if (!res.ok) throw new Error(`Online database error ${res.status}`);
  const ds = reviveDataset(await res.text(), CONFIG.exports);
  ds.currency ??= CONFIG.currency;
  return ds;
}

// One product's sales per day: { covered: Set of day keys with product figures,
// byDay: Map day key → { quantity, revenue } }, or null if this source can't tell.
// Item-level sources work it out from their lines; the Cloudflare database keeps the
// single-day product exports fetched from CuisineIQ.
export async function loadProductHistory(ds, name) {
  if (ds.lines) {
    const covered = new Set();
    const byDay = new Map();
    for (const l of ds.lines) {
      const key = dayKey(l.at);
      covered.add(key);
      if (l.product !== name) continue;
      const d = byDay.get(key) ?? { quantity: 0, revenue: 0 };
      if (!l.refund) d.quantity += l.quantity;
      d.revenue += l.net;
      byDay.set(key, d);
    }
    return { covered, byDay };
  }
  if (ds.source !== "cloud") return null;
  const res = await fetch(`api/product-history?name=${encodeURIComponent(name)}`, { cache: "no-store" });
  if (res.status === 401) { location.reload(); throw new Error("Please enter the PIN again."); }
  if (!res.ok) throw new Error(`Online database error ${res.status}`);
  const body = await res.json();
  return {
    covered: new Set(body.covered.map((d) => d.slice(0, 10))),
    byDay: new Map(body.days.map((d) => [d.date.slice(0, 10), { quantity: d.quantity, revenue: d.revenue }])),
  };
}

// Product totals for a period ({ from, to } as in metrics.js), in the shape of
// productTotals in metrics.js plus `days`: how many days of the period they cover.
// Only the Cloudflare database can do this (from the product exports fetched each day);
// returns null for other sources.
export async function loadProductTotals(ds, range) {
  if (ds.lines || ds.source !== "cloud") return null;
  const last = new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate() - 1);
  const res = await fetch(`api/product-totals?from=${dayKey(range.from)}&to=${dayKey(last)}`, { cache: "no-store" });
  if (res.status === 401) { location.reload(); throw new Error("Please enter the PIN again."); }
  if (!res.ok) throw new Error(`Online database error ${res.status}`);
  const body = await res.json();
  return {
    from: range.from,
    to: last,
    fixedPeriod: false,
    days: body.days,
    items: body.items,
    exclude: ds.products?.excludeFromBestSellers ?? (() => false),
  };
}

// =====================================================================
// CuisineIQ Excel exports on this computer (data/exports/, read by server.py)
// =====================================================================

async function loadExports(settings) {
  let body;
  try {
    const res = await fetch(settings.url, { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    body = await res.json();
  } catch {
    throw new NoExportsError("The export reader isn't running (start the dashboard with server.py).");
  }
  return buildFromExports(body, settings);
}

// =====================================================================
// Sample data (CSV of timed, item-level sale lines)
// =====================================================================

async function loadSample({ files }) {
  const lines = [];
  for (const file of files) {
    const res = await fetch(file, { cache: "no-store" });
    if (!res.ok) throw new Error(`Couldn't load ${file} (${res.status})`);
    for (const row of parseCsv(await res.text())) {
      const quantity = Number(row.quantity) || 1;
      const unitPrice = Number(row.unit_price) || 0;
      const discount = Math.abs(Number(row.discount) || 0);
      const refund = Math.abs(Number(row.refund) || 0);
      lines.push({
        orderId: row.order_id,
        at: parseDate(row.datetime),
        product: row.product,
        category: row.category || "Other",
        quantity,
        unitPrice,
        gross: quantity * unitPrice,
        discount,
        refund,
        net: quantity * unitPrice - discount - refund,
        paymentType: row.payment_type || "Unknown",
      });
    }
  }
  // Portfolio demo: move the sample forward by whole weeks so its last day lands on or
  // after today, then keep only what has "happened" so far, so Today always has figures.
  const latest = lines.reduce((m, l) => (l.at > m ? l.at : m), new Date(0));
  const now = new Date();
  const weeks = Math.max(0, Math.ceil((now - latest) / (7 * 864e5)));
  if (weeks) for (const l of lines) { const d = new Date(l.at); d.setDate(d.getDate() + weeks * 7); l.at = d; }
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].at > now) lines.splice(i, 1);
  const ds = fromLines(lines, { isSample: true, currency: CONFIG.currency, files: files.map((file) => ({ file, type: "Sample data", used: true, note: "generated by scripts/generate_sample_data.py" })) });
  ds.footTraffic = sampleVisitors(ds.lines);
  ds.files.push({ file: "made up from the sample orders", type: "Sample visitors", used: true, note: "what the door counter would send" });
  return ds;
}

// Made-up door counts to go with the sample orders: each hour, somewhat more people come
// in than there are orders (friends tag along, some just look), plus a few staff. The same
// numbers every time.
function sampleVisitors(lines) {
  const orders = new Map(); // "YYYY-MM-DD|hour" → order ids
  for (const l of lines) {
    const key = `${dayKey(l.at)}|${l.at.getHours()}`;
    if (!orders.has(key)) orders.set(key, new Set());
    orders.get(key).add(l.orderId);
  }
  const random = (text) => { // 0–1 from a string, so a given hour always gets the same count
    let h = 2166136261;
    for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return (h >>> 0) / 4294967296;
  };
  const days = new Map();
  for (const [key, ids] of orders) {
    const [date, hour] = key.split("|");
    const visitors = Math.round(ids.size * (1.2 + 0.35 * random(key)) + 3 * random(`${key}+`));
    const staff = random(`${key}s`) < 0.3 ? 1 : 0;
    const d = days.get(date) ?? { date: parseDate(date), visitors: 0, entries: 0, exits: 0, staff: 0, hours: [] };
    d.visitors += visitors;
    d.staff += staff;
    d.entries += visitors + staff;
    d.exits += visitors + staff;
    d.hours.push({ hour: +hour, visitors });
    days.set(date, d);
  }
  return [...days.values()].map((d) => ({ ...d, hours: d.hours.sort((a, b) => a.hour - b.hour) }));
}

// Builds a dataset from item-level, timed sale lines (sample data, or a future
// CuisineIQ API / line-level export).
function fromLines(lines, extra) {
  lines = lines.filter((l) => l.at instanceof Date && !isNaN(l.at)).sort((a, b) => a.at - b.at);
  const byDay = new Map();
  for (const l of lines) {
    const key = dayKey(l.at);
    const d = byDay.get(key) ?? { date: new Date(l.at.getFullYear(), l.at.getMonth(), l.at.getDate()), sales: 0, discount: 0, refund: 0, orderIds: new Set() };
    d.sales += l.net;
    d.discount += l.discount;
    d.refund += l.refund;
    d.orderIds.add(l.orderId);
    byDay.set(key, d);
  }
  const daily = [...byDay.values()].map(({ orderIds, ...d }) => ({ ...d, orders: orderIds.size }));
  return { shopName: null, products: null, catalogue: null, ...extra, asOf: lines[lines.length - 1]?.at, daily, lines };
}

// =====================================================================
// CuisineIQ API (placeholder until their developers share the spec)
// =====================================================================

async function loadFromCuisineIqApi({ baseUrl, apiKey, locationId, days }) {
  if (!baseUrl) throw new Error("Set the CuisineIQ API address in js/config.js first.");
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);
  // ASSUMPTION: endpoint path, query parameters and field names below are guesses.
  // Adjust them to match CuisineIQ's documentation once it arrives.
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/locations/${locationId}/sales/lines`);
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
  const res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  if (!res.ok) throw new Error(`CuisineIQ API error ${res.status}`);
  const body = await res.json();
  const lines = (body.lines ?? body.data ?? body).map((x) => {
    const quantity = Number(x.quantity ?? 1);
    const unitPrice = Number(x.unit_price ?? x.price ?? 0);
    const discount = Math.abs(Number(x.discount ?? 0));
    const refund = Math.abs(Number(x.refund ?? 0));
    return {
      orderId: String(x.order_id ?? x.ticket_id ?? ""),
      at: parseDate(x.datetime ?? x.created_at),
      product: x.product ?? x.item_name ?? "Unknown",
      category: x.category ?? "Other",
      quantity,
      unitPrice,
      gross: quantity * unitPrice,
      discount,
      refund,
      net: quantity * unitPrice - discount - refund,
      paymentType: x.payment_type ?? "Unknown",
    };
  });
  return fromLines(lines, { isSample: false, currency: CONFIG.currency, files: [{ file: url.origin, type: "CuisineIQ API", used: true, note: "" }] });
}

// =====================================================================
// Helpers
// =====================================================================


// Small CSV parser: handles quoted fields, commas and new lines inside quotes.
function parseCsv(text) {
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
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);

  const [header = [], ...body] = rows;
  const keys = header.map((h) => h.trim().replace(/^﻿/, ""));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]])));
}

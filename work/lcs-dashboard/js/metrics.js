// Pure calculations over a dataset (see data-source.js for its shape).
// No data loading or drawing happens here.

export const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7)); // Monday

const pctChange = (now, before) => (before ? (now - before) / before : null);

// Whether the latest day in the data is complete (false while the shop is still trading).
const dayFinished = (ds) => ds.asOf >= addDays(startOfDay(ds.asOf), 1) - 1000;

// Totals for the days in [from, to). Optional figures are null when the source lacks them.
function sumDays(ds, from, to) {
  const days = ds.daily.filter((d) => d.date >= from && d.date < to);
  const total = (key) => (days.length && days.every((d) => d[key] != null) ? days.reduce((a, d) => a + d[key], 0) : null);
  const sales = days.reduce((a, d) => a + d.sales, 0);
  const orders = total("orders");
  let payments = null;
  if (days.length && days.every((d) => d.payments)) {
    payments = {};
    for (const d of days) for (const [k, v] of Object.entries(d.payments)) payments[k] = (payments[k] ?? 0) + v;
  }
  return {
    days: days.length,
    sales,
    discount: total("discount"),
    refund: total("refund"),
    exclVat: total("exclVat"),
    vat: total("vat"),
    orders,
    avgOrder: orders ? sales / orders : null,
    payments,
  };
}

// Timed sale lines in [from, to) – only for item-level sources.
function sumLines(lines, from, to) {
  const orders = new Set();
  let sales = 0;
  for (const l of lines) if (l.at >= from && l.at < to) { sales += l.net; orders.add(l.orderId); }
  return { sales, orders: orders.size, avgOrder: orders.size ? sales / orders.size : null };
}

// The same weekdays as a day to compare it with. Out of the last 6 with figures (newest
// first, as [{ sales, ... }]), a day more than 35% off their median is unusual (a public
// holiday when the shop closed early, or an unusually big event) and left out, so a
// couple of odd weeks can't drag "a usual Monday" down. Returns { kept: the last 4 normal
// ones, leftOut: the unusual ones among the recent weeks }. Also used by the Worker for
// the evening notification (src/summary.js).
export const USUAL_LOOK_BACK = 6;
const USUAL_WEEKS = 4, UNUSUAL_BY = 0.35;
export function pickUsual(candidates) {
  candidates = candidates.slice(0, USUAL_LOOK_BACK);
  if (candidates.length < 3) return { kept: candidates.slice(0, USUAL_WEEKS), leftOut: [] };
  const sorted = candidates.map((c) => c.sales).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const isNormal = (c) => median > 0 && Math.abs(c.sales - median) / median <= UNUSUAL_BY;
  const normal = candidates.filter(isNormal);
  if (normal.length < 2) return { kept: candidates.slice(0, USUAL_WEEKS), leftOut: [] };
  const kept = normal.slice(0, USUAL_WEEKS);
  const oldestKept = candidates.indexOf(kept[kept.length - 1]);
  return { kept, leftOut: candidates.slice(0, oldestKept).filter((c) => !isNormal(c)) };
}

// The same weekdays as `day` to compare it with (see pickUsual), as { days, leftOut } of dates
export function usualDays(ds, day) {
  const candidates = [];
  for (let w = 1; w <= 12 && candidates.length < USUAL_LOOK_BACK; w++) {
    const d = addDays(day, -7 * w);
    const s = sumDays(ds, d, addDays(d, 1));
    if (s.days) candidates.push({ date: d, sales: s.sales });
  }
  const { kept, leftOut } = pickUsual(candidates);
  return { days: kept.map((c) => c.date), leftOut: leftOut.map((c) => c.date) };
}

// Headline cards: today, yesterday, this month – each with a fair comparison.
export function headline(ds) {
  const today = startOfDay(ds.asOf);
  const todayFinished = dayFinished(ds);
  const h = { today, todayFinished, yesterday: addDays(today, -1) };

  // Today is measured against a usual day: the average of the last 4 normal same weekdays
  // (see usualDays: holidays and other unusual days are left out).
  const { days: sameDays, leftOut } = usualDays(ds, today);
  const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  h.typicalWeeks = sameDays.length;
  h.typicalDays = sameDays;
  h.typicalLeftOut = leftOut;
  h.typicalDay = average(sameDays.map((d) => sumDays(ds, d, addDays(d, 1)).sales));

  h.todayNow = sumDays(ds, today, addDays(today, 1));
  if (todayFinished) {
    h.todayCompare = { kind: "change", value: h.typicalDay == null ? null : pctChange(h.todayNow.sales, h.typicalDay) };
    h.typicalByNow = h.typicalDay;
  } else if (ds.lines) {
    // With timed sales we can compare like-for-like: those days up to the same time of day.
    const elapsed = ds.asOf - today + 1;
    const now = sumLines(ds.lines, today, new Date(+today + elapsed));
    const then = average(sameDays.map((d) => sumLines(ds.lines, d, new Date(+d + elapsed)).sales));
    h.todayNow = { ...h.todayNow, ...now };
    h.todayCompare = { kind: "change-same-time", value: then == null ? null : pctChange(now.sales, then) };
    h.typicalByNow = then; // what the same weekdays had taken by this time of day
  } else {
    // Daily totals only: show progress towards a typical full day instead.
    h.todayCompare = { kind: "progress", value: h.typicalDay == null ? null : h.todayNow.sales / (h.typicalDay || 1), of: h.typicalDay };
  }

  h.yesterdayNow = sumDays(ds, h.yesterday, today);
  // Against the same weekday before, skipping unusual ones (a holiday a week ago)
  const ydayUsual = usualDays(ds, h.yesterday);
  h.yesterdayComparedTo = ydayUsual.days[0] ?? null;
  h.yesterdayLeftOut = ydayUsual.leftOut.filter((d) => !h.yesterdayComparedTo || d > h.yesterdayComparedTo);
  const ydayBefore = h.yesterdayComparedTo && sumDays(ds, h.yesterdayComparedTo, addDays(h.yesterdayComparedTo, 1));
  h.yesterdayChange = h.yesterdayNow.days && ydayBefore?.days ? pctChange(h.yesterdayNow.sales, ydayBefore.sales) : null;

  // Month to date, including today so far. The comparison and the projection use complete
  // days only: the 1st up to yesterday (or today once it's finished) against the same days
  // of last month, cut short if last month had fewer days. Both wait for a full week, as
  // a few days are skewed by which weekdays they fall on (a Sunday against a Thursday).
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const doneUntil = todayFinished ? addDays(today, 1) : today;
  const daysDone = Math.round((doneUntil - monthStart) / 86400000);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthDays = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
  h.monthStart = monthStart;
  h.month = sumDays(ds, monthStart, addDays(today, 1));
  h.monthDone = sumDays(ds, monthStart, doneUntil);
  h.monthDaysDone = daysDone;
  h.lastMonthSame = sumDays(ds, lastMonthStart, addDays(lastMonthStart, Math.min(daysDone, lastMonthDays)));
  const lastMonthCovered = daysDone && h.lastMonthSame.days === Math.min(daysDone, lastMonthDays);
  h.monthChange = daysDone >= 7 && h.monthDone.days && lastMonthCovered ? pctChange(h.monthDone.sales, h.lastMonthSame.sales) : null;
  h.monthProjection = daysDone >= 7 && h.monthDone.days ? (h.monthDone.sales / daysDone) * daysInMonth : null;
  // Running total through the month, for the sparkline
  let running = 0;
  h.monthRunning = dailySales(ds, { from: monthStart, to: addDays(today, 1) }).map((p) => (running += p.value));
  return h;
}

// Today hour by hour against a usual day (the same weekdays as the headline's typical
// day): sales with timed sales lines, otherwise visitors from the door counter. `value`
// is null for hours still to come; `line` is the usual day. null without either source.
export function todayByHour(ds) {
  const today = startOfDay(ds.asOf);
  const sameDays = usualDays(ds, today).days;
  const nowHour = dayFinished(ds) ? 24 : ds.asOf.getHours();
  const build = (todayMap, usualMaps, kind) => {
    if (!usualMaps.length && !todayMap.size) return null;
    const hours = [...todayMap.keys(), ...usualMaps.flatMap((m) => [...m.keys()])];
    const out = [];
    for (let h = Math.min(...hours); h <= Math.max(...hours); h++) {
      const usual = usualMaps.length ? usualMaps.reduce((a, m) => a + (m.get(h) ?? 0), 0) / usualMaps.length : null;
      out.push({ hour: h, value: h <= nowHour ? (todayMap.get(h) ?? 0) : 0, future: h > nowHour, partial: h === nowHour && !dayFinished(ds), line: usual });
    }
    return { kind, hours: out, usualDays: usualMaps.length };
  };
  if (ds.lines) {
    const byDay = new Map();
    for (const l of ds.lines) {
      const key = dayKey(l.at);
      if (!byDay.has(key)) byDay.set(key, new Map());
      const m = byDay.get(key);
      m.set(l.at.getHours(), (m.get(l.at.getHours()) ?? 0) + l.net);
    }
    const usual = sameDays.map((d) => byDay.get(dayKey(d))).filter(Boolean);
    return build(byDay.get(dayKey(today)) ?? new Map(), usual, "sales");
  }
  if (ds.footTraffic?.length) {
    const byDay = new Map(ds.footTraffic.map((d) => [dayKey(d.date), new Map(d.hours.map((h) => [h.hour, h.visitors]))]));
    if (!byDay.has(dayKey(today))) return null;
    const usual = sameDays.map((d) => byDay.get(dayKey(d))).filter(Boolean);
    return build(byDay.get(dayKey(today)), usual, "visitors");
  }
  return null;
}

// The same number of days just before a period, for "vs the 30 days before". null when
// the data doesn't reach back that far.
export function previousRange(ds, range) {
  const { from, to } = clip(ds, range);
  const days = dayCount({ from, to });
  const prev = { from: addDays(from, -days), to: from };
  return prev.from >= startOfDay(ds.daily[0].date) ? prev : null;
}

// A period is { from, to }: the days from `from` up to, but not including, `to`.
// Periods are cut short at today, the latest day in the data.
export const dayCount = (range) => Math.round((range.to - range.from) / 86400000);
export const clip = (ds, range) => ({ from: range.from, to: new Date(Math.min(range.to, addDays(startOfDay(ds.asOf), 1))) });
const eachDay = (ds, range, fn) => {
  const { from, to } = clip(ds, range);
  for (let d = from; d < to; d = addDays(d, 1)) fn(d);
};

// The quick picks above the charts. "Today" is the latest day in the data.
export function presetRange(ds, preset) {
  const today = startOfDay(ds.asOf);
  const tomorrow = addDays(today, 1);
  switch (preset) {
    case "today": return { from: today, to: tomorrow };
    case "yesterday": return { from: addDays(today, -1), to: today };
    case "week": return { from: startOfWeek(today), to: tomorrow };
    case "month": return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: tomorrow };
    case "all": return { from: startOfDay(ds.daily[0].date), to: tomorrow };
    default: return lastDays(ds, Number(preset));
  }
}

// The last N days, counting today as day 1.
export const lastDays = (ds, days) => ({ from: addDays(startOfDay(ds.asOf), -(days - 1)), to: addDays(startOfDay(ds.asOf), 1) });

// Every month that has sales, newest first, as periods.
export function monthsWithData(ds) {
  const seen = new Map();
  for (const d of ds.daily) {
    const from = new Date(d.date.getFullYear(), d.date.getMonth(), 1);
    seen.set(+from, { from, to: new Date(from.getFullYear(), from.getMonth() + 1, 1) });
  }
  return [...seen.values()].reverse();
}

export function periodSummary(ds, range) {
  return sumDays(ds, range.from, range.to);
}

export function dailySales(ds, range) {
  const today = startOfDay(ds.asOf);
  const first = startOfDay(ds.daily[0].date);
  const byDay = new Map(ds.daily.map((d) => [dayKey(d.date), d.sales]));
  const out = [];
  eachDay(ds, range, (d) => {
    if (d < first) return; // before the data starts
    out.push({ date: d, value: byDay.get(dayKey(d)) ?? 0, partial: +d === +today && !dayFinished(ds) });
  });
  // 7-day average over complete days, so a half-finished today doesn't drag it down
  out.forEach((p) => {
    const window = [];
    for (let j = 0; window.length < 7; j++) {
      const d = addDays(p.date, -j);
      if (d < first) break;
      if (dayKey(d) !== dayKey(today) || dayFinished(ds)) window.push(byDay.get(dayKey(d)) ?? 0);
    }
    p.avg7 = window.length >= 4 ? window.reduce((a, b) => a + b, 0) / window.length : null;
  });
  return out;
}

// The weeks (Mon–Sun) that overlap the period, and at least `minWeeks` up to its end,
// so a short period still shows how its week compares with the ones before.
export function weeklySales(ds, range, minWeeks = 8) {
  const thisWeek = startOfWeek(ds.asOf);
  const firstData = startOfDay(ds.daily[0].date);
  const { from: rangeFrom, to: rangeTo } = clip(ds, range);
  const lastWeek = startOfWeek(addDays(rangeTo, -1));
  const weeks = Math.max(minWeeks, Math.round((lastWeek - startOfWeek(rangeFrom)) / (7 * 86400000)) + 1);
  const out = [];
  for (let i = weeks; i >= 0; i--) { // one extra week first, for the change on the first one shown
    const from = addDays(lastWeek, -7 * i);
    if (addDays(from, 7) <= firstData) continue;
    const s = sumDays(ds, from, addDays(from, 7));
    out.push({ from, value: s.sales, partial: +from === +thisWeek && !(dayFinished(ds) && ds.asOf.getDay() === 0), incomplete: from < firstData, extra: i === weeks });
  }
  out.forEach((w, i) => { w.change = i && !out[i - 1].incomplete ? pctChange(w.value, out[i - 1].value) : null; });
  return out.filter((w) => !w.incomplete && !w.extra);
}

// Average sales per weekday over the period, from complete days.
export function weekdayAverages(ds, range) {
  const today = dayKey(ds.asOf);
  const sums = Array.from({ length: 7 }, () => ({ total: 0, n: 0 }));
  for (const d of ds.daily) {
    if (d.date < range.from || d.date >= range.to || (dayKey(d.date) === today && !dayFinished(ds))) continue;
    const i = (d.date.getDay() + 6) % 7; // Monday first
    sums[i].total += d.sales;
    sums[i].n++;
  }
  return sums.map((s, i) => ({ weekday: i, value: s.n ? s.total / s.n : 0, days: s.n }));
}

// Product totals for a period. Item-level sources can be sliced to any period;
// CuisineIQ product-sold exports cover the fixed period they were exported for.
// (The online database can do better; see loadProductTotals in data-source.js.)
export function productTotals(ds, range) {
  if (ds.lines) {
    const { from, to } = range;
    const map = new Map();
    for (const l of ds.lines) {
      if (l.at < from || l.at >= to) continue;
      const p = map.get(l.product) ?? { name: l.product, category: l.category, quantity: 0, revenue: 0, price: l.unitPrice };
      if (!l.refund) p.quantity += l.quantity;
      p.revenue += l.net;
      map.set(l.product, p);
    }
    return { from, to: addDays(clip(ds, range).to, -1), fixedPeriod: false, items: [...map.values()], exclude: () => false };
  }
  if (ds.products) {
    return { from: ds.products.from, to: ds.products.to, fixedPeriod: true, items: ds.products.items, exclude: ds.products.excludeFromBestSellers };
  }
  return null;
}

// Every product the data knows, best sellers first, for the product search.
export function productList(ds) {
  const map = new Map();
  const add = (name, category, quantity) => {
    const p = map.get(name) ?? { name, category, quantity: 0 };
    p.quantity += quantity;
    map.set(name, p);
  };
  for (const l of ds.lines ?? []) add(l.product, l.category, l.refund ? 0 : l.quantity);
  for (const p of ds.products?.items ?? []) add(p.name, p.category, p.quantity);
  return [...map.values()].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
}

// Lower case, no accents, and doubled letters as one, since the till's spelling varies
// ("CAPPUCINO" should match "cappuccino")
const searchText = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/([a-z])\1+/g, "$1");

// Products whose name or category contains every word typed (any order, ignoring case,
// accents and doubled letters). Names with a word starting with what was typed come first, then best sellers.
export function searchProducts(list, query, limit = 8) {
  const words = searchText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return list.slice(0, limit);
  const scored = [];
  for (const p of list) {
    const name = searchText(p.name);
    const text = `${name} ${searchText(p.category)}`;
    if (!words.every((w) => text.includes(w))) continue;
    const wordStarts = words.filter((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[^a-z0-9]/g, "\\$&")}`).test(name)).length;
    scored.push({ p, wordStarts });
  }
  return scored.sort((a, b) => b.wordStarts - a.wordStarts).slice(0, limit).map((x) => x.p);
}

// One product's daily figures (`by` quantity or revenue) over the period, from
// data-source.js's loadProductHistory. Days without product figures are marked noData;
// the chart starts at the first day that has them.
export function productDaily(ds, history, range, by = "quantity") {
  const key = by === "revenue" ? "revenue" : "quantity";
  const today = startOfDay(ds.asOf);
  const firstCovered = [...history.covered].sort()[0];
  const out = [];
  eachDay(ds, range, (d) => {
    const k = dayKey(d);
    if (!firstCovered || k < firstCovered) return;
    const covered = history.covered.has(k);
    out.push({ date: d, value: history.byDay.get(k)?.[key] ?? 0, noData: !covered, partial: +d === +today && !dayFinished(ds) });
  });
  // 7-day average over complete days with figures, as for the daily sales
  out.forEach((p) => {
    const window = [];
    for (let j = 0; j < 7; j++) {
      const k = dayKey(addDays(p.date, -j));
      if (!history.covered.has(k) || (k === dayKey(today) && !dayFinished(ds))) continue;
      window.push(history.byDay.get(k)?.[key] ?? 0);
    }
    p.avg7 = window.length >= 4 ? window.reduce((a, b) => a + b, 0) / window.length : null;
  });
  return out;
}

export function topProducts(totals, by = "quantity", limit = 8) {
  const key = by === "revenue" ? "revenue" : "quantity";
  return totals.items.filter((p) => !totals.exclude(p.category)).sort((a, b) => b[key] - a[key]).slice(0, limit);
}

// The products that sold least (but did sell), fewest first.
export function slowProducts(totals, by = "quantity", limit = 10) {
  const [key, then] = by === "revenue" ? ["revenue", "quantity"] : ["quantity", "revenue"];
  return totals.items.filter((p) => !totals.exclude(p.category) && p.quantity > 0)
    .sort((a, b) => a[key] - b[key] || a[then] - b[then]).slice(0, limit);
}

// Products in `known` (sold some other time, or on the till's product list) that
// didn't sell at all in these totals, by category then name.
export function unsoldProducts(totals, known) {
  const sold = new Set(totals.items.filter((p) => p.quantity > 0).map((p) => p.name.toLowerCase()));
  const out = new Map();
  for (const p of known) {
    const key = p.name.toLowerCase();
    if (sold.has(key) || out.has(key) || totals.exclude(p.category)) continue;
    out.set(key, { name: p.name, category: p.category, price: p.price });
  }
  return [...out.values()].sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name));
}

// Sales per category; anything past `limit` is folded into "Everything else".
export function salesByCategory(totals, limit = 12) {
  const map = new Map();
  let total = 0;
  for (const p of totals.items) {
    map.set(p.category, (map.get(p.category) ?? 0) + p.revenue);
    total += p.revenue;
  }
  const all = [...map.entries()].map(([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue - a.revenue);
  const shown = all.length > limit + 1 ? all.slice(0, limit) : all;
  if (shown.length < all.length) {
    const rest = all.slice(limit);
    shown.push({ name: `Everything else (${rest.length} categories)`, revenue: rest.reduce((a, c) => a + c.revenue, 0) });
  }
  return shown.map((c) => ({ ...c, share: total ? c.revenue / total : 0 }));
}

// Average number of orders in each hour of the day, for weekdays or weekends.
export function busyHours(ds, range, kind = "weekday") {
  const wantWeekend = kind === "weekend";
  const { from, to } = range;
  const today = dayKey(ds.asOf);
  const ordersByHour = new Map();
  const seenDays = new Set();
  for (const l of ds.lines) {
    if (l.at < from || l.at >= to) continue;
    const weekend = l.at.getDay() === 0 || l.at.getDay() === 6;
    if (weekend !== wantWeekend || dayKey(l.at) === today) continue; // skip half-finished today
    seenDays.add(dayKey(l.at));
    const h = l.at.getHours();
    if (!ordersByHour.has(h)) ordersByHour.set(h, new Set());
    ordersByHour.get(h).add(l.orderId);
  }
  if (!ordersByHour.size) return [];
  const hours = [...ordersByHour.keys()];
  const out = [];
  for (let h = Math.min(...hours); h <= Math.max(...hours); h++) {
    out.push({ hour: h, value: (ordersByHour.get(h)?.size ?? 0) / seenDays.size });
  }
  return out;
}

// Sales by payment type: from item-level sales, or from daily payment totals.
// Returns null if the period has no payment details.
export function paymentMix(ds, range) {
  const { from, to } = range;
  const map = new Map();
  let total = 0;
  if (ds.lines) {
    for (const l of ds.lines) {
      if (l.at < from || l.at >= to) continue;
      map.set(l.paymentType, (map.get(l.paymentType) ?? 0) + l.net);
      total += l.net;
    }
  } else {
    const { payments } = periodSummary(ds, range);
    if (!payments) return null;
    for (const [k, v] of Object.entries(payments)) { map.set(k, v); total += v; }
  }
  return [...map.entries()]
    .map(([name, revenue]) => ({ name, revenue, share: total ? revenue / total : 0 }))
    .sort((a, b) => b.revenue - a.revenue);
}

// Visitors from the door counter (people coming in, staff left out) for the days in
// [from, to), and conversion: tickets (orders) ÷ visitors, over the days that have both.
// null when none of those days has counts.
export function visitorSummary(ds, range) {
  const days = (ds.footTraffic ?? []).filter((d) => d.date >= range.from && d.date < range.to);
  if (!days.length) return null;
  const tickets = new Map(ds.daily.map((d) => [dayKey(d.date), d.transactions ?? d.orders]));
  let bought = 0, counted = 0;
  for (const d of days) {
    const n = tickets.get(dayKey(d.date));
    if (n == null || !d.visitors) continue;
    bought += n;
    counted += d.visitors;
  }
  return {
    days: days.length,
    visitors: days.reduce((a, d) => a + d.visitors, 0),
    conversion: counted ? bought / counted : null,
  };
}

// Visitors in each hour of the day: a single day's counts, or the average over the days
// in the period that have counts (leaving out a half-finished today). With timed sales,
// `line` is the orders in the same hours, averaged the same way.
export function visitorsByHour(ds, range) {
  const { from, to } = clip(ds, range);
  let days = (ds.footTraffic ?? []).filter((d) => d.date >= from && d.date < to);
  const today = dayKey(ds.asOf);
  if (days.length > 1 && !dayFinished(ds)) days = days.filter((d) => dayKey(d.date) !== today);
  if (!days.length) return { days: 0, hours: [] };
  const visitors = new Map();
  for (const d of days) for (const h of d.hours) visitors.set(h.hour, (visitors.get(h.hour) ?? 0) + h.visitors);
  let orders = null;
  if (ds.lines) {
    const keys = new Set(days.map((d) => dayKey(d.date)));
    const byHour = new Map();
    for (const l of ds.lines) {
      if (l.at < from || l.at >= to || !keys.has(dayKey(l.at))) continue;
      const h = l.at.getHours();
      if (!byHour.has(h)) byHour.set(h, new Set());
      byHour.get(h).add(l.orderId);
    }
    orders = new Map([...byHour].map(([h, ids]) => [h, ids.size]));
  }
  const hours = [...visitors.keys(), ...(orders?.keys() ?? [])];
  const out = [];
  for (let h = Math.min(...hours); h <= Math.max(...hours); h++) {
    out.push({ hour: h, value: (visitors.get(h) ?? 0) / days.length, ...(orders && { line: (orders.get(h) ?? 0) / days.length }) });
  }
  return { days: days.length, hours: out };
}

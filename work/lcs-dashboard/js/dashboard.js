// Draws the dashboard. Gets its data from data-source.js and its numbers from metrics.js.

import { CONFIG } from "./config.js";
import { loadDataset, loadProductHistory, loadProductTotals } from "./data-source.js";
import * as M from "./metrics.js";
import { buildReconWorkbook } from "./recon.js";
import { columnChart, lineChart, barList, donut, sparkline, progressRing, countUp } from "./charts.js";

const $ = (id) => document.getElementById(id);

let money, moneyCents, moneyShort, currencySymbol;
const setCurrency = (currency) => {
  const base = { style: "currency", currency, currencyDisplay: "narrowSymbol" };
  money = new Intl.NumberFormat(CONFIG.locale, { ...base, maximumFractionDigits: 0 });
  // "Rs", shown small beside the big headline numbers
  currencySymbol = money.formatToParts(0).find((p) => p.type === "currency")?.value ?? "";
  moneyCents = new Intl.NumberFormat(CONFIG.locale, { ...base, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  moneyShort = new Intl.NumberFormat(CONFIG.locale, { ...base, notation: "compact", maximumFractionDigits: 1 });
};
const whole = new Intl.NumberFormat(CONFIG.locale);
const oneDecimal = new Intl.NumberFormat(CONFIG.locale, { maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat(CONFIG.locale, { style: "percent", maximumFractionDigits: 0 });
const fmtDate = (d, opts) => d.toLocaleDateString(CONFIG.locale, opts);
const weekday = (d) => fmtDate(d, { weekday: "long" });
const shortDate = (d) => fmtDate(d, { day: "numeric", month: "short" });
const longDate = (d) => fmtDate(d, { day: "numeric", month: "short", year: "numeric" });
const timeText = (d) => d.toLocaleTimeString(CONFIG.locale, { hour: "numeric", minute: "2-digit" });
const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(CONFIG.locale, { hour: "2-digit", minute: "2-digit" });
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS_LONG = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

// `animate` is true when charts should play their entrance animation (first load and
// when the data shown changes) and false for plain re-draws such as after a resize.
const state = { ds: null, range: null, preset: "30", productTotals: null, bestBy: "quantity", slowBy: "quantity", unsoldKnown: null, hoursKind: "weekday", animate: true, products: [], productBy: "quantity", productView: "combined" };
const productHistories = new Map(); // product name → loadProductHistory result
const productTotalsCache = new Map(); // "from|to" → loadProductTotals result

init();

async function init() {
  try {
    state.ds = await loadDataset();
    if (!state.ds.daily.length) throw new Error("No sales found in the data.");
  } catch (err) {
    document.body.classList.remove("sk-on");
    $("updated").textContent = "";
    $("error").hidden = false;
    $("error").textContent =
      location.protocol === "file:"
        ? "This page needs to be opened through the local server – see README.md (“How to open it”)."
        : `Couldn't load the sales data: ${err.message}`;
    return;
  }
  const ds = state.ds;
  setCurrency(ds.currency);

  const shopName = CONFIG.shopName ?? titleCase(ds.shopName);
  $("shop-name").textContent = shopName ?? "Sales Dashboard";
  document.title = shopName ? `${shopName} · Sales` : "Sales Dashboard";
  $("source-badge").hidden = !ds.isSample;
  $("cloud-links").hidden = $("upload-link").hidden = $("signout").hidden = ds.source !== "cloud";
  if (ds.source === "cloud") { setupSync(ds.lastSync); setupAsk(); setupNotify(); setupRecon(); showDaySummary(); }
  renderStatus();
  if (ds.fallbackReason) {
    $("notice").hidden = false;
    $("notice").textContent = `Showing made-up sample figures. ${ds.fallbackReason}`;
  }

  // Show only what this data can support
  const hasLines = Boolean(ds.lines);
  $("hours-card").hidden = !hasLines;
  $("payments-card").hidden = !hasLines && !ds.daily.some((d) => d.payments);
  $("best-card").hidden = $("slow-card").hidden = $("category-card").hidden = !hasLines && !ds.products;
  renderMissing();
  renderFiles();
  setupProductSearch();

  setupPeriod();
  setupTabs();
  setupToggle("best-by", "by", (v) => { state.bestBy = v; state.animate = true; renderBestSellers(); state.animate = false; });
  setupToggle("slow-by", "by", (v) => { state.slowBy = v; state.animate = true; renderSlowSellers(); state.animate = false; });
  $("unsold-more").addEventListener("click", () => { state.unsoldAll = true; renderSlowSellers(); });
  setupToggle("hours-kind", "kind", (v) => { state.hoursKind = v; state.animate = true; renderBusyHours(); state.animate = false; });

  renderHeadline();
  renderTodayBest();
  const firstPaint = renderPeriod();
  document.body.classList.remove("sk-on"); // the placeholders give way to the figures
  await firstPaint;

  let resizeTimer;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return; // ignore mobile address-bar height changes
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Charts on other tabs are redrawn when they're next shown, at their new width
      drawn.clear();
      drawTab(currentTab, false);
    }, 150);
  });
}

// "Fetch latest": the Worker downloads today's reports from CuisineIQ, then the page reloads
function setupSync(last) {
  const time = (iso) => new Date(iso).toLocaleTimeString(CONFIG.locale, { hour: "numeric", minute: "2-digit" });
  if (last) {
    $("sync").title = `Fetch latest. Last fetched from CuisineIQ ${shortDate(new Date(last.at))}, ${time(last.at)}${last.ok ? "" : " (failed)"}`;
    setInterval(() => {
      showUpdated();
      renderStatus();
      const h = state.headline;
      if (h) setTodayTitle(h);
      if (h && M.dayKey(h.today) === M.dayKey(new Date()) && shopClosed(h.today)) showDaySummary(); // the recap appears at closing time
    }, 60_000);
    if (!last.ok) {
      $("notice").hidden = false;
      $("notice").textContent = `The last fetch from CuisineIQ (${time(last.at)}) failed: ${last.error}`;
    }
  }
  $("sync").addEventListener("click", async () => {
    $("sync").disabled = true;
    try {
      const res = await fetch("api/sync", { method: "POST" });
      if (res.status === 401) throw new Error("Your session has expired. Reload the page and enter the PIN again.");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Fetching failed (error ${res.status}).`);
      location.reload();
    } catch (err) {
      $("notice").hidden = false;
      $("notice").textContent = err.message;
      $("sync").disabled = false;
    }
  });
}

// Ask Claude: the sparkle at the top (or the button in the headline card) drops a
// search-style box in at the top, with example and recent questions under it. The answer
// comes back as one card: the text, up to three key figures as tiles, and follow-up
// questions to tap. Follow-ups carry on the same conversation until the box is closed.
const ASK_SUGGESTIONS = [
  ["chart", "How does this week compare to last week?"],
  ["bag", "What were our best sellers this week?"],
  ["clock", "Which day of the week is usually busiest?"],
  ["cal", "How are pastry sales doing this month?"],
];
const ICONS = {
  chart: "M4 20V10M10 20V4M16 20v-8M22 20H2",
  bag: "M6 7h12l1 13H5zM9 7a3 3 0 0 1 6 0",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  cal: "M4 5h16v16H4zM4 9h16M8 3v4M16 3v4",
  recent: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  copy: "M8 8h12v12H8zM16 8V4H4v12h4",
  check: "M5 12l5 5L20 7",
};
const RECENT_KEY = "askRecent";

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.appendChild(path);
  return svg;
}
const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text != null ? { textContent: text } : {});

// The answer's text, with **bold** turned into bold (and nothing else let through)
function richText(target, text) {
  target.replaceChildren(...text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) =>
    /^\*\*[^*]+\*\*$/.test(part) ? el("b", null, part.slice(2, -2)) : document.createTextNode(part)));
}
const plainText = (text) => text.replace(/\*\*([^*]+)\*\*/g, "$1");

function setupAsk() {
  const dialog = $("ask");
  const input = $("ask-input");
  let history = [];
  let asking = false;
  let opener = null;

  const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) ?? []; } catch { return []; } };
  const remember = (q) => {
    const list = [q, ...recent().filter((r) => r !== q)].slice(0, 5);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* private browsing */ }
  };
  const item = (iconName, text, className = "") => {
    const b = el("button", `ask-item ${className}`.trim());
    b.type = "button";
    const ic = el("span", "ask-ic");
    ic.appendChild(icon(iconName));
    b.append(ic, el("span", null, text));
    b.addEventListener("click", () => ask(text));
    return b;
  };
  const showIdeas = () => {
    $("ask-suggestions").replaceChildren(...ASK_SUGGESTIONS.slice(0, 3).map(([ic, q]) => item(ic, q)));
    const asked = recent().filter((q) => !ASK_SUGGESTIONS.some(([, s]) => s === q)).slice(0, 2);
    $("ask-recent-lab").hidden = !asked.length;
    $("ask-recent").replaceChildren(...asked.map((q) => item("recent", q, "recent")));
    $("ask-ideas").hidden = false;
  };
  const syncClear = () => { $("ask-clear").hidden = !input.value; };

  const open = (e) => {
    opener = e?.currentTarget ?? null;
    dialog.hidden = false;
    document.documentElement.classList.add("ask-open");
    if (!history.length) showIdeas();
    input.focus();
  };
  const close = () => {
    dialog.hidden = true;
    document.documentElement.classList.remove("ask-open");
    history = [];
    input.value = "";
    input.placeholder = "Ask about sales…";
    syncClear();
    $("ask-thread").replaceChildren();
    $("ask-related").hidden = true;
    opener?.focus();
  };

  const answerCard = (question) => {
    const card = el("div", "ask-card thinking");
    card.setAttribute("aria-live", "polite");
    const who = el("p", "ask-who");
    who.append(icon("spark"), document.createTextNode("Answer"));
    const text = el("p", "ask-text", "Looking at the figures…");
    card.append(el("p", "ask-q", question), who, text);
    return { card, text };
  };

  const ask = async (question) => {
    question = question.trim();
    if (asking || !question) return;
    asking = true;
    remember(question);
    input.value = question;
    syncClear();
    input.blur(); // put the phone keyboard away to read the answer
    $("ask-send").disabled = true;
    $("ask-ideas").hidden = true;
    $("ask-related").hidden = true;
    const { card, text } = answerCard(question);
    $("ask-thread").replaceChildren(card);
    try {
      const res = await fetch("api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, history }) });
      if (res.status === 401) throw new Error("Your session has expired. Reload the page and enter the PIN again.");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Asking failed (error ${res.status}).`);
      history = [...history, { question, answer: body.answer }].slice(-3);
      richText(text, body.answer);

      if (body.figures?.length) {
        const tiles = el("div", "ask-tiles");
        tiles.append(...body.figures.map((f) => {
          const tile = el("div");
          tile.append(el("strong", null, f.value), document.createTextNode(f.label));
          return tile;
        }));
        card.appendChild(tiles);
      }
      const actions = el("div", "ask-actions");
      const follow = el("button", "ask-follow", "Ask a follow-up");
      follow.type = "button";
      follow.addEventListener("click", () => { input.value = ""; syncClear(); input.focus(); });
      const copy = el("button", "ask-copy");
      copy.type = "button";
      copy.setAttribute("aria-label", "Copy the answer");
      copy.appendChild(icon("copy"));
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(plainText(body.answer));
          copy.replaceChildren(icon("check"));
          copy.setAttribute("aria-label", "Copied");
          setTimeout(() => { copy.replaceChildren(icon("copy")); copy.setAttribute("aria-label", "Copy the answer"); }, 1600);
        } catch { /* clipboard not allowed: nothing to do */ }
      });
      actions.append(follow, copy);
      card.append(actions, el("p", "ask-foot", "Written by Claude from the shop's figures. Worth a double-check before acting on it."));

      const related = $("ask-related");
      related.replaceChildren(...(body.followUps ?? []).map((q) => {
        const b = el("button", null, q);
        b.type = "button";
        b.addEventListener("click", () => ask(q));
        return b;
      }));
      related.hidden = !body.followUps?.length;
      input.value = "";
      input.placeholder = "Ask a follow-up…";
      syncClear();
    } catch (err) {
      text.textContent = err.message;
    } finally {
      card.classList.remove("thinking");
      $("ask-send").disabled = false;
      asking = false;
    }
  };

  $("ask-open").addEventListener("click", open);
  $("today-ask").addEventListener("click", open);
  $("ask-close").addEventListener("click", close);
  $("ask-dim").addEventListener("click", close);
  // A tap on the blurred page around the box closes it
  dialog.querySelector(".ask-spot").addEventListener("click", (e) => { if (e.target === e.currentTarget) close(); });
  dialog.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  input.addEventListener("input", syncClear);
  $("ask-clear").addEventListener("click", () => { input.value = ""; syncClear(); input.focus(); });
  $("ask-form").addEventListener("submit", (e) => { e.preventDefault(); ask(input.value); });
  $("hl-foot").hidden = false;
}

// After the evening notification has gone: a recap written by Claude at the top of the
// page, or the notification's own words until (or if) there isn't one
// From closing time ("Today's result"): the server may fetch the day's figures once more
// first, and then the page's figures are brought up to date too
let daySummaryShown = false;
async function showDaySummary() {
  if (daySummaryShown) return;
  // From closing time a recap is on its way: show Claude writing while it comes
  const today = M.startOfDay(state.ds.asOf);
  const expecting = M.dayKey(today) === M.dayKey(new Date()) && shopClosed(today);
  if (expecting) aiWriting(true);
  const { summary } = await fetch("api/day-summary").then((r) => r.json()).catch(() => ({}));
  if (daySummaryShown) return;
  if (!summary) { aiWriting(false); return; }
  daySummaryShown = true;
  if (summary.refreshed) await reloadFigures();
  const show = (ai) => {
    aiWriting(false);
    $("day-summary-cheer").hidden = Boolean(ai) || !summary.cheer;
    $("day-summary-cheer").textContent = summary.cheer ?? "";
    revealText($("day-summary-text"), ai ?? summary.lines.join(" "));
    $("day-summary-by-text").textContent = ai ? "Recap by Claude" : "How the day went";
  };
  // Up or down on the same weekday before (skipping unusual ones)
  const trend = $("day-summary-trend");
  trend.hidden = summary.change == null;
  if (summary.change != null) {
    const dir = summary.change > 0 ? "up" : summary.change < 0 ? "down" : "";
    trend.className = `hl-chip day-summary-trend ${dir}`;
    trend.textContent = `${{ up: "▲", down: "▼" }[dir] ?? "="} ${Math.abs(summary.change)}% on ${summary.comparedTo ?? `last ${summary.weekday}`}`;
  }
  $("day-summary-alerts").hidden = !summary.alerts.length;
  $("day-summary-alerts").replaceChildren(...summary.alerts.map((a) => Object.assign(document.createElement("li"), { textContent: a })));
  $("day-summary").hidden = false;
  $("hl-foot").hidden = false;
  $("today-ask").textContent = "Ask a follow-up";
  if (summary.ai || !summary.aiPending) { show(summary.ai); return; }
  // Claude is still writing it: keep the animation going until it arrives
  aiWriting(true);
  const { ai } = await fetch("api/day-summary/ai", { method: "POST" }).then((r) => r.json()).catch(() => ({}));
  show(ai ?? null);
}

// The recap being written: a glowing sparkle and shimmering lines where the text will go
function aiWriting(on) {
  $("ai-writing").hidden = !on;
  $("day-summary-text").hidden = on;
  if (on) {
    $("day-summary").hidden = false;
    $("day-summary-cheer").hidden = true;
  }
}

// The recap's words drift in one after another
function revealText(target, text) {
  let i = 0;
  target.replaceChildren(...text.split(/(\s+)/).map((part) => {
    if (!part.trim()) return document.createTextNode(part);
    const word = el("span", "word", part);
    word.style.setProperty("--i", Math.min(i++, 60));
    return word;
  }));
}

// Loads the figures again (after a fetch the page didn't start) and redraws everything
async function reloadFigures() {
  try {
    const ds = await loadDataset();
    if (!ds.daily.length) return;
    state.ds = ds;
  } catch {
    return; // keep showing what's there
  }
  productTotalsCache.clear();
  productHistories.clear();
  state.range = state.preset === "custom" ? state.range : M.presetRange(state.ds, state.preset);
  drawn.clear();
  renderHeadline();
  renderTodayBest();
  renderStatus();
  await renderPeriod();
}

// The monthly cash summary workbook: pick a month, it downloads (see recon.js). Last
// month's finished workbook, if given, supplies "Outstanding prv month".
function setupRecon() {
  const form = $("recon"), input = $("recon-month"), button = $("recon-download");
  if (!form.hidden) return;
  form.hidden = false;
  $("recon-card").hidden = false;
  const now = new Date();
  const month = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  input.max = month(now);
  input.value ||= month(new Date(now.getFullYear(), now.getMonth() - 1, 1)); // last month
  const status = (text) => { $("recon-status").textContent = text; $("recon-status").hidden = !text; };
  const previous = $("recon-previous");
  previous.addEventListener("change", () => {
    $("recon-previous-name").textContent = previous.files[0]?.name ?? "Add last month's workbook (optional)";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    button.disabled = true;
    try {
      const { blob, fileName, note } = await buildReconWorkbook(input.value, status, { previous: previous.files[0] });
      const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: fileName });
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      status(note ?? "");
    } catch (err) {
      status(err.message);
    } finally {
      button.disabled = false;
    }
  });
}

// The bell at the bottom of the page: turns the evening sales notification on or off for
// this device, and "Send a test" sends today's so far. Phones only allow it once the
// dashboard is installed (on iPhone, "Add to Home Screen" first). While it's off, a bubble
// at the top offers to turn it on; "×" hides that for a week.
const NUDGE_SNOOZE_KEY = "notifyNudgeSnoozedUntil";
const NUDGE_SNOOZE_MS = 7 * 86400000;

async function setupNotify() {
  const button = $("notify");
  const status = (text) => { $("notify-status").textContent = text; $("notify-status").hidden = !text; };
  if (!("PushManager" in window) || !("serviceWorker" in navigator)) return;
  const { key } = await fetch("api/push").then((r) => r.json()).catch(() => ({}));
  if (!key) return;
  const reg = await navigator.serviceWorker.ready;
  const blocked = "Notifications are blocked for this site. Allow them in the browser or phone settings, then tap the button again.";
  const show = (on) => {
    button.setAttribute("aria-pressed", String(on));
    $("notify-label").textContent = on ? "Evening sales notification is on" : "Get the day's sales each evening";
    $("notify-test").hidden = !on;
    const snoozed = Date.now() < Number(localStorage.getItem(NUDGE_SNOOZE_KEY) ?? 0);
    $("notify-nudge").hidden = on || snoozed;
    if (!on && Notification.permission === "denied") {
      $("notify-nudge-text").textContent = "Notifications are blocked for this site. Allow them in the browser or phone settings to get the day's sales each evening.";
      $("notify-nudge-on").hidden = true;
    }
  };
  show(Boolean(await reg.pushManager.getSubscription()) && Notification.permission === "granted");
  $("notify-card").hidden = false;

  const turnOn = async () => {
    if (await Notification.requestPermission() !== "granted") throw new Error(blocked);
    const sub = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const res = await fetch("api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Turning on notifications failed (error ${res.status}).`);
    show(true);
  };

  button.addEventListener("click", async () => {
    button.disabled = true;
    status("");
    try {
      const existing = await reg.pushManager.getSubscription();
      if (button.getAttribute("aria-pressed") === "true" && existing) {
        await fetch("api/push", { method: "DELETE", body: JSON.stringify({ endpoint: existing.endpoint }) });
        await existing.unsubscribe();
        show(false);
        return;
      }
      await turnOn();
    } catch (err) {
      status(err.message);
    } finally {
      button.disabled = false;
    }
  });

  $("notify-nudge-on").addEventListener("click", async () => {
    $("notify-nudge-on").disabled = true;
    try {
      await turnOn();
    } catch (err) {
      $("notify-nudge-text").textContent = err.message;
      if (Notification.permission === "denied") $("notify-nudge-on").hidden = true;
    } finally {
      $("notify-nudge-on").disabled = false;
    }
  });
  $("notify-nudge-close").addEventListener("click", () => {
    localStorage.setItem(NUDGE_SNOOZE_KEY, String(Date.now() + NUDGE_SNOOZE_MS));
    $("notify-nudge").hidden = true;
  });

  $("notify-test").addEventListener("click", async () => {
    $("notify-test").disabled = true;
    status("Sending…");
    try {
      const sub = await reg.pushManager.getSubscription();
      const res = await fetch("api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub?.endpoint }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Sending the test failed (error ${res.status}).`);
      status("Sent. It should arrive in a few seconds.");
    } catch (err) {
      status(err.message);
    } finally {
      $("notify-test").disabled = false;
    }
  });
}

// "just now", "5 mins ago", "3 hrs ago", "yesterday", "4 days ago"
function timeAgo(date) {
  const mins = Math.floor((Date.now() - date) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function titleCase(name) {
  if (!name) return null;
  return name.replace(/\b(LTD|LIMITED|LTEE|SARL|CO)\b\.?/gi, "").trim().toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function setupToggle(groupId, attr, onChange) {
  const group = $(groupId);
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    onChange(btn.dataset[attr]);
  });
}

// One period for Sales, Products and Busy: five quick picks in the bar, and more (plus any
// days from–to, or a whole month) under the calendar button at its end
const EXTRA_PRESETS = ["yesterday", "7", "all", "custom"];
const PRESET_LABELS = { today: "Today", yesterday: "Yesterday", week: "This week", month: "This month", 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days", all: "All time" };

function setupPeriod() {
  const ds = state.ds;
  const first = M.dayKey(ds.daily[0].date);
  const last = M.dayKey(ds.asOf);
  for (const input of [$("range-from"), $("range-to")]) Object.assign(input, { min: first, max: last });
  $("range-month").append(...M.monthsWithData(ds).map((m) =>
    Object.assign(document.createElement("option"), { value: M.dayKey(m.from), textContent: fmtDate(m.from, { month: "long", year: "numeric" }) })));

  const presetButtons = [...document.querySelectorAll("#period [data-preset], #period-extra [data-preset]")];
  const press = (preset) => {
    for (const b of presetButtons) b.setAttribute("aria-pressed", String(b.dataset.preset === preset));
    $("period-more").setAttribute("aria-pressed", String(EXTRA_PRESETS.includes(preset)));
  };
  const openMore = (open) => {
    $("custom-range").hidden = !open;
    $("period-more").setAttribute("aria-expanded", String(open));
    $("range-fields").hidden = state.preset !== "custom";
  };

  const show = (range) => { state.range = range; state.animate = true; savePeriod(); renderPeriod(); };
  const matchMonth = (range) => {
    const month = M.monthsWithData(ds).find((m) => +m.from === +range.from && +M.clip(ds, m).to === +M.clip(ds, range).to);
    $("range-month").value = month ? M.dayKey(month.from) : "";
  };
  const fromInputs = () => {
    const from = parseDay($("range-from").value);
    const to = parseDay($("range-to").value);
    if (!from || !to) return;
    // Either way round; a date typed in backwards still means the days between
    const [a, b] = from <= to ? [from, to] : [to, from];
    const range = { from: a, to: M.addDays(b, 1) };
    matchMonth(range);
    show(range);
  };
  const setInputs = (range) => {
    $("range-from").value = M.dayKey(range.from);
    $("range-to").value = M.dayKey(M.addDays(M.clip(ds, range).to, -1));
  };

  const choose = (e) => {
    const btn = e.target.closest("button[data-preset]");
    if (!btn) return;
    const v = btn.dataset.preset;
    state.preset = v;
    press(v);
    if (v === "custom") {
      setInputs(state.range);
      $("range-month").value = "";
      $("range-fields").hidden = false;
      savePeriod();
      renderPeriodLabel();
      return; // same days until a date is changed
    }
    openMore(false);
    show(M.presetRange(ds, v));
  };
  $("period").addEventListener("click", choose);
  $("period-extra").addEventListener("click", choose);
  $("period-more").addEventListener("click", () => openMore($("custom-range").hidden));
  $("range-from").addEventListener("change", fromInputs);
  $("range-to").addEventListener("change", fromInputs);
  $("range-month").addEventListener("change", (e) => {
    const month = M.monthsWithData(ds).find((m) => M.dayKey(m.from) === e.target.value);
    if (!month) return;
    setInputs(month);
    show(month);
  });

  // Open on the period picked last time on this device. Quick picks move on with the
  // calendar ("This week" is always this week); custom days stay as they were.
  const saved = loadPeriod();
  if (saved && presetButtons.some((b) => b.dataset.preset === saved.preset)) state.preset = saved.preset;
  press(state.preset);
  if (state.preset === "custom") {
    state.range = { from: saved.from, to: M.addDays(saved.to, 1) };
    setInputs(state.range);
    matchMonth(state.range);
  } else {
    state.range = M.presetRange(ds, state.preset);
  }

  // The bar turns into dark frosted glass once it's stuck to the top of the screen
  new IntersectionObserver(([entry]) => {
    $("period-wrap").classList.toggle("stuck", !entry.isIntersecting && entry.boundingClientRect.top < 0);
  }).observe($("period-sentinel"));
}

// "17 Oct – 16 Nov 2026" on the left under the bar, "Last 30 days" on the right
function renderPeriodLabel() {
  const days = M.dayCount(M.clip(state.ds, state.range));
  $("period-label").textContent = rangeText(state.range);
  $("period-days").textContent = PRESET_LABELS[state.preset] ?? `${whole.format(days)} day${days === 1 ? "" : "s"}`;
}

// ---------- Tabs ----------
// Today, Sales, Products, Busy and Tools, switched from the bar at the bottom. The tab is
// in the address (#sales), so the back button and reloading keep it.
const TABS = {
  today: { title: "Today", sub: "" },
  sales: { title: "Sales", sub: "Totals, trends and payments" },
  products: { title: "Products", sub: "What's selling and what isn't" },
  busy: { title: "Busy times", sub: "When customers come in" },
  tools: { title: "Shop tools", sub: "Shop PC, reports, uploads and settings" },
};
let currentTab = "today";
// Charts measure their box when drawn, and a hidden tab has none: each tab's charts are
// drawn when it's shown, and again after the period changes
const drawn = new Set();

function setupTabs() {
  const fromAddress = () => (TABS[location.hash.slice(1)] ? location.hash.slice(1) : "today");
  document.querySelectorAll(".tabbar .tab").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const tab = a.dataset.tab;
    if (tab === currentTab) { window.scrollTo({ top: 0, behavior: smoothScroll() }); return; }
    goToTab(tab);
  }));
  window.addEventListener("popstate", () => showTab(fromAddress()));
  $("today-best-more").addEventListener("click", () => goToTab("products"));
  showTab(fromAddress(), { draw: false });
}

function goToTab(tab) {
  if (location.hash !== `#${tab}`) history.pushState(null, "", tab === "today" ? location.pathname + location.search : `#${tab}`);
  showTab(tab);
}

function showTab(tab, { draw = true } = {}) {
  currentTab = tab;
  document.body.dataset.tab = tab;
  document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  document.querySelectorAll(".tabbar .tab").forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("tab-title").textContent = TABS[tab].title;
  $("tab-sub").textContent = TABS[tab].sub;
  window.scrollTo(0, 0);
  if (draw && !drawn.has(tab)) drawTab(tab, true);
}

function drawTab(tab, animate) {
  if (!state.range) return;
  state.animate = animate;
  const charts = {
    today: [renderTodayHours],
    sales: [renderDaily, renderWeekly, renderPayments],
    products: [renderProduct],
    busy: [renderWeekdays, renderBusyHours, renderVisitors],
  }[tab] ?? [];
  for (const draw of charts) draw();
  state.animate = false;
  drawn.add(tab);
}

const smoothScroll = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

// Saved as { preset } or { preset: "custom", from, to } with the first and last days
const PERIOD_KEY = "period";
function savePeriod() {
  const last = M.addDays(state.range.to, -1);
  const saved = state.preset === "custom" ? { preset: "custom", from: M.dayKey(state.range.from), to: M.dayKey(last) } : { preset: state.preset };
  try { localStorage.setItem(PERIOD_KEY, JSON.stringify(saved)); } catch { /* private browsing: just don't remember */ }
}
function loadPeriod() {
  try {
    const saved = JSON.parse(localStorage.getItem(PERIOD_KEY));
    if (saved?.preset !== "custom") return saved?.preset ? { preset: String(saved.preset) } : null;
    const from = parseDay(saved.from);
    const to = parseDay(saved.to);
    return from && to && from <= to ? { preset: "custom", from, to } : null;
  } catch {
    return null;
  }
}

const parseDay = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};

// "Mon 2 Nov", "1 – 31 Aug 2026", "28 Sep – 2 Nov 2026"
function rangeText(range) {
  const from = range.from;
  const last = M.addDays(M.clip(state.ds, range).to, -1);
  if (+from === +last) return fmtDate(from, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const sameYear = from.getFullYear() === last.getFullYear();
  const sameMonth = sameYear && from.getMonth() === last.getMonth();
  const start = fmtDate(from, sameMonth ? { day: "numeric" } : sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  return `${start} – ${longDate(last)}`;
}

function ordersText(s) {
  return s.orders != null ? `${whole.format(s.orders)} orders · avg ${moneyCents.format(s.avgOrder)}` : null;
}

// "212 visitors · 38% conversion" under a headline number, from the door counter. Hidden
// for a day without counts.
function showVisitors(el, range, soFar = false) {
  const v = M.visitorSummary(state.ds, range);
  el.hidden = !v;
  if (!v) return;
  el.textContent = [
    `~${whole.format(v.visitors)} visitor${v.visitors === 1 ? "" : "s"}${soFar ? " so far" : ""}`,
    v.conversion != null ? `${pct.format(v.conversion)} conversion` : null,
  ].filter(Boolean).join(" · ");
  el.title = v.conversion != null ? `Conversion: ${state.ds.lines ? "orders" : "tickets"} ÷ visitors` : "";
}

// "Last updated 5 mins ago", from the last fetch from CuisineIQ. Uploaded files, sample
// data or a failed fetch say which day and time the sales go up to instead (also on hover).
function showUpdated() {
  const last = state.ds.lastSync;
  $("updated").textContent = last?.ok ? `Last updated ${timeAgo(new Date(last.at))}` : $("updated").title;
}

function renderHeadline() {
  const ds = state.ds;
  const h = M.headline(ds);
  state.headline = h;
  const isRealToday = M.dayKey(h.today) === M.dayKey(new Date());
  $("updated").title = h.todayFinished
    ? `Sales up to the end of ${fmtDate(h.today, { weekday: "short", day: "numeric", month: "short" })}`
    : `Sales up to ${fmtDate(ds.asOf, { weekday: "short", day: "numeric", month: "short" })}, ${timeText(ds.asOf)}`;
  showUpdated();

  // ---- Today: the big number, how it compares, and a bar towards a usual day
  const day = weekday(h.today);
  setTodayTitle(h);
  $("kpi-today-cur").textContent = currencySymbol;
  $("kpi-today").setAttribute("aria-label", money.format(h.todayNow.sales));
  countUp($("kpi-today"), h.todayNow.sales, (n) => whole.format(Math.round(n)));

  const usualName = `a usual ${day}`;
  const leftOutText = h.typicalLeftOut.length ? `Leaving out ${listText(h.typicalLeftOut.map(shortDate))}: unusual ${h.typicalLeftOut.length === 1 ? "day" : "days"} (a holiday or a one-off)` : "";
  const averageOf = h.typicalWeeks
    ? `Average of the last ${h.typicalWeeks === 1 ? "" : `${h.typicalWeeks} `}normal ${day}${h.typicalWeeks === 1 ? "" : "s"}${leftOutText ? `. ${leftOutText}.` : ""}`
    : "";
  $("kpi-today-note").hidden = !leftOutText;
  $("kpi-today-note").textContent = leftOutText ? `${leftOutText}.` : "";
  const c = h.todayCompare;
  const chip = $("kpi-today-change");
  chip.hidden = c.value == null || c.kind === "progress";
  if (!chip.hidden) {
    setChip(chip, c.value, c.kind === "change-same-time" ? `vs ${usualName} by now` : `vs ${usualName}`, "hl-chip");
    chip.title = averageOf;
  }

  const ref = h.typicalDay;
  $("kpi-today-bar").hidden = !ref;
  if (ref) {
    const share = h.todayNow.sales / ref;
    const fill = $("kpi-today-fill");
    fill.style.width = "0";
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${Math.min(share, 1) * 100}%`; }));
    const byNow = !h.todayFinished && h.typicalByNow != null ? h.typicalByNow / ref : null;
    $("kpi-today-tick").hidden = byNow == null;
    $("kpi-today-bar").classList.toggle("has-tick", byNow != null);
    if (byNow != null) $("kpi-today-tick").style.left = `${Math.min(byNow, 1) * 100}%`;
    $("kpi-today-progress").replaceChildren(el("b", null, pct.format(share)), document.createTextNode(` of ${usualName}`));
    $("kpi-today-usual").replaceChildren(document.createTextNode("Usual day "), el("b", null, money.format(ref)));
    $("kpi-today-bar").title = averageOf;
  } else if (c.value == null) {
    chip.hidden = false;
    chip.className = "hl-chip";
    chip.textContent = `No earlier ${day}s to compare with`;
  }

  // Orders (or tickets), average order and visitors under the bar
  const row = ds.daily.find((d) => M.dayKey(d.date) === M.dayKey(h.today));
  const tickets = h.todayNow.orders ?? row?.transactions ?? null;
  const ticketWord = h.todayNow.orders != null ? "orders" : "tickets";
  const v = M.visitorSummary(ds, { from: h.today, to: M.addDays(h.today, 1) });
  const stats = [
    tickets != null && [whole.format(tickets), h.todayNow.orders != null ? "orders" : "tickets (about)"],
    tickets && [money.format(h.todayNow.sales / tickets), `avg ${ticketWord === "orders" ? "order" : "ticket"}`],
    v && [`${whole.format(v.visitors)}`, h.todayFinished || shopClosed(h.today) ? "visitors" : "visitors so far"],
    v?.conversion != null && !tickets && [pct.format(v.conversion), "conversion"],
  ].filter(Boolean).slice(0, 3);
  $("kpi-today-stats").replaceChildren(...stats.map(([value, label]) => {
    const div = el("div");
    div.append(el("strong", null, value), document.createTextNode(label));
    return div;
  }));

  // ---- Yesterday
  $("kpi-yesterday-title").textContent = isRealToday ? `Yesterday (${fmtDate(h.yesterday, { weekday: "short" })})` : `${weekday(h.yesterday)} ${shortDate(h.yesterday)}`;
  if (h.yesterdayNow.days) countUp($("kpi-yesterday"), h.yesterdayNow.sales, (n) => money.format(n));
  else $("kpi-yesterday").textContent = "–";
  // The two weeks up to yesterday, ending on the highlighted dot
  const fortnight = M.dailySales(ds, M.lastDays(ds, 15)).filter((p) => !p.partial).slice(-14).map((p) => p.value);
  if (fortnight.length > 1) sparkline($("kpi-yesterday-visual"), fortnight);
  // Against the same weekday a week before, or the last normal one if that was unusual
  const lastWeekSame = +h.yesterdayComparedTo === +M.addDays(h.yesterday, -7);
  setChip($("kpi-yesterday-change"), h.yesterdayChange, lastWeekSame ? `on last ${fmtDate(h.yesterday, { weekday: "short" })}` : `on ${h.yesterdayComparedTo ? shortDate(h.yesterdayComparedTo) : ""}`, "tile-chip");
  $("kpi-yesterday-change").title = h.yesterdayComparedTo
    ? `Compared with ${fmtDate(h.yesterdayComparedTo, { weekday: "long", day: "numeric", month: "short" })}` +
      (h.yesterdayLeftOut.length ? `, skipping ${listText(h.yesterdayLeftOut.map(shortDate))} (unusual)` : "")
    : "";
  $("kpi-yesterday-detail").textContent = ordersText(h.yesterdayNow) ?? (h.yesterdayNow.discount ? `Discounts ${money.format(h.yesterdayNow.discount)}` : "");
  showVisitors($("kpi-yesterday-visitors"), { from: h.yesterday, to: h.today });

  // ---- The month so far
  const monthName = fmtDate(h.monthStart, { month: "long" });
  const lastMonth = M.addDays(h.monthStart, -1);
  const lastMonthShort = fmtDate(lastMonth, { month: "short" });
  $("kpi-month-title").textContent = isRealToday ? `${monthName} so far` : `${monthName} to ${shortDate(h.today)}`;
  countUp($("kpi-month"), h.month.sales, (n) => money.format(n));
  if (h.monthRunning.length > 1) sparkline($("kpi-month-visual"), h.monthRunning);
  if (h.monthDaysDone < 7) {
    // Compared with last month once there's a full week to go on
    setChip($("kpi-month-change"), null, "", "tile-chip");
  } else {
    const lastDay = Math.min(h.monthDaysDone, lastMonth.getDate());
    setChip($("kpi-month-change"), h.monthChange, `vs ${lastMonthShort}`, "tile-chip");
    $("kpi-month-change").title = `Compared with ${fmtDate(lastMonth, { month: "long" })} ${lastDay === 1 ? "1" : `1–${lastDay}`}`;
  }
  $("kpi-month-detail").textContent = h.monthProjection != null
    ? `On track for ${money.format(h.monthProjection)}`
    : h.month.orders != null ? `${whole.format(h.month.orders)} orders` : "";

  renderTodayHours();
  if (currentTab === "today") drawn.add("today");
}

// The headline card's label and the time beside it. Early in the morning the latest
// figures are still yesterday's: "Yesterday's result", with "Before opening" beside it.
function setTodayTitle(h, now = new Date()) {
  const ds = state.ds;
  const realToday = M.dayKey(h.today) === M.dayKey(now);
  const realYesterday = M.dayKey(h.today) === M.dayKey(M.addDays(M.startOfDay(now), -1));
  const open = CONFIG.openingHours?.[now.getDay()]?.[0] ?? 7;
  const beforeOpening = now.getHours() + now.getMinutes() / 60 < open;
  let title, when;
  if (realToday) {
    title = todayLabel(h, now);
    when = h.todayFinished
      ? fmtDate(h.today, { weekday: "short", day: "numeric", month: "short" })
      : `${fmtDate(ds.asOf, { weekday: "short", day: "numeric", month: "short" })} · ${timeText(ds.asOf)}`;
  } else if (realYesterday) {
    title = "Yesterday's result";
    when = beforeOpening ? `Before opening · opens ${hourLabel(open)}` : "Open · today's figures soon";
  } else {
    title = `${weekday(h.today)} ${shortDate(h.today)}`;
    when = fmtDate(h.today, { weekday: "short", day: "numeric", month: "short" });
  }
  $("kpi-today-title").textContent = title;
  $("kpi-today-when").textContent = when;
}

// "a", "a and b", "a, b and c"
const listText = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

// Whether the shop has shut for the day (see openingHours in config.js)
function shopClosed(day, now = new Date()) {
  const close = CONFIG.openingHours?.[day.getDay()]?.[1] ?? 18;
  return M.dayKey(day) < M.dayKey(now) || now.getHours() + now.getMinutes() / 60 >= close;
}

// What today's figures are, by the time of day: "Before opening", "Morning so far" until
// noon, "Today so far" in the afternoon, "Today's result" once the shop has closed
function todayLabel(h, now = new Date()) {
  if (h.todayFinished || shopClosed(h.today, now)) return "Today's result";
  const open = CONFIG.openingHours?.[h.today.getDay()]?.[0] ?? 7;
  if (now.getHours() + now.getMinutes() / 60 < open && !h.todayNow.sales) return "Before opening";
  return now.getHours() < 12 ? "Morning so far" : "Today so far";
}

// "▲ 12% vs a usual Monday" in a chip coloured by direction
function setChip(target, change, comparedTo, baseClass) {
  target.className = baseClass;
  if (change == null || !isFinite(change)) { target.textContent = ""; return; }
  const flat = Math.abs(change) < 0.005;
  if (!flat) target.classList.add(change > 0 ? "up" : "down");
  target.textContent = flat ? `Same ${comparedTo.replace(/^vs /, "as ").replace(/^on /, "as ")}` : `${change > 0 ? "▲" : "▼"} ${pct.format(Math.abs(change))} ${comparedTo}`;
}

// Today hour by hour against a usual day: sales with timed sales, otherwise visitors
function renderTodayHours() {
  const data = M.todayByHour(state.ds);
  const card = $("today-hours-card");
  card.hidden = !data || data.hours.length < 2 || !data.hours.some((p) => p.value);
  if (card.hidden) return;
  const h = state.headline;
  const day = weekday(h.today);
  const sales = data.kind === "sales";
  const fmt = (v) => (sales ? money.format(v) : whole.format(Math.round(v)));
  $("today-hours-title").textContent = `${sales ? "Today" : "Visitors today"} vs a usual ${day}`;
  $("today-hours-sub").textContent = data.usualDays
    ? `${sales ? "Sales" : "People coming in"} each hour. The line is the average of the last ${data.usualDays === 1 ? "" : `${data.usualDays} `}normal ${day}${data.usualDays === 1 ? "" : "s"}${h.typicalLeftOut.length ? ` (leaving out ${listText(h.typicalLeftOut.map(shortDate))})` : ""}.`
    : `${sales ? "Sales" : "People coming in"} each hour.`;
  $("today-hours-key").textContent = sales ? "Today" : "Visitors today";
  $("today-hours-key-usual").textContent = `Usual ${day}`;
  const narrow = $("today-hours-chart").clientWidth < 420;
  columnChart(card, data.hours, {
    animate: state.animate,
    ariaLabel: `${sales ? "Sales" : "Visitors"} each hour today, against a usual ${day}`,
    formatTick: (v) => (sales ? moneyShort.format(v) : oneDecimal.format(v)),
    xLabel: (p, i) => (narrow && i % 2 ? null : hourLabel(p.hour)),
    tooltip: (p) => [
      p.future ? "Still to come" : fmt(p.value),
      `${hourLabel(p.hour)} – ${hourLabel(p.hour + 1)}${p.partial ? " (so far)" : ""}`,
      p.line != null ? `Usual ${day}: ${fmt(p.line)}` : "",
    ].filter(Boolean),
  });
}

// Today's best sellers so far, from the product figures fetched during the day
async function renderTodayBest() {
  const h = state.headline;
  const totals = await periodProductTotals({ from: h.today, to: M.addDays(h.today, 1) }, { quiet: true });
  const top = !totals || totals.error || totals.fixedPeriod || totals.days === 0 ? [] : M.topProducts(totals, "quantity", 5);
  $("today-best-card").hidden = !top.length;
  if (!top.length) return;
  $("today-best-title").textContent = M.dayKey(h.today) === M.dayKey(new Date()) ? todayLabel(h) : `${weekday(h.today)} ${shortDate(h.today)}`;
  $("today-best-note").textContent = $("product-card").hidden ? "" : "Tap one to see how it sells day by day.";
  barList($("today-best"), top.map((p) => ({
    name: p.name,
    label: p.name,
    sublabel: [p.category, money.format(p.revenue)].filter(Boolean).join(" · "),
    value: p.quantity,
    display: `${whole.format(p.quantity)} sold`,
  })), { ranked: true, animate: currentTab === "today", onSelect: $("product-card").hidden ? null : (item) => openProduct(item.name) });
}

function renderWeekly() {
  const weeks = M.weeklySales(state.ds, state.range);
  const label = (w) => `${shortDate(w.from)} – ${shortDate(M.addDays(w.from, 6))}`;
  const changeText = (w) =>
    w.change == null || w.partial ? "" : `${w.change >= 0 ? "▲" : "▼"} ${pct.format(Math.abs(w.change))} vs week before`;
  const narrow = $("weekly-chart").clientWidth < 500;

  columnChart($("weekly-card"), weeks, {
    animate: state.animate,
    ariaLabel: "Weekly sales",
    formatTick: (v) => moneyShort.format(v),
    xLabel: (w, i) => (narrow && weeks.length > 6 && i % 2 !== (weeks.length - 1) % 2 ? null : shortDate(w.from)),
    tooltip: (w) => [money.format(w.value), `Week of ${label(w)}${w.partial ? " (so far)" : ""}`, changeText(w)].filter(Boolean),
  });

  fillTable($("weekly-table"), ["Week", "Sales", "Change"], weeks.slice().reverse().map((w) => [
    label(w) + (w.partial ? " (so far)" : ""),
    money.format(w.value),
    w.partial || w.change == null ? "–" : `${w.change >= 0 ? "+" : "−"}${pct.format(Math.abs(w.change))}`,
  ]));
}

async function renderPeriod() {
  const range = state.range;
  renderPeriodLabel();
  for (const tab of ["sales", "products", "busy"]) drawn.delete(tab);
  renderSummary();
  renderDaily();
  renderWeekly();
  renderProduct();
  renderWeekdays();
  renderBusyHours();
  renderVisitors();
  renderPayments();
  renderBusyFeature();
  if (currentTab !== "today" && currentTab !== "tools") drawn.add(currentTab);
  const animate = state.animate;
  state.animate = false;
  // Product figures may need fetching for the new period: draw them when they arrive
  state.productTotals = await periodProductTotals(range);
  state.unsoldKnown = await knownProducts(range);
  if (state.range !== range) return; // another period was picked meanwhile
  state.animate = animate;
  state.unsoldAll = false;
  renderBestSellers();
  renderSlowSellers();
  renderCategories();
  renderProductsFeature();
  state.animate = false;
}

async function periodProductTotals(range, { quiet = false } = {}) {
  const ds = state.ds;
  const key = `${+range.from}|${+range.to}`;
  if (!productTotalsCache.has(key)) {
    if (!quiet) {
      $("best-note").textContent = $("slow-note").textContent = $("category-note").textContent = "";
      for (const id of ["best-sellers", "slow-sellers", "categories"]) skeletonRows($(id));
    }
    try {
      productTotalsCache.set(key, (await loadProductTotals(ds, range)) ?? M.productTotals(ds, range));
    } catch (err) {
      return { error: err.message };
    }
  }
  return productTotalsCache.get(key);
}

// What "didn't sell" is measured against: a product export for a fixed period uses the
// till's product list; otherwise, whatever sold in the 90 days up to the period's end
// (so long-gone products don't fill the list).
async function knownProducts(range) {
  const totals = state.productTotals;
  if (!totals || totals.error) return null;
  if (totals.fixedPeriod) return state.ds.catalogue ? { items: state.ds.catalogue, from: "list" } : null;
  const end = M.clip(state.ds, range).to;
  const lookback = await periodProductTotals({ from: M.addDays(end, -90), to: end }, { quiet: true });
  return lookback.error ? null : { items: lookback.items, from: "90 days" };
}

// Sales tab: the period's total in big type, how it compares with the period before,
// a sparkline of the days, and the rest of the figures underneath
function renderSummary() {
  const ds = state.ds;
  const s = M.periodSummary(ds, state.range);
  const periodDays = M.dayCount(M.clip(ds, state.range));
  const v = M.visitorSummary(ds, state.range);
  $("sales-feature-label").textContent = PRESET_LABELS[state.preset] ?? rangeText(state.range);
  $("sales-cur").textContent = currencySymbol;
  $("sales-total").setAttribute("aria-label", money.format(s.sales));
  countUp($("sales-total"), s.sales, (n) => whole.format(Math.round(n)), { animate: state.animate });

  // Against the same number of days just before, complete days only (a half-finished
  // today would make any period look worse than it is)
  const h = state.headline;
  const clipped = M.clip(ds, state.range);
  const to = !h.todayFinished && +clipped.to > +h.today ? h.today : clipped.to;
  const days = M.dayCount({ from: clipped.from, to });
  const prev = days > 0 && M.previousRange(ds, { from: clipped.from, to });
  const now = days > 0 && M.periodSummary(ds, { from: clipped.from, to });
  const before = prev && M.periodSummary(ds, prev);
  const chip = $("sales-change");
  chip.hidden = !before || before.days < days || !before.sales;
  if (!chip.hidden) {
    setChip(chip, (now.sales - before.sales) / before.sales, days === 1 ? "vs the day before" : `vs the ${whole.format(days)} days before`, "hl-chip");
    chip.title = to < clipped.to ? "Complete days only: today is left out until it's finished" : "";
  }
  const values = M.dailySales(ds, state.range).map((p) => p.value);
  if (values.length > 1) sparkline($("sales-spark"), values, { animate: state.animate });
  else $("sales-spark").replaceChildren();

  const items = [
    s.orders != null && ["Orders", whole.format(s.orders)],
    s.avgOrder != null && ["Average order", moneyCents.format(s.avgOrder)],
    s.exclVat != null && ["Excl. VAT", money.format(s.exclVat)],
    s.vat != null && ["VAT", money.format(s.vat)],
    s.discount != null && ["Discounts", money.format(s.discount)],
    s.refund != null && [ds.lines ? "Refunds" : "Refunds (credit notes)", money.format(s.refund)],
    v && [v.days < periodDays ? `Visitors (${v.days} of ${periodDays} days)` : "Visitors", whole.format(v.visitors)],
    v?.conversion != null && [`Conversion (${ds.lines ? "orders" : "tickets"} ÷ visitors)`, pct.format(v.conversion)],
  ].filter(Boolean);
  if (s.days < periodDays) items.push(["Days with data", `${s.days} of ${periodDays}`]);
  $("summary").replaceChildren(...items.map(([label, value]) => {
    const div = el("div");
    div.append(el("strong", null, value), document.createTextNode(label));
    return div;
  }));
}

// Products tab: the period's top seller, with the runner-up, top category and what didn't sell
function renderProductsFeature() {
  const totals = state.productTotals;
  const card = $("products-feature");
  const top = totals && !totals.error ? M.topProducts(totals, state.bestBy, 2) : [];
  card.hidden = !top.length;
  if (!top.length) return;
  const [first, second] = top;
  $("products-feature-label").textContent = `Top seller · ${totals.fixedPeriod ? "export period" : (PRESET_LABELS[state.preset] ?? rangeText(state.range))}`;
  $("products-top").textContent = first.name;
  $("products-top-detail").textContent = `${whole.format(first.quantity)} sold · ${money.format(first.revenue)}`;
  const category = M.salesByCategory(totals, 1)[0];
  const unsold = state.unsoldKnown ? M.unsoldProducts(totals, state.unsoldKnown.items).length : null;
  const stats = [
    second && ["Runner-up", second.name],
    category && ["Top category", category.name],
    unsold != null && ["Didn't sell", `${whole.format(unsold)} item${unsold === 1 ? "" : "s"}`],
  ].filter(Boolean);
  $("products-stats").replaceChildren(...stats.map(([label, value]) => {
    const div = el("div");
    div.append(el("strong", null, value), document.createTextNode(label));
    return div;
  }));
}

// Busy tab: the busiest day of the week, the quietest, the peak hour and visitors
function renderBusyFeature() {
  const ds = state.ds;
  const days = M.weekdayAverages(ds, state.range).filter((d) => d.days);
  const card = $("busy-feature");
  card.hidden = !days.length;
  if (!days.length) return;
  const best = days.reduce((a, b) => (b.value > a.value ? b : a));
  const worst = days.reduce((a, b) => (b.value < a.value ? b : a));
  $("busy-feature-label").textContent = `Busiest day · ${PRESET_LABELS[state.preset] ?? rangeText(state.range)}`;
  $("busy-top").textContent = WEEKDAYS_LONG[best.weekday];
  $("busy-top-detail").textContent = `About ${money.format(best.value)} a day`;
  const hours = ds.lines ? M.busyHours(ds, state.range, "weekday") : [];
  const visitorHours = M.visitorsByHour(ds, state.range).hours;
  const peakOf = (list) => (list.length ? list.reduce((a, b) => (b.value > a.value ? b : a)) : null);
  const peak = peakOf(hours) ?? peakOf(visitorHours);
  const v = M.visitorSummary(ds, state.range);
  const stats = [
    days.length > 1 && ["Quietest day", WEEKDAYS_LONG[worst.weekday]],
    peak && [hours.length ? "Busiest hour" : "Most visitors", `${hourLabel(peak.hour)}`],
    v && ["Visitors", whole.format(v.visitors)],
  ].filter(Boolean);
  $("busy-stats").replaceChildren(...stats.map(([label, value]) => {
    const div = el("div");
    div.append(el("strong", null, value), document.createTextNode(label));
    return div;
  }));
}

// Tools tab: is the door counter on the shop's PC sending its counts, and when were the
// sales last fetched from CuisineIQ
function renderStatus() {
  const ds = state.ds;
  if (ds.source !== "cloud") return;
  $("status-card").hidden = false;
  const now = new Date();
  const seen = ds.counterLastSeen ? new Date(ds.counterLastSeen) : null;
  const [open, close] = CONFIG.openingHours?.[now.getDay()] ?? [7, 18];
  const hour = now.getHours() + now.getMinutes() / 60;
  const openNow = hour >= open + 0.25 && hour < close + 0.5; // a little slack either side
  const minsAgo = seen ? (now - seen) / 60000 : null;
  const orb = $("counter-orb");
  if (!seen) {
    orb.className = "orb idle";
    $("counter-title").textContent = "Door counter not connected";
    $("counter-detail").textContent = "Nothing received from the shop's PC yet.";
  } else if (minsAgo < 35) {
    orb.className = "orb ok";
    $("counter-title").textContent = "Door counter online";
    $("counter-detail").textContent = `Last sent ${timeAgo(seen)}`;
  } else if (openNow) {
    orb.className = "orb warn";
    $("counter-title").textContent = "Door counter not sending";
    $("counter-detail").textContent = `Nothing since ${timeAgo(seen)} (${timeText(seen)}). Check the shop's PC is on and the counter is running.`;
  } else {
    orb.className = "orb idle";
    $("counter-title").textContent = "Shop closed";
    $("counter-detail").textContent = `The door counter last sent ${timeAgo(seen)} (${shortDate(seen)}, ${timeText(seen)})`;
  }
  const today = M.startOfDay(ds.asOf);
  const visitors = M.visitorSummary(ds, { from: today, to: M.addDays(today, 1) });
  const sync = ds.lastSync;
  const tiles = [
    ["Visitors today", visitors ? whole.format(visitors.visitors) : "–"],
    ["Counter last sent", seen ? timeText(seen) : "–"],
    ["CuisineIQ fetch", sync ? `${timeText(new Date(sync.at))}${sync.ok ? "" : " · failed"}` : "–", sync && !sync.ok],
    ["Sales up to", timeText(ds.asOf)],
  ];
  $("status-grid").replaceChildren(...tiles.map(([label, value, bad]) => {
    const div = el("div", bad ? "bad" : null);
    div.append(el("strong", null, value), document.createTextNode(label));
    return div;
  }));
}

function renderDaily() {
  const points = M.dailySales(state.ds, state.range).map((p) => ({ ...p, line: p.avg7 }));
  const every = points.length <= 7 ? 1 : Math.ceil(points.length / ($("daily-chart").clientWidth < 500 ? 4 : 7));
  columnChart($("daily-card"), points, {
    animate: state.animate,
    ariaLabel: `Daily sales, ${rangeText(state.range)}`,
    formatTick: (v) => moneyShort.format(v),
    xLabel: (p, i) => ((points.length - 1 - i) % every === 0 ? (points.length <= 7 ? fmtDate(p.date, { weekday: "short" }) : shortDate(p.date)) : null),
    tooltip: (p) => [
      money.format(p.value),
      `${fmtDate(p.date, { weekday: "short", day: "numeric", month: "short" })}${p.partial ? " (so far)" : ""}`,
      p.line != null ? `7-day average ${money.format(p.line)}` : "",
    ].filter(Boolean),
  });
  fillTable($("daily-table"), ["Day", "Sales", "7-day average"], points.slice().reverse().map((p) => [
    fmtDate(p.date, { weekday: "short", day: "numeric", month: "short" }) + (p.partial ? " (so far)" : ""),
    money.format(p.value),
    p.line != null ? money.format(p.line) : "–",
  ]));
}

// Product search: matches show as you type (best sellers first when the box is empty);
// tap one, or press Enter for the top match, to add it to the chart
function setupProductSearch() {
  const ds = state.ds;
  const products = M.productList(ds);
  $("product-card").hidden = !products.length || (!ds.lines && ds.source !== "cloud");
  if ($("product-card").hidden) return;
  const input = $("product-search");
  const list = $("product-suggestions");
  let matches = [];
  let active = -1;

  const show = () => {
    matches = M.searchProducts(products.filter((p) => !state.products.includes(p.name)), input.value);
    active = -1;
    list.replaceChildren(...(matches.length ? matches.map((p, i) => {
      const li = document.createElement("li");
      li.id = `product-suggestion-${i}`;
      li.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "suggestion-name";
      name.textContent = p.name;
      const detail = document.createElement("span");
      detail.className = "suggestion-detail";
      detail.textContent = [p.category, p.quantity ? `${whole.format(p.quantity)} sold` : null].filter(Boolean).join(" · ");
      li.append(name, detail);
      li.addEventListener("click", () => choose(p.name));
      return li;
    }) : [Object.assign(document.createElement("li"), { className: "suggestion-empty", textContent: "No products match" })]));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  const hide = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const highlight = (i) => {
    active = Math.max(-1, Math.min(i, matches.length - 1));
    [...list.children].forEach((li, j) => li.setAttribute("aria-selected", String(j === active)));
    if (active >= 0) input.setAttribute("aria-activedescendant", `product-suggestion-${active}`);
  };
  const choose = (name) => {
    hide();
    input.value = "";
    input.blur(); // put the phone keyboard away so the chart can be seen
    addProduct(name);
  };

  input.addEventListener("focus", show);
  input.addEventListener("input", show);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) show(); highlight(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); const p = matches[Math.max(active, 0)]; if (p) choose(p.name); }
    else if (e.key === "Escape") hide();
  });
  // Keep the box focused while a suggestion is tapped, so the tap lands
  list.addEventListener("pointerdown", (e) => e.preventDefault());
  input.addEventListener("blur", hide);
  setupToggle("product-by", "by", (v) => { state.productBy = v; state.animate = true; renderProduct(); state.animate = false; });
  // With several products: one set of bars adding them up, or a line each
  setupToggle("product-view", "view", (v) => { state.productView = v; renderProductChips(); state.animate = true; renderProduct(); state.animate = false; });
}

const MAX_PRODUCTS = 5; // one per chart colour

// From a best seller: add it to the product chart and scroll there
function openProduct(name) {
  if (currentTab !== "products") goToTab("products");
  $("product-card").scrollIntoView({ behavior: smoothScroll(), block: "start" });
  addProduct(name);
}

async function addProduct(name) {
  if (state.products.includes(name)) return;
  if (state.products.length >= MAX_PRODUCTS) {
    $("product-note").textContent = `Up to ${MAX_PRODUCTS} products at once. Remove one (×) to add ${name}.`;
    return;
  }
  state.products = [...state.products, name];
  renderProductChips();
  if (!productHistories.has(name)) {
    $("product-note").textContent = "Loading…";
    try {
      productHistories.set(name, await loadProductHistory(state.ds, name));
    } catch (err) {
      $("product-note").textContent = `Couldn't load ${name}: ${err.message}`;
      removeProduct(name);
      return;
    }
  }
  state.animate = true;
  renderProduct();
  state.animate = false;
}

function removeProduct(name) {
  state.products = state.products.filter((p) => p !== name);
  renderProductChips();
  state.animate = true;
  renderProduct();
  state.animate = false;
}

// The chosen products as chips, coloured like their lines, each with a remove button
function renderProductChips() {
  const chips = $("product-chips");
  chips.hidden = !state.products.length;
  const comparing = state.products.length > 1 && state.productView === "compare";
  $("product-view").hidden = state.products.length < 2;
  chips.replaceChildren(...state.products.map((name, i) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = `legend-dot series-${i + 1}`;
    dot.hidden = !comparing; // bars are all one colour
    const label = document.createElement("span");
    label.className = "chip-name";
    label.textContent = name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.addEventListener("click", () => removeProduct(name));
    li.append(dot, label, remove);
    return li;
  }), ...(comparing ? [totalChip()] : []));
}

// Legend entry for the dashed line that adds the chosen products together
function totalChip() {
  const li = document.createElement("li");
  li.className = "chip-total";
  const key = document.createElement("span");
  key.className = "total-key";
  const label = document.createElement("span");
  label.textContent = "Total";
  li.append(key, label);
  return li;
}

function renderProduct() {
  const clear = (note) => {
    $("product-chart").replaceChildren();
    $("product-details").hidden = true;
    $("product-legend").hidden = true;
    $("product-note").textContent = note;
  };
  const chosen = state.products.filter((name) => productHistories.has(name));
  if (!chosen.length) return clear("");
  const histories = chosen.map((name) => productHistories.get(name));
  if (!histories[0].covered.size) return clear("No day-by-day product figures yet. They're added each time new figures are fetched from CuisineIQ.");
  const byQuantity = state.productBy === "quantity";
  const fmt = (v) => (byQuantity ? `${whole.format(v)} sold` : money.format(v));
  const fmtAvg = (v) => (byQuantity ? oneDecimal.format(v) : money.format(v));
  // Every product has figures for the same days, so their points line up
  const series = histories.map((h) => M.productDaily(state.ds, h, state.range, state.productBy));
  const points = series[0];
  if (!points.length) return clear(`No day-by-day product figures in this period.`);

  const start = points[0].date;
  const startNote = +start > +state.range.from ? `Day-by-day product figures start on ${longDate(start)}.` : "";
  const totalOf = (pts) => pts.reduce((a, p) => a + (p.noData ? 0 : p.value), 0);
  const daysWithData = points.filter((p) => !p.noData).length;
  const dayText = (p) => `${fmtDate(p.date, { weekday: "short", day: "numeric", month: "short" })}${p.partial ? " (so far)" : ""}`;
  const every = points.length <= 7 ? 1 : Math.ceil(points.length / ($("product-chart").clientWidth < 500 ? 4 : 7));
  const xLabel = (i) => ((points.length - 1 - i) % every === 0 ? (points.length <= 7 ? fmtDate(points[i].date, { weekday: "short" }) : shortDate(points[i].date)) : null);

  if (chosen.length === 1 || state.productView === "combined") {
    // Bars of the chosen products added together (or the one product)
    const label = chosen.length === 1 ? chosen[0] : "Together";
    const sumOf = (i, key) => series.reduce((a, pts) => (a == null || pts[i][key] == null ? null : a + pts[i][key]), 0);
    const bars = points.map((p, i) => ({ ...p, i, value: sumOf(i, "value") ?? 0, avg7: sumOf(i, "avg7"), line: sumOf(i, "avg7") }));
    const total = totalOf(bars);
    const best = bars.filter((p) => !p.noData).reduce((a, p) => (p.value > a.value ? p : a), bars[0]);
    $("product-note").textContent = [
      `${label}: ${fmt(total)} since ${shortDate(start)}` +
        (chosen.length > 1 ? ` (${chosen.map((name, n) => `${name} ${fmt(totalOf(series[n]))}`).join(", ")}).` : "."),
      daysWithData ? `About ${fmtAvg(total / daysWithData)} a day.` : "",
      best?.value ? `Best day ${dayText(best)} (${fmt(best.value)}).` : "",
      startNote,
    ].filter(Boolean).join(" ");
    $("product-legend").hidden = false;
    $("product-legend-bar").textContent = `${byQuantity ? "Number sold" : "Sales"} per day${chosen.length > 1 ? " (added together)" : ""}`;
    columnChart($("product-card"), bars, {
      animate: state.animate,
      ariaLabel: `${chosen.join(" + ")}: ${byQuantity ? "number sold" : "sales"} per day`,
      formatTick: (v) => (byQuantity ? whole.format(v) : moneyShort.format(v)),
      xLabel: (p, i) => xLabel(i),
      tooltip: (p) => [
        p.noData ? "No product figures" : fmt(p.value),
        dayText(p),
        ...(chosen.length > 1 && !p.noData ? chosen.map((name, n) => `${name}: ${fmt(series[n][p.i].value)}`) : []),
        p.avg7 != null ? `7-day average ${fmtAvg(p.avg7)}` : "",
      ].filter(Boolean),
    });
  } else {
    // Daily figures jump about too much to compare over long periods: show 7-day averages there
    const smooth = points.length > 45;
    const sumAt = (i, key) => (points[i].noData ? null : series.reduce((a, pts) => a + (pts[i][key] ?? 0), 0));
    const totals = points.map((p, i) => ({ value: sumAt(i, "value"), avg7: p.avg7 == null ? null : sumAt(i, "avg7") }));
    $("product-note").textContent = [
      `Since ${shortDate(start)}: ` + chosen.map((name, n) => `${name} ${fmt(totalOf(series[n]))}`).join(", ") +
        `; ${fmt(series.reduce((a, pts) => a + totalOf(pts), 0))} together.`,
      smooth ? "Lines show 7-day averages; tap the chart for each day." : "",
      startNote,
    ].filter(Boolean).join(" ");
    $("product-legend").hidden = true; // the chips are the key here
    lineChart($("product-card"), points.length, [
      ...chosen.map((name, n) => ({
        label: name,
        values: series[n].map((p) => (p.noData ? null : smooth ? p.avg7 : p.value)),
      })),
      { label: "Total", className: "series-total", values: totals.map((t) => (smooth ? t.avg7 : t.value)) },
    ], {
      animate: state.animate,
      ariaLabel: `${chosen.join(", ")}: ${byQuantity ? "number sold" : "sales"} per day${smooth ? ", 7-day averages" : ""}`,
      formatTick: (v) => (byQuantity ? whole.format(v) : moneyShort.format(v)),
      xLabel,
      tooltip: (i) => [
        dayText(points[i]),
        ...chosen.map((name, n) => {
          const p = series[n][i];
          if (p.noData) return `${name}: no figures`;
          return `${name}: ${fmt(p.value)}` + (smooth && p.avg7 != null ? ` (avg ${fmtAvg(p.avg7)})` : "");
        }),
        totals[i].value == null ? "" : `Total: ${fmt(totals[i].value)}` + (smooth && totals[i].avg7 != null ? ` (avg ${fmtAvg(totals[i].avg7)})` : ""),
      ].filter(Boolean),
    });
  }

  $("product-details").hidden = false;
  const byDay = (h, p) => h.byDay.get(M.dayKey(p.date));
  const headers = chosen.length === 1 ? ["Day", "Number sold", "Sales"] : ["Day", ...chosen, "Total"];
  fillTable($("product-table"), headers, points.map((p, i) => [
    dayText(p),
    ...(chosen.length === 1
      ? [p.noData ? "–" : whole.format(byDay(histories[0], p)?.quantity ?? 0), p.noData ? "–" : money.format(byDay(histories[0], p)?.revenue ?? 0)]
      : [...series.map((pts) => (pts[i].noData ? "–" : fmt(pts[i].value))), p.noData ? "–" : fmt(series.reduce((a, pts) => a + pts[i].value, 0))]),
  ]).reverse());
}

// Shimmering placeholder rows while a list's figures load
function skeletonRows(target, n = 5) {
  target.replaceChildren(...Array.from({ length: n }, (_, i) => {
    const row = el("div", "sk-row");
    row.style.setProperty("--w", `${90 - i * 12}%`);
    row.append(el("span", "sk sk-line"), el("span", "sk sk-bar"));
    return row;
  }));
}

function productPeriodNote(totals) {
  if (totals.fixedPeriod) {
    const range = +totals.from === +totals.to ? longDate(totals.from) : `${shortDate(totals.from)} – ${longDate(totals.to)}`;
    return `${range}, from the product-sold export (the period above doesn't change it).`;
  }
  if (totals.days == null) return "";
  const periodDays = M.dayCount(M.clip(state.ds, state.range));
  if (!totals.days) return "No product figures for this period.";
  return totals.days < periodDays ? `Product figures for ${totals.days} of the ${periodDays} days.` : "";
}

function renderBestSellers() {
  const totals = state.productTotals;
  if (!totals) return;
  if (totals.error) { $("best-note").textContent = `Couldn't load product figures: ${totals.error}`; $("best-sellers").replaceChildren(); return; }
  const top = M.topProducts(totals, state.bestBy, 10);
  const excluded = CONFIG.exports.bestSellerExcludeCategories;
  const canOpen = !$("product-card").hidden;
  $("best-note").textContent = [
    productPeriodNote(totals),
    totals.fixedPeriod && excluded.length ? `Leaves out ${excluded.join(" and ")}.` : "",
    canOpen ? "Tap a product to see it day by day." : "",
  ].filter(Boolean).join(" ");
  barList($("best-sellers"), top.map((p) => ({
    name: p.name,
    label: p.name,
    sublabel: [
      p.category,
      state.bestBy === "quantity" ? money.format(p.revenue) : `${whole.format(p.quantity)} sold`,
      p.price ? `${money.format(p.price)} each` : null,
    ].filter(Boolean).join(" · "),
    value: state.bestBy === "quantity" ? p.quantity : p.revenue,
    display: state.bestBy === "quantity" ? `${whole.format(p.quantity)} sold` : money.format(p.revenue),
  })), { ranked: true, animate: state.animate, onSelect: canOpen ? (item) => openProduct(item.name) : null });
}

function renderSlowSellers() {
  const totals = state.productTotals;
  if (!totals) return;
  const unsoldHead = $("unsold-head");
  const clearUnsold = () => { unsoldHead.hidden = $("unsold-note").hidden = $("unsold-more").hidden = true; $("unsold").replaceChildren(); };
  if (totals.error) { $("slow-note").textContent = `Couldn't load product figures: ${totals.error}`; $("slow-sellers").replaceChildren(); clearUnsold(); return; }
  const byQuantity = state.slowBy === "quantity";
  const canOpen = !$("product-card").hidden;
  const slow = M.slowProducts(totals, state.slowBy, 10);
  const noFigures = totals.days === 0;
  $("slow-note").textContent = [
    productPeriodNote(totals),
    !noFigures && slow.length ? `The ${slow.length === 1 ? "product" : `${slow.length} products`} that sold least.` : "",
    canOpen && slow.length ? "Tap one to see it day by day." : "",
  ].filter(Boolean).join(" ");
  barList($("slow-sellers"), slow.map((p) => ({
    name: p.name,
    label: p.name,
    sublabel: [
      p.category,
      byQuantity ? money.format(p.revenue) : `${whole.format(p.quantity)} sold`,
      p.price ? `${money.format(p.price)} each` : null,
    ].filter(Boolean).join(" · "),
    value: byQuantity ? p.quantity : p.revenue,
    display: byQuantity ? `${whole.format(p.quantity)} sold` : money.format(p.revenue),
  })), {
    animate: state.animate,
    onSelect: canOpen ? (item) => openProduct(item.name) : null,
    // Against the best seller, so a handful sold looks like the handful it is
    max: M.topProducts(totals, state.slowBy, 1)[0]?.[byQuantity ? "quantity" : "revenue"],
  });

  // Products that didn't sell at all
  const known = state.unsoldKnown;
  if (!known || noFigures) { clearUnsold(); return; }
  const unsold = M.unsoldProducts(totals, known.items);
  unsoldHead.hidden = $("unsold-note").hidden = false;
  unsoldHead.textContent = unsold.length ? `Didn't sell (${whole.format(unsold.length)})` : "Didn't sell";
  $("unsold-note").textContent = !unsold.length
    ? (known.from === "list" ? "Everything on the till's product list sold at least once." : "Everything that sold in the last 90 days sold at least once in this period.")
    : known.from === "list" ? "On the till's product list, but none sold in the export's period." : "Sold in the 90 days up to the end of this period, but none in it.";
  const shown = state.unsoldAll ? unsold : unsold.slice(0, 12);
  $("unsold").replaceChildren(...shown.map((p) => {
    const li = document.createElement("li");
    const row = document.createElement(canOpen ? "button" : "div");
    if (canOpen) { row.type = "button"; row.addEventListener("click", () => openProduct(p.name)); }
    const name = Object.assign(document.createElement("span"), { className: "unsold-name", textContent: p.name });
    const detail = Object.assign(document.createElement("span"), {
      className: "unsold-detail",
      textContent: [p.category, p.price ? money.format(p.price) : null].filter(Boolean).join(" · "),
    });
    row.append(name, detail);
    li.appendChild(row);
    return li;
  }));
  $("unsold-more").hidden = shown.length === unsold.length;
  $("unsold-more").textContent = `Show all ${whole.format(unsold.length)}`;
}

function renderCategories() {
  const totals = state.productTotals;
  if (!totals) return;
  if (totals.error) { $("category-note").textContent = `Couldn't load product figures: ${totals.error}`; $("categories").replaceChildren(); return; }
  $("category-note").textContent = productPeriodNote(totals);
  barList($("categories"), M.salesByCategory(totals, 8).map((c) => ({
    label: c.name,
    sublabel: `${pct.format(c.share)} of product sales`,
    value: c.revenue,
    display: money.format(c.revenue),
  })), { animate: state.animate });
}

function renderWeekdays() {
  const days = M.weekdayAverages(state.ds, state.range);
  columnChart($("weekday-card"), days, {
    animate: state.animate,
    ariaLabel: "Average sales by day of the week",
    formatTick: (v) => moneyShort.format(v),
    xLabel: (d) => WEEKDAYS[d.weekday],
    tooltip: (d) => [money.format(d.value), `Average on ${WEEKDAYS_LONG[d.weekday]}`, `${d.days} ${d.days === 1 ? "day" : "days"} in this period`],
  });
  const withData = days.filter((d) => d.days);
  if (!withData.length) { $("weekday-note").textContent = "No complete days in this period yet."; return; }
  const best = withData.reduce((a, b) => (b.value > a.value ? b : a));
  const worst = withData.reduce((a, b) => (b.value < a.value ? b : a));
  $("weekday-note").textContent = `Busiest: ${WEEKDAYS_LONG[best.weekday]} (${money.format(best.value)}). Quietest: ${WEEKDAYS_LONG[worst.weekday]} (${money.format(worst.value)}).`;
}

function renderBusyHours() {
  if (!state.ds.lines) return;
  const hours = M.busyHours(state.ds, state.range, state.hoursKind);
  if (!hours.length) {
    $("hours-chart").replaceChildren();
    $("hours-note").textContent = `No ${state.hoursKind === "weekend" ? "weekend" : "weekday"} sales in this period yet.`;
    return;
  }
  const narrow = $("hours-chart").clientWidth < 420;
  columnChart($("hours-card"), hours, {
    animate: state.animate,
    ariaLabel: "Average orders per hour of the day",
    formatTick: (v) => oneDecimal.format(v),
    xLabel: (p, i) => (narrow && i % 2 ? null : hourLabel(p.hour)),
    tooltip: (p) => [`${oneDecimal.format(p.value)} orders`, `${hourLabel(p.hour)} – ${hourLabel(p.hour + 1)}, on average`],
  });
  const peak = hours.reduce((a, b) => (b.value > a.value ? b : a));
  $("hours-note").textContent = `Busiest: ${hourLabel(peak.hour)} – ${hourLabel(peak.hour + 1)}, about ${Math.round(peak.value)} orders.`;
}

// Visitors per hour from the door counter: the day's counts, or the average over the
// period. With timed sales, a line shows the orders in the same hours. Hidden without counts.
function renderVisitors() {
  const { days, hours } = M.visitorsByHour(state.ds, state.range);
  $("visitors-card").hidden = !hours.length;
  if (!hours.length) return;
  const average = M.dayCount(M.clip(state.ds, state.range)) > 1;
  const fmt = (v) => (average ? oneDecimal.format(v) : whole.format(v));
  const hasLine = hours.some((p) => p.line != null);
  $("visitors-legend").hidden = !hasLine;
  $("visitors-sub").textContent = average
    ? `Average visitors per hour over the ${days === 1 ? "one day" : `${days} days`} with counts, staff left out.`
    : "People coming in each hour, staff left out.";
  const narrow = $("visitors-chart").clientWidth < 420;
  columnChart($("visitors-card"), hours, {
    animate: state.animate,
    ariaLabel: average ? "Average visitors per hour of the day" : "Visitors per hour of the day",
    formatTick: (v) => oneDecimal.format(v),
    xLabel: (p, i) => (narrow && i % 2 ? null : hourLabel(p.hour)),
    tooltip: (p) => [
      `${fmt(p.value)} visitors`,
      `${hourLabel(p.hour)} – ${hourLabel(p.hour + 1)}${average ? ", on average" : ""}`,
      p.line != null ? `${fmt(p.line)} orders` : "",
    ].filter(Boolean),
  });
  const peak = hours.reduce((a, b) => (b.value > a.value ? b : a));
  $("visitors-note").textContent = `Busiest: ${hourLabel(peak.hour)} – ${hourLabel(peak.hour + 1)}, ${average ? "about " : ""}${whole.format(Math.round(peak.value))} visitors.`;
}

function renderPayments() {
  if ($("payments-card").hidden) return;
  const mix = M.paymentMix(state.ds, state.range);
  $("payments-note").textContent = !mix
    ? "No payment details for the whole of this period – try a shorter one."
    : state.ds.lines ? "" : "From the till-closing export. Cash is total sales minus the other payment types.";
  if (!mix) { $("payments").replaceChildren(); return; }
  // Five colours at most; anything beyond is folded into "Other"
  const parts = mix.length > 5 ? [...mix.slice(0, 4), mix.slice(4).reduce((a, p) => ({ name: "Other", revenue: a.revenue + p.revenue, share: a.share + p.share }), { revenue: 0, share: 0 })] : mix;
  const total = parts.reduce((a, p) => a + p.revenue, 0);
  donut($("payments"), parts.map((p) => ({ label: p.name, value: p.revenue, share: p.share, display: money.format(p.revenue) })), {
    animate: state.animate,
    ariaLabel: "Share of sales by payment type",
    centerValue: new Intl.NumberFormat(CONFIG.locale, { style: "currency", currency: state.ds.currency, currencyDisplay: "narrowSymbol", notation: "compact", maximumFractionDigits: 2 }).format(total),
    centerLabel: "total",
    formatShare: (s) => pct.format(s),
  });
}

function renderMissing() {
  const ds = state.ds;
  if (ds.lines) return;
  const missing = [
    "Busy hours (the exports have no sale times)",
    "Number of orders and average order value",
  ];
  if (!ds.daily.some((d) => d.payments)) missing.push("Payment types (add a till-closing export)");
  if (!ds.daily.some((d) => d.refund != null)) missing.push("Refunds (add a ticket journal export)");
  if (!ds.products) missing.unshift("Best sellers and categories (add a product-sold export)");
  else missing.push("Best sellers for the period you pick (product totals cover one fixed period)");
  $("missing-list").replaceChildren(...missing.map((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    return li;
  }));
  $("missing-card").hidden = false;
}

function renderFiles() {
  const used = state.ds.files.filter((f) => f.used).length;
  $("files-count").textContent = state.ds.files.length ? `${whole.format(state.ds.files.length)} file${state.ds.files.length === 1 ? "" : "s"}, ${whole.format(used)} used` : "Where the figures come from";
  $("files").replaceChildren(...state.ds.files.map((f) => {
    const li = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = f.type;
    const status = document.createElement("span");
    status.className = f.used ? "file-used" : "file-skipped";
    status.textContent = f.used ? " used" : " not used";
    const detail = document.createElement("div");
    detail.className = "muted";
    detail.textContent = `${f.file}${f.note ? ` — ${f.note}` : ""}`;
    li.append(name, status, detail);
    return li;
  }));
}

function fillTable(table, headers, rows) {
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const h of headers) { const th = document.createElement("th"); th.textContent = h; hr.appendChild(th); }
  thead.appendChild(hr);
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const c of r) { const td = document.createElement("td"); td.textContent = c; tr.appendChild(td); }
    tbody.appendChild(tr);
  }
  table.replaceChildren(thead, tbody);
}

// Small, dependency-free charts drawn with SVG and HTML, with entrance animations.
// Animations are CSS-driven (see styles.css) and switched off for people who ask
// their device to reduce motion.

const SVG_NS = "http://www.w3.org/2000/svg";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let uid = 0;

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value / 4));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * exp * 4 >= value) * exp;
  return step * 4;
}

// Column path with a 4px rounded top, flat on the baseline.
function columnPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// Smooth line through points that never overshoots (monotone cubic interpolation).
function smoothPath(pts) {
  if (pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join("");
  const n = pts.length;
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let path = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (pts[i + 1][0] - pts[i][0]) / 3;
    path += `C${pts[i][0] + h},${pts[i][1] + m[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - m[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return path;
}

// Charts animate the first time they appear and when the data changes; plain
// re-draws (e.g. after resizing the window) are instant.
function setAnimated(el, animate) {
  el.classList.toggle("animate", animate && !reduceMotion.matches);
}

function attachTooltip(container) {
  let tip = container.querySelector(":scope > .tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tooltip";
    tip.setAttribute("role", "status");
    container.appendChild(tip);
  }
  return {
    show(lines, x, y) {
      tip.replaceChildren(
        ...lines.map((text, i) => {
          const div = document.createElement("div");
          div.className = i === 0 ? "tooltip-value" : "tooltip-label";
          div.textContent = text;
          return div;
        })
      );
      tip.classList.add("visible");
      const max = container.clientWidth - tip.offsetWidth - 4;
      tip.style.left = `${Math.max(4, Math.min(max, x - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 12)}px`;
    },
    hide() { tip.classList.remove("visible"); },
  };
}

/**
 * Vertical columns, optionally with a smooth line on top (e.g. a 7-day average).
 * points: [{ value, line?, partial?, ... }]
 * opts: { formatTick, xLabel(p, i), tooltip(p), highlight?(p) -> bool, animate?, height? }
 */
export function columnChart(container, points, opts) {
  const plot = container.querySelector(".plot") ?? container;
  plot.querySelector("svg")?.remove();
  setAnimated(plot, opts.animate ?? true);
  const width = Math.max(plot.clientWidth, 280);
  const height = opts.height ?? (width < 500 ? 200 : 250);
  const m = { top: 14, right: 6, bottom: 28, left: 48 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;

  const maxValue = niceMax(Math.max(...points.map((p) => Math.max(p.value, p.line ?? 0)), 0));
  const y = (v) => m.top + innerH - (v / maxValue) * innerH;
  const slot = innerW / Math.max(points.length, 1);
  const gap = slot > 14 ? Math.min(10, slot * 0.28) : slot > 6 ? 2 : 1;
  const barW = Math.max(slot - gap, 1);
  const id = `g${++uid}`;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": opts.ariaLabel ?? "" });
  const defs = svgEl("defs");
  defs.innerHTML = `
    <linearGradient id="${id}-bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--accent-hi)"/><stop offset="1" stop-color="var(--accent)"/>
    </linearGradient>`;
  svg.appendChild(defs);

  for (let i = 0; i <= 4; i++) {
    const v = (maxValue / 4) * i;
    svg.appendChild(svgEl("line", { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: i ? "gridline" : "baseline" }));
    const t = svgEl("text", { x: m.left - 10, y: y(v) + 4, class: "tick", "text-anchor": "end" });
    t.textContent = opts.formatTick(v);
    svg.appendChild(t);
  }

  const bars = svgEl("g", { class: "bars" });
  points.forEach((p, i) => {
    const x = m.left + i * slot + gap / 2;
    const h = Math.max(0, m.top + innerH - y(p.value));
    if (h > 0) {
      const cls = ["bar", p.partial && "bar-partial", opts.highlight?.(p) && "bar-highlight"].filter(Boolean).join(" ");
      const bar = svgEl("path", { d: columnPath(x, y(p.value), barW, h), class: cls, fill: p.partial ? null : `url(#${id}-bar)`, "data-i": i });
      bar.style.setProperty("--delay", `${Math.min(i * (600 / Math.max(points.length, 1)), 600)}ms`);
      bars.appendChild(bar);
    }
    const label = opts.xLabel?.(p, i);
    if (label) {
      const t = svgEl("text", { x: x + barW / 2, y: height - 8, class: "tick", "text-anchor": "middle" });
      t.textContent = label;
      svg.appendChild(t);
    }
  });
  svg.appendChild(bars);

  const linePts = points.map((p, i) => (p.line == null ? null : [m.left + i * slot + slot / 2, y(p.line)])).filter(Boolean);
  if (linePts.length > 1) {
    svg.appendChild(svgEl("path", { d: smoothPath(linePts), class: "trend-glow", pathLength: 1 }));
    svg.appendChild(svgEl("path", { d: smoothPath(linePts), class: "trend-line", pathLength: 1 }));
  }

  // Hover / tap targets: the full column height, wider than the bar itself.
  const tip = attachTooltip(plot);
  const marker = svgEl("line", { y1: m.top, y2: m.top + innerH, class: "hover-line", visibility: "hidden" });
  svg.appendChild(marker);
  const setActive = (i) => {
    bars.classList.toggle("has-active", i != null);
    for (const b of bars.children) b.classList.toggle("active", Number(b.dataset.i) === i);
  };
  points.forEach((p, i) => {
    const x = m.left + i * slot;
    const hit = svgEl("rect", { x, y: m.top, width: slot, height: innerH, class: "hit", tabindex: points.length <= 31 ? 0 : -1 });
    const show = () => {
      marker.setAttribute("x1", x + slot / 2);
      marker.setAttribute("x2", x + slot / 2);
      marker.setAttribute("visibility", "visible");
      setActive(i);
      tip.show(opts.tooltip(p), ((x + slot / 2) / width) * plot.clientWidth, (y(Math.max(p.value, p.line ?? 0)) / height) * svg.clientHeight);
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("focus", show);
    svg.appendChild(hit);
  });
  const hide = () => { tip.hide(); marker.setAttribute("visibility", "hidden"); setActive(null); };
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("focusout", hide);

  plot.prepend(svg);
}

/**
 * Several lines over the same days, e.g. products side by side, in the series-1…5 colours.
 * series: [{ label, values: [number | null], className? }], each with `count` values
 * (null = no figure); className replaces the series colour, e.g. for a total line
 * opts: { formatTick, xLabel(i), tooltip(i) -> lines, animate?, ariaLabel, height? }
 */
export function lineChart(container, count, series, opts) {
  const plot = container.querySelector(".plot") ?? container;
  plot.querySelector("svg")?.remove();
  setAnimated(plot, opts.animate ?? true);
  const width = Math.max(plot.clientWidth, 280);
  const height = opts.height ?? (width < 500 ? 200 : 250);
  const m = { top: 14, right: 10, bottom: 28, left: 48 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;

  const maxValue = niceMax(Math.max(...series.flatMap((s) => s.values.filter((v) => v != null)), 0));
  const y = (v) => m.top + innerH - (v / maxValue) * innerH;
  const slot = innerW / Math.max(count, 1);
  const x = (i) => m.left + i * slot + slot / 2;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": opts.ariaLabel ?? "" });
  for (let i = 0; i <= 4; i++) {
    const v = (maxValue / 4) * i;
    svg.appendChild(svgEl("line", { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: i ? "gridline" : "baseline" }));
    const t = svgEl("text", { x: m.left - 10, y: y(v) + 4, class: "tick", "text-anchor": "end" });
    t.textContent = opts.formatTick(v);
    svg.appendChild(t);
  }
  for (let i = 0; i < count; i++) {
    const label = opts.xLabel?.(i);
    if (!label) continue;
    const t = svgEl("text", { x: x(i), y: height - 8, class: "tick", "text-anchor": "middle" });
    t.textContent = label;
    svg.appendChild(t);
  }

  // A line per series, broken where there's no figure
  const cls = (s, n) => s.className ?? `series-${n + 1}`;
  series.forEach((s, n) => {
    const runs = [[]];
    s.values.forEach((v, i) => (v == null ? runs.push([]) : runs[runs.length - 1].push([x(i), y(v)])));
    for (const run of runs) {
      if (run.length > 1) svg.appendChild(svgEl("path", { d: smoothPath(run), class: `series-line ${cls(s, n)}`, pathLength: 1 }));
      else if (run.length === 1) svg.appendChild(svgEl("circle", { cx: run[0][0], cy: run[0][1], r: 3, class: `series-dot ${cls(s, n)}` }));
    }
  });

  const tip = attachTooltip(plot);
  const marker = svgEl("line", { y1: m.top, y2: m.top + innerH, class: "hover-line", visibility: "hidden" });
  svg.appendChild(marker);
  const dots = series.map((s, n) => svg.appendChild(svgEl("circle", { r: 4, class: `series-dot ${cls(s, n)}`, visibility: "hidden" })));
  for (let i = 0; i < count; i++) {
    const hit = svgEl("rect", { x: m.left + i * slot, y: m.top, width: slot, height: innerH, class: "hit", tabindex: count <= 31 ? 0 : -1 });
    const show = () => {
      marker.setAttribute("x1", x(i));
      marker.setAttribute("x2", x(i));
      marker.setAttribute("visibility", "visible");
      series.forEach((s, n) => {
        const v = s.values[i];
        dots[n].setAttribute("visibility", v == null ? "hidden" : "visible");
        if (v != null) { dots[n].setAttribute("cx", x(i)); dots[n].setAttribute("cy", y(v)); }
      });
      const top = Math.max(...series.map((s) => s.values[i] ?? 0));
      tip.show(opts.tooltip(i), (x(i) / width) * plot.clientWidth, (y(top) / height) * svg.clientHeight);
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("focus", show);
    svg.appendChild(hit);
  }
  const hide = () => { tip.hide(); marker.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); };
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("focusout", hide);

  plot.prepend(svg);
}

/**
 * Horizontal bar list – a ranked list where each row has a label, a bar and a value.
 * items: [{ label, sublabel?, value, display }]   opts: { ranked?, animate?, onSelect?(item), max? }
 * Bars are scaled to the largest value, or to `max` if given.
 * With onSelect, each row is a button.
 */
export function barList(container, items, opts = {}) {
  setAnimated(container, opts.animate ?? true);
  const max = opts.max || Math.max(...items.map((i) => i.value), 0) || 1;
  const list = document.createElement("ol");
  list.className = "bar-list" + (opts.ranked ? " ranked" : "");
  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.style.setProperty("--delay", `${i * 45}ms`);
    let row = li;
    if (opts.onSelect) {
      row = document.createElement("button");
      row.type = "button";
      row.className = "bar-list-row";
      row.addEventListener("click", () => opts.onSelect(item));
      li.appendChild(row);
    }
    if (opts.ranked) {
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = String(i + 1);
      row.appendChild(rank);
    }
    const body = document.createElement("div");
    body.className = "bar-list-body";
    const head = document.createElement("div");
    head.className = "bar-list-head";
    const name = document.createElement("span");
    name.className = "bar-list-label";
    name.textContent = item.label;
    const value = document.createElement("span");
    value.className = "bar-list-value";
    value.textContent = item.display;
    head.append(name, value);
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max((item.value / max) * 100, 0.5)}%`;
    track.appendChild(fill);
    body.append(head, track);
    if (item.sublabel) {
      const sub = document.createElement("div");
      sub.className = "bar-list-sub";
      sub.textContent = item.sublabel;
      body.appendChild(sub);
    }
    row.appendChild(body);
    list.appendChild(li);
  });
  container.replaceChildren(list);
}

/**
 * Donut for parts of a whole (up to 5 parts; more are folded into "Other" by the caller).
 * items: [{ label, value, display, share }]   opts: { centerValue, centerLabel, formatShare, animate? }
 */
export function donut(container, items, opts) {
  setAnimated(container, opts.animate ?? true);
  const size = 180, stroke = 26, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const total = items.reduce((a, i) => a + i.value, 0) || 1;
  const wrap = document.createElement("div");
  wrap.className = "donut";
  const figure = document.createElement("div");
  figure.className = "donut-figure";
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": opts.ariaLabel ?? "" });
  svg.appendChild(svgEl("circle", { cx: size / 2, cy: size / 2, r, class: "donut-track", "stroke-width": stroke }));
  const gapLen = items.length > 1 ? 3 : 0; // a 2px surface gap between segments
  let offset = 0;
  items.forEach((item, i) => {
    const len = (item.value / total) * c;
    const seg = svgEl("circle", {
      cx: size / 2, cy: size / 2, r,
      class: `donut-seg series-${i + 1}`,
      "stroke-width": stroke,
      "stroke-dasharray": `${Math.max(len - gapLen, 0.01)} ${c}`,
      "stroke-dashoffset": -offset,
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    });
    seg.style.setProperty("--len", Math.max(len - gapLen, 0.01));
    seg.style.setProperty("--delay", `${i * 120}ms`);
    svg.appendChild(seg);
    offset += len;
  });
  const center = document.createElement("div");
  center.className = "donut-center";
  const cv = document.createElement("strong");
  cv.textContent = opts.centerValue;
  const cl = document.createElement("span");
  cl.textContent = opts.centerLabel;
  center.append(cv, cl);
  figure.append(svg, center);

  const legend = document.createElement("ul");
  legend.className = "donut-legend";
  items.forEach((item, i) => {
    const li = document.createElement("li");
    const key = document.createElement("span");
    key.className = `legend-dot series-${i + 1}`;
    const name = document.createElement("span");
    name.className = "legend-name";
    name.textContent = item.label;
    const share = document.createElement("span");
    share.className = "legend-share";
    share.textContent = opts.formatShare(item.share);
    const value = document.createElement("span");
    value.className = "legend-value";
    value.textContent = item.display;
    li.append(key, name, share, value);
    legend.appendChild(li);
  });
  wrap.append(figure, legend);
  container.replaceChildren(wrap);
}

/** Tiny area chart for a headline card. values: numbers; highlight the last point. */
export function sparkline(container, values, opts = {}) {
  setAnimated(container, opts.animate ?? true);
  const w = 240, h = 48, pad = 4;
  const max = Math.max(...values, 0) || 1;
  const min = Math.min(...values, 0);
  const pts = values.map((v, i) => [pad + (i / Math.max(values.length - 1, 1)) * (w - pad * 2), h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2)]);
  const id = `s${++uid}`;
  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", class: "spark", "aria-hidden": "true" });
  svg.innerHTML = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>`;
  if (pts.length > 1) {
    const line = smoothPath(pts);
    svg.appendChild(svgEl("path", { d: `${line}L${pts[pts.length - 1][0]},${h}L${pts[0][0]},${h}Z`, fill: `url(#${id})`, class: "spark-area" }));
    svg.appendChild(svgEl("path", { d: line, class: "spark-line", pathLength: 1 }));
    const last = pts[pts.length - 1];
    svg.appendChild(svgEl("circle", { cx: last[0], cy: last[1], r: 3.5, class: "spark-dot" }));
  }
  container.replaceChildren(svg);
}

/** Circular gauge, e.g. "today so far" against last week's whole day. ratio: 0..1+ */
export function progressRing(container, ratio, opts = {}) {
  setAnimated(container, opts.animate ?? true);
  const size = 64, stroke = 7, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(ratio, 1));
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, class: "ring", "aria-hidden": "true" });
  svg.appendChild(svgEl("circle", { cx: size / 2, cy: size / 2, r, class: "ring-track", "stroke-width": stroke }));
  const arc = svgEl("circle", {
    cx: size / 2, cy: size / 2, r, class: "ring-arc", "stroke-width": stroke,
    "stroke-dasharray": `${shown * c} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})`,
  });
  arc.style.setProperty("--len", shown * c);
  svg.appendChild(arc);
  const label = svgEl("text", { x: size / 2, y: size / 2 + 4, "text-anchor": "middle", class: "ring-label" });
  label.textContent = opts.label ?? "";
  svg.appendChild(label);
  container.replaceChildren(svg);
}

/** Counts a number up to its value. format: (n) => string */
export function countUp(el, value, format, { animate = true, duration = 900 } = {}) {
  cancelAnimationFrame(el._countUp);
  if (!animate || reduceMotion.matches || !isFinite(value)) { el.textContent = format(value); return; }
  const start = performance.now();
  const from = el._countValue ?? 0;
  const tick = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 4);
    el.textContent = format(from + (value - from) * eased);
    if (t < 1) el._countUp = requestAnimationFrame(tick);
  };
  el._countValue = value;
  el._countUp = requestAnimationFrame(tick);
}

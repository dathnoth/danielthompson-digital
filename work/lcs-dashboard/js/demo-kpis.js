// Demo only: every number in a Today-tab KPI shows 1s (amounts read 11), and
// the three headline values are fixed at 11,
// so the case study shows the layout without anything that reads like real figures.
// Runs over whatever dashboard.js writes, including the count-up animation.
(() => {
  const KPIS = [
    ["1", ["kpi-today", "kpi-today-change", "kpi-today-progress", "kpi-today-usual", "kpi-today-stats"]],
    ["1", ["kpi-yesterday", "kpi-yesterday-change", "kpi-yesterday-detail", "kpi-yesterday-visitors"]],
    ["1", ["kpi-month", "kpi-month-change", "kpi-month-detail"]],
  ];
  const HEADLINES = { "kpi-today": "11", "kpi-yesterday": "11", "kpi-month": "11" };
  const swapDigits = (text, digit) => text.replace(/\d/g, digit);

  function apply(node, digit) {
    const fixed = HEADLINES[node.id];
    // The headline: the whole number (digits, commas, decimals) becomes the fixed figure
    const swap = fixed ? (text) => text.replace(/\d[\d,.]*/g, fixed) : (text) => swapDigits(text, digit);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const next = swap(t.nodeValue);
      if (next !== t.nodeValue) t.nodeValue = next;
    }
    for (const attr of ["aria-label", "title"]) {
      const v = node.getAttribute(attr);
      if (v && swap(v) !== v) node.setAttribute(attr, swap(v));
    }
  }

  function start() {
    for (const [digit, ids] of KPIS) {
      for (const id of ids) {
        const node = document.getElementById(id);
        if (!node) continue;
        apply(node, digit);
        new MutationObserver(() => apply(node, digit)).observe(node, {
          subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "title"],
        });
      }
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

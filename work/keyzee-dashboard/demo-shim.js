/* Keyzee dashboard — portfolio demo shim.
   Every API call is answered here with dummy data; nothing reaches the real worker, Odoo or Claude. */
(() => {
  localStorage.setItem('kz_dash_token', 'demo');
  localStorage.setItem('kz_night', '1');
  localStorage.setItem('kz_tab', 'sales');
  ['kz_claude_key', 'kz_oc_prompt', 'kz_oc_model'].forEach(k => localStorage.removeItem(k));

  // Deterministic random numbers, seeded per request so the same range gives the same numbers
  const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) || 1; };
  const rng = seed => { let x = hash(seed); return () => (x = Math.imul(x ^ (x >>> 15), 2246822507) >>> 0, (x % 100000) / 100000); };
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const spanDays = (from, to) => Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  const pct = (n, t) => t ? Math.round(n / t * 100) : 0;
  const buckets = (total, a, b) => { const w3 = Math.round(total * a), w10 = Math.round(total * b), ov = Math.max(0, total - w3 - w10); return { total, within3: w3, within10: w10, over10: ov, within3Pct: pct(w3, total), within10Pct: pct(w10, total), over10Pct: Math.max(0, 100 - pct(w3, total) - pct(w10, total)) }; };
  const now = () => new Date().toISOString();

  const NAMES = {
    customers: ['Sample Realty Group', 'Demo Strata Services', 'Example Property Co.', 'Placeholder Agents', 'Test Body Corporate'],
    products: ['Standard key copy', 'Restricted security key', 'Proximity fob', 'Garage remote', 'Mailbox key'],
    categories: ['Keys', 'Fobs & cards', 'Remotes', 'Mailbox', 'Services'],
    reasons: ['Spare required', 'New tenant', 'Lost key', 'Damaged fob', 'Lock change'],
    agents: ['Alex Demo', 'Sam Sample', 'Jordan Test', 'Casey Placeholder'],
    suppliers: ['Demo Lock Supplies', 'Sample Hardware Co.', 'Example Remote Makers', 'Placeholder Blanks Ltd'],
    ocs: ['Sample Towers OC', 'Demo Gardens Owners Corporation', 'Example Quay OC', 'Placeholder Heights OC', 'Test Park Residences OC'],
  };

  function sales(from, to) {
    const r = rng('sales' + from + to), days = spanDays(from, to);
    const revenue = Math.round(days * 6000 * (0.9 + r() * 0.2)), count = Math.round(revenue / (165 + r() * 18));
    const prevRevenue = Math.round(revenue / (1.02 + r() * 0.12)), prevCount = Math.round(count / (0.98 + r() * 0.1));
    const received = Math.round(count * 1.22), approved = count, completed = Math.round(count * (0.7 + r() * 0.12));
    const daily = []; const end = new Date(); const rd = rng('daily');
    for (let i = 420; i >= 0; i--) { const d = new Date(end); d.setDate(d.getDate() - i); const dow = d.getDay(); if (dow === 0) continue;
      const season = 1 + 0.22 * Math.sin((d.getMonth() + 2) / 12 * Math.PI * 2);
      daily.push({ day: ymd(d), revenue: Math.round((dow === 6 ? 2400 : 7200) * season * (0.75 + rd() * 0.5) * (1 + (420 - i) / 1400)) }); }
    const rank = (names, base, key) => names.map((name, i) => ({ name, revenue: Math.round(revenue * base[i] * (0.9 + r() * 0.2)), [key]: Math.max(1, Math.round(count * base[i] * (0.9 + r() * 0.2))) }));
    return {
      _cachedAt: now(), revenue, count, prevRevenue, prevCount,
      ordersReceived: received, prevOrdersReceived: Math.round(received / (1.05 + r() * 0.1)),
      ordersApproved: approved, prevOrdersApproved: Math.round(approved / (1.04 + r() * 0.1)),
      ordersCompleted: completed, prevOrdersCompleted: Math.round(completed / (0.92 + r() * 0.2)),
      fulfilment: Object.assign(buckets(completed, 0.66 + r() * 0.08, 0.24), { avgDays: -(0.3 + r() * 0.9) }),
      fulfilmentByType: { keys: buckets(Math.round(completed * .58), .74, .2), fobs: buckets(Math.round(completed * .3), .6, .3), remotes: buckets(Math.round(completed * .12), .52, .34) },
      itemsSent: { keys: Math.round(count * 2.3), fobs: Math.round(count * 0.7), remotes: Math.round(count * 0.19) },
      ordersByType: { agent: Math.round(received * .41), owner: Math.round(received * .45), tenant: Math.round(received * .14) },
      dailySales: daily,
      topProducts: rank(NAMES.products, [.27, .22, .16, .13, .06], 'count'),
      topCategories: rank(NAMES.categories, [.49, .25, .18, .06, .02], 'orders'),
      topVendors: rank(NAMES.customers, [.09, .075, .058, .045, .036], 'orders'),
      topOrderReasons: rank(NAMES.reasons, [.31, .25, .19, .09, .06], 'orders'),
      refunds: { count: Math.round(days * 1.4 * (0.8 + r() * 0.4)), value: Math.round(days * 160 * (0.8 + r() * 0.4)) },
      activeOrderFulfilment: (() => { const t = 140 + Math.round(r() * 40), on = Math.round(t * .83), d1 = Math.round(t * .11), d2 = Math.round(t * .04), d3 = t - on - d1 - d2;
        return { total: t, onTrack: on, onTrackPct: pct(on, t), delay1_7: d1, delay1_7Pct: pct(d1, t), delay8_14: d2, delay8_14Pct: pct(d2, t), delay14plus: d3, delay14plusPct: pct(d3, t), drilldownUrls: {} }; })(),
    };
  }

  function helpdesk(from, to) {
    const r = rng('hd' + from + to), days = spanDays(from, to), total = Math.round(days * 9 * (0.85 + r() * 0.3));
    const stages = ['New', 'In Progress', 'Waiting On Customer', 'Solved'];
    const vol = []; for (let i = Math.min(days, 60) - 1; i >= 0; i--) { const d = new Date(to); d.setDate(d.getDate() - i); vol.push({ day: ymd(d).slice(5), count: d.getDay() === 0 ? 0 : Math.round(6 + r() * 9) }); }
    return {
      _cachedAt: now(), totalTickets: total, prevTotalTickets: Math.round(total / (0.92 + r() * 0.16)),
      openTickets: 38 + Math.round(r() * 12), unassigned: 3 + Math.round(r() * 4), slaBreaches: 2 + Math.round(r() * 5),
      resolvedTickets: Math.round(total * .86), avgResolutionDays: +(1.2 + r()).toFixed(1),
      csat: { pct: 88 + Math.round(r() * 8), responses: Math.round(total * .18) },
      medianOpenAgeDays: +(1.5 + r() * 2).toFixed(1), oldestActiveDays: 9 + Math.round(r() * 8),
      byAssignee: [...NAMES.agents, 'Unassigned'].map((name, i) => ({ name, stages: Object.fromEntries(stages.map((s, j) => [s, Math.round((i === 4 ? 2 : 6 + r() * 10) * [1, .8, .6, 3][j])])) })),
      dailyVolume: vol,
      byType: [['Order status', .34], ['Lost / replacement', .22], ['Fob programming', .17], ['Delivery', .15], ['Billing', .12]].map(([name, f]) => ({ name, count: Math.round(total * f) })),
      byStage: stages.map((name, i) => ({ name, count: Math.round(total * [.08, .1, .06, .76][i]) })),
    };
  }

  function purchasing() {
    const r = rng('po' + ymd(new Date())), open = 18 + Math.round(r() * 6), on = Math.round(open * .78), del = open - on;
    const pos = []; for (let i = 0; i < 5; i++) { const d = new Date(); d.setDate(d.getDate() + 1 + i); pos.push({ name: `PO-DEMO-${String(1040 + i * 7)}`, supplier: NAMES.suppliers[i % 4], date: ymd(d), amount: Math.round(800 + r() * 5200) + 0.5 }); }
    return { _cachedAt: now(), openPo: open, openRfq: 4 + Math.round(r() * 4), onTrack: on, onTrackPct: pct(on, open), delayed: del, delayedPct: pct(del, open), etaSoon: pos.length, etaSoonPos: pos };
  }

  function warehouse() {
    const r = rng('wh' + ymd(new Date())), picked = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); if (d.getDay() === 0) continue; picked.push({ day: ymd(d), count: Math.round((d.getDay() === 6 ? 12 : 38) * (0.75 + r() * 0.5)) }); }
    return { _cachedAt: now(), ordersReady: 46 + Math.round(r() * 10), processingOrders: 128 + Math.round(r() * 20), readyToManufacture: 31 + Math.round(r() * 8), stuckOrders: 11, stuckUnder10: 7, stuck1119: 3, stuckOver20: 1, medianDeliveryHours: 30 + r() * 12, medianMfgHours: 5 + r() * 4, dailyPicked: picked };
  }

  function oc(from, to, id) {
    const r = rng('oc' + from + to + id), days = spanDays(from, to), received = Math.round(days * 1.3 * (0.8 + r() * 0.4)), approved = Math.round(received * .9), completed = Math.round(approved * .86);
    const f = buckets(completed, .7, .23);
    return {
      _cachedAt: now(), received, receivedChg: +(r() * 24 - 6).toFixed(1), approved, approvedChg: +(r() * 20 - 5).toFixed(1), completed, completedChg: +(r() * 22 - 4).toFixed(1),
      fulfilment: { avg: +(2.1 + r()).toFixed(1), quickest: 1, longest: 9 + Math.round(r() * 5), count: completed, within3: f.within3, within10: f.within10, over10: f.over10, within3Pct: f.within3Pct, within10Pct: f.within10Pct, over10Pct: f.over10Pct },
      prevFulfilment: { avg: +(2.4 + r()).toFixed(1), quickest: 1, longest: 12 },
      items: (() => { const k = Math.round(completed * 2.1), fo = Math.round(completed * .6), re = Math.round(completed * .15); return { keys: k, fobs: fo, remotes: re, total: k + fo + re }; })(),
      ordersByType: (() => { const a = Math.round(received * .4), o = Math.round(received * .46), t = received - a - o; return { agent: a, owner: o, tenant: t, total: received }; })(),
      deviceBuckets: { keys: { within3: Math.round(f.within3 * .6), within10: Math.round(f.within10 * .55), over10: Math.round(f.over10 * .5) }, fobs: { within3: Math.round(f.within3 * .3), within10: Math.round(f.within10 * .32), over10: Math.round(f.over10 * .35) }, remotes: { within3: Math.round(f.within3 * .1), within10: Math.round(f.within10 * .13), over10: Math.round(f.over10 * .15) } },
      tickets: { open: 2 + Math.round(r() * 3), closed: 9 + Math.round(r() * 8), avgRespond: +(1.5 + r() * 2).toFixed(1), avgClose: +(1 + r()).toFixed(1), closingRate: 86 + Math.round(r() * 10) },
      survey: { sent: Math.round(completed * .9), completed: Math.round(completed * .28), partial: Math.round(completed * .05), responseRate: 31 + Math.round(r() * 8), npsScore: 58 + Math.round(r() * 20) },
    };
  }

  function nps(from, to) {
    const r = rng('nps' + from + to), days = spanDays(from, to), sent = Math.round(days * 22), completed = Math.round(sent * (.27 + r() * .06));
    const pro = Math.round(completed * .71), det = Math.round(completed * .08), pas = completed - pro - det;
    const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d) + ' 09:30:00'; };
    const comments = [
      ['Keys arrived two days after ordering. Really easy process.', 'Alex Demo (sample)'],
      ['Fob worked first time. Great communication throughout.', 'Sam Sample (sample)'],
      ['Took a little longer than expected but support kept me updated.', 'Jordan Test (sample)'],
      ['So much easier than going through the building manager.', 'Casey Placeholder (sample)'],
    ];
    return { _cachedAt: now(), sent, completed, partial: Math.round(completed * .14), responseRate: pct(completed, sent), npsScore: pct(pro, completed) - pct(det, completed),
      promoters: pro, passives: pas, detractors: det, promotersPct: pct(pro, completed), passivesPct: pct(pas, completed), detractorsPct: pct(det, completed),
      recentComments: comments.map(([text, contact], i) => ({ text, contact, createDate: ago(i * 2 + 1), saleOrderId: null, saleOrderName: '', inputId: null })) };
  }

  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, opts) => {
    const url = new URL(String(input), location.href);
    if (url.hostname === 'demo.invalid') {
      const q = url.searchParams, from = q.get('from') || ymd(new Date(Date.now() - 30 * 864e5)), to = q.get('to') || ymd(new Date());
      const routes = {
        '/api/sales': () => sales(from, to),
        '/api/helpdesk': () => helpdesk(from, to),
        '/api/purchasing': purchasing,
        '/api/warehouse': warehouse,
        '/api/oc': () => oc(from, to, q.get('oc_id')),
        '/api/oc-search': () => NAMES.ocs.map((name, i) => ({ id: 1001 + i, name })).filter(o => o.name.toLowerCase().includes((q.get('q') || '').toLowerCase())),
        '/api/nps': () => nps(from, to),
        '/api/sync': () => ({ ok: true, _cachedAt: now() }),
      };
      const handler = routes[url.pathname];
      return new Promise(res => setTimeout(() => res(handler ? json(handler()) : json({ error: 'Unknown demo route' })), 250));
    }
    if (url.hostname.endsWith('anthropic.com')) return Promise.resolve(new Response(JSON.stringify({ error: { message: 'AI summaries are disabled in this demo.' } }), { status: 403 }));
    return realFetch(input, opts);
  };

  // Links into Odoo are disabled: show a toast instead
  const isOdoo = u => /keyzee\.(com\.au|odoo\.com)/.test(String(u || ''));
  function toast(msg) {
    let t = document.getElementById('demo-toast');
    if (!t) { t = document.createElement('div'); t.id = 'demo-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400);
  }
  window.demoToast = toast;
  const realOpen = window.open.bind(window);
  window.open = (u, ...rest) => isOdoo(u) ? (toast('Links to Odoo are disabled in this demo'), null) : realOpen(u, ...rest);
  document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('a[href]'); if (a && isOdoo(a.href)) { e.preventDefault(); toast('Links to Odoo are disabled in this demo'); } }, true);
})();

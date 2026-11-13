// MarketMind AI — Home cockpit: market mood, "Today" action strip, My money (all broker accounts), risk meter.
// Cockpit.render(el) fills a container; each block loads on its own and fails quietly.
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = (v, d = 0) => (v == null || !isFinite(v) ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }));
  const pct = v => (v == null || !isFinite(v) ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  const nv = v => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
  const pick = (r, ks) => { for (const k of ks) if (nv(r[k]) != null) return nv(r[k]); return null; };
  const isAdmin = () => !!(root.Account && Account.isAdmin);
  async function j(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
    const x = await r.json().catch(() => null);
    if (!r.ok || !x) throw Object.assign(new Error((x && x.error) || `HTTP ${r.status}`), { needsLogin: !!(x && x.needsLogin) });
    return x;
  }
  const closesOf = c => { const r = c.chart && c.chart.result && c.chart.result[0]; return r ? (r.indicators.quote[0].close || []).filter(v => v != null) : []; };
  const avg = (a, n, end) => (end + 1 < n ? null : a.slice(end - n + 1, end + 1).reduce((s, v) => s + v, 0) / n);

  // ---------- market mood: NIFTY vs its 50/200-day averages, 200-day slope, India VIX ----------
  const MOODS = [
    ['up', 'Uptrend', 'normal position size'],
    ['warn', 'Careful', 'smaller size, only the strongest setups'],
    ['down', 'Stay out', 'no new buys while NIFTY is below its 200-day average'],
  ];
  async function mood(el) {
    try {
      const [n, v] = await Promise.all([j('api/chart.php?symbol=%5ENSEI&interval=1d&range=1y'), j('api/chart.php?symbol=%5EINDIAVIX&interval=1d&range=5d').catch(() => null)]);
      const c = closesOf(n), i = c.length - 1, last = c[i];
      const s50 = avg(c, 50, i), s200 = avg(c, 200, i), s200ago = avg(c, 200, i - 20);
      const vix = v ? closesOf(v).slice(-1)[0] : null;
      let lvl = s200 == null ? 1 : last < s200 ? 2 : (last < s50 || s50 < s200 || (s200ago && s200 < s200ago)) ? 1 : 0;
      if (vix > 20 && lvl < 2) lvl++;
      const [cls, label, hint] = MOODS[lvl];
      document.body.dataset.mood = cls;
      el.innerHTML = `<div class="mood mood-${cls}"><b>${label}</b><span>${hint}</span>
        <small>NIFTY ${Math.round(last).toLocaleString('en-IN')} · 50-DMA ${Math.round(s50).toLocaleString('en-IN')} · 200-DMA ${s200 ? Math.round(s200).toLocaleString('en-IN') : '—'}${vix ? ` · VIX ${vix.toFixed(1)}` : ''}</small></div>`;
    } catch { el.innerHTML = ''; }
  }

  // ---------- today: things that need you ----------
  async function today(el, ctx) {
    const items = [];
    try {
      const b = await j('api/brokers.php?action=list');
      ctx.brokers = b;
      if (b.main && !b.main.connectedToday) items.push(`<a class="act" href="api/breeze.php?action=login">Log in to ICICI · main</a>`);
      b.accounts.filter(a => !a.connectedToday).forEach(a => items.push(`<a class="act" href="api/brokers.php?action=login&id=${a.id}">Log in to ${esc(a.label)}</a>`));
    } catch { /* brokers optional */ }
    if (isAdmin()) {
      try {
        const st = await j('api/trade.php?action=state');
        ctx.trade = st;
        const n = st.orders.filter(o => o.status === 'pending').length;
        if (n) items.unshift(`<button class="act attn" data-go="trading">${n} order${n > 1 ? 's' : ''} to approve</button>`);
      } catch { /* trading optional */ }
      try {
        const u = await j('api/users.php?action=list');
        const n = u.users.filter(x => x.approvalStatus === 'pending').length;
        if (n) items.push(`<button class="act" data-users>${n} sign-up${n > 1 ? 's' : ''} waiting</button>`);
      } catch { /* ignore */ }
    }
    el.innerHTML = items.length ? `<div class="today"><b>Today</b>${items.join('')}</div>` : '';
    el.querySelectorAll('[data-users]').forEach(x => (x.onclick = () => Account.openUsers()));
  }

  // ---------- my money across connected accounts ----------
  const POS = new Map(); // symbol -> current value, across accounts (for the X-ray)
  const WHERE = new Map(); // symbol -> account labels holding it
  function sumHoldings(h) {
    const src = h.holdings && h.holdings.length ? h.holdings : (h.demat || []);
    let inv = 0, val = 0, n = 0;
    for (const r of src) {
      const q = pick(r, ['quantity', 'demat_avail_quantity', 'demat_total_bulk_quantity']), a = pick(r, ['average_price', 'avg_price', 'purchase_price']), l = pick(r, ['current_market_price', 'ltp']);
      if (!(q > 0)) continue;
      n++;
      if (a && l) { inv += a * q; val += l * q; }
      const sym = (h.symbols || {})[String(r.stock_code || '').toUpperCase()] || String(r.stock_code || '').toUpperCase();
      if (l) POS.set(sym, (POS.get(sym) || 0) + l * q);
      if (h._label) { if (!WHERE.has(sym)) WHERE.set(sym, new Set()); WHERE.get(sym).add(h._label); }
    }
    return { inv, val, n };
  }

  // ---------- cash planner: free cash across accounts and how many trades it covers ----------
  async function cash(el, accts, ctx) {
    if (!el) return;
    const res = await Promise.all(accts.map(async a => { try { return { label: a.label, ...(await j(a.url.replace('action=holdings', 'action=funds'))) }; } catch (e) { return { label: a.label, err: e.message }; } }));
    const free = res.reduce((s, r) => s + (r.free != null ? r.free : (r.bank || 0)), 0);
    const st = ctx.trade && ctx.trade.settings, per = st ? +st.maxPerTrade || 25000 : 25000, risk = st ? (+st.account || 100000) * (+st.riskPct || 1) / 100 : null;
    el.innerHTML = `<div class="money-total"><div><span>Free cash</span><b>${rs(free)}</b></div><div><span>Trades it covers</span><b>${Math.floor(free / per)}</b></div>${risk ? `<div><span>Risk a trade</span><b>${rs(risk)}</b></div>` : ''}</div>
      <ul class="q-list">${res.map(r => `<li><div><b>${esc(r.label)}</b><small>${r.err ? esc(r.err) : `equity ${rs(r.equity)} · F&amp;O ${rs(r.fno)}`}</small></div><div class="q-num"><span>${r.err ? '' : rs(r.free != null ? r.free : r.bank)}</span></div></li>`).join('')}</ul>
      <p class="citation">Trades covered = free cash ÷ ${rs(per)} (your largest order size).</p>`;
  }

  // ---------- portfolio X-ray: sector split, biggest holdings, size mix ----------
  const PAL = ['#2b59c3', '#0b8a52', '#b9520c', '#6a44bd', '#0b6f8a', '#cf3b2f', '#9a6205', '#5b6b7c', '#c2418f', '#3a8f3a'];
  async function xray(el) {
    if (!el) return;
    if (!POS.size) { el.innerHTML = '<p class="home-empty">Shows once a broker account is connected today.</p>'; return; }
    let d = null; try { d = await j('api/overview.php?action=market'); } catch { /* sectors unknown */ }
    const info = new Map((d ? d.rows : []).map(r => [r[0], { g: r[1], i: r[2] }]));
    const total = [...POS.values()].reduce((a, b) => a + b, 0);
    const by = (f) => { const m = new Map(); POS.forEach((v, s) => { const k = f(s); m.set(k, (m.get(k) || 0) + v); }); return [...m].sort((a, b) => b[1] - a[1]); };
    const sec = by(s => (info.get(s) && d.sectors[info.get(s).i] ? d.sectors[info.get(s).i].short : 'Other'));
    const size = by(s => (info.get(s) ? ((d.groups[info.get(s).g] || {}).size || 'Other') : 'Outside NIFTY 500'));
    const top = [...POS].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const share = v => (v / total * 100).toFixed(0) + '%';
    const dup = [...POS].filter(([s, v]) => (WHERE.get(s) || new Set()).size > 1 && v / total > 0.15);
    const warn = (sec[0] && sec[0][1] / total > 0.35 ? `<p class="warn"><b>${share(sec[0][1])} in ${esc(sec[0][0])}</b>: more than a third in one sector.</p>` : '')
      + dup.map(([s, v]) => `<p class="warn"><b>${esc(s)} ${share(v)}</b> held in ${[...WHERE.get(s)].map(esc).join(' and ')}: heavy in one stock across accounts.</p>`).join('');
    el.innerHTML = `${warn}<div class="xray-bar">${sec.map(([k, v], i) => `<i style="width:${v / total * 100}%;background:${PAL[i % PAL.length]}" title="${esc(k)} ${share(v)}"></i>`).join('')}</div>
      <div class="xray-legend">${sec.slice(0, 8).map(([k, v], i) => `<span><b style="background:${PAL[i % PAL.length]}"></b>${esc(k)} ${share(v)}</span>`).join('')}</div>
      <p class="muted" style="margin-top:8px">Size: ${size.map(([k, v]) => `${esc(k)} ${share(v)}`).join(' · ')}<br>Biggest: ${top.map(([s, v]) => `<a href="#" data-sym="${esc(s)}">${esc(s)}</a> ${share(v)}`).join(' · ')}</p>`;
  }

  // ---------- goal and benchmark: daily value log (kept in your account) vs 20% a year and NIFTY ----------
  async function goal(el, t) {
    if (!el) return;
    if (!t.val) { el.innerHTML = '<p class="home-empty">Starts once a broker account is connected today.</p>'; return; }
    const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    let log = [];
    try { log = ((await j('api/auth.php?action=settings')).settings || {}).networth_log || []; } catch { /* new */ }
    if (!log.length || log[log.length - 1].d !== day) {
      log = [...log.filter(x => x.d !== day), { d: day, v: Math.round(t.val), i: Math.round(t.inv) }].slice(-800);
      if (root.Account) Account.request('api/auth.php?action=save_setting', { key: 'networth_log', value: log }).catch(() => {});
    }
    const first = log[0], days = (Date.parse(day) - Date.parse(first.d)) / 864e5;
    // Return net of money added: change in (value - invested) relative to the first value
    const gain = ((t.val - t.inv) - (first.v - first.i)) / (first.v || 1) * 100;
    const goalPct = 20 * days / 365, fdPct = 12 * days / 365;
    let nifty = null;
    try {
      const c = await j('api/chart.php?symbol=%5ENSEI&interval=1d&range=2y'), r = c.chart.result[0], ts = r.timestamp, cl = r.indicators.quote[0].close;
      const k = ts.findIndex(x => new Date(x * 1000 + 5.5 * 3600e3).toISOString().slice(0, 10) >= first.d);
      if (k >= 0 && cl[k]) nifty = (cl[cl.length - 1] / cl[k] - 1) * 100;
    } catch { /* optional */ }
    const row = (n, v, cls) => `<li><div><b>${n}</b></div><div class="q-num"><b class="${cls || (v >= 0 ? 'up' : 'down')}">${v == null ? '—' : pct(v)}</b></div></li>`;
    el.innerHTML = days < 1 ? `<p class="home-empty">Tracking started today (${new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}). Your progress against the 20% goal, NIFTY and a 12% return shows from tomorrow.</p>`
      : `<p class="muted">Since ${new Date(first.d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} (${Math.round(days)} days)</p>
        <ul class="q-list">${row('Your portfolio', gain)}${row('NIFTY 50', nifty)}${row('Goal: 20% a year', goalPct, 'muted')}${row('Opportunity cost: 12% a year', fdPct, 'muted')}</ul>
        <p class="citation">${gain >= goalPct ? 'On track for the yearly goal.' : 'Behind the yearly goal so far.'} Money added or withdrawn is left out.</p>`;
  }
  async function money(el, ctx) {
    POS.clear(); WHERE.clear();
    const b = ctx.brokers || { accounts: [] };
    const accts = [...(b.main && b.main.connectedToday ? [{ label: 'ICICI · main', url: 'api/breeze.php?action=holdings' }] : []),
      ...b.accounts.filter(a => a.connectedToday).map(a => ({ label: a.label, url: `api/brokers.php?action=holdings&id=${a.id}` })),
      ...(b.shared || []).filter(a => a.connectedToday).map(a => ({ label: `${a.label} (${a.owner})`, url: `api/brokers.php?action=holdings&id=${a.id}` }))];
    if (!accts.length) {
      xray(document.querySelector('#home-xray .home-card-body')); goal(document.querySelector('#home-goal .home-card-body'), {});
      const ce = document.querySelector('#home-cash .home-card-body'); if (ce) ce.innerHTML = '<p class="home-empty">Shows once a broker account is connected today.</p>';
      el.innerHTML = `<p class="home-empty">${b.main || b.accounts.length ? 'Log in to your broker accounts for today to see your money here.' : 'Add your broker account under <b>Broker accounts</b> (your name, top right) to see holdings and P&amp;L here.'}</p>`;
      return;
    }
    const syms = new Set();
    const rows = await Promise.all(accts.map(async a => { try { const h = await j(a.url); h._label = a.label; [...(h.holdings || []), ...(h.demat || [])].forEach(r => r.stock_code && syms.add((h.symbols || {})[String(r.stock_code).toUpperCase()] || String(r.stock_code).toUpperCase())); return { ...a, ...sumHoldings(h) }; } catch (e) { return { ...a, err: e.message }; } }));
    resultsDue([...syms]);
    cash(document.querySelector('#home-cash .home-card-body'), accts, ctx);
    xray(document.querySelector('#home-xray .home-card-body'));
    const t = rows.reduce((s, r) => ({ inv: s.inv + (r.inv || 0), val: s.val + (r.val || 0) }), { inv: 0, val: 0 });
    const pl = t.val - t.inv;
    goal(document.querySelector('#home-goal .home-card-body'), t);
    el.innerHTML = `<div class="money-total"><div><span>Value</span><b>${rs(t.val)}</b></div><div><span>Invested</span><b>${rs(t.inv)}</b></div>
        <div><span>P&amp;L</span><b class="${pl >= 0 ? 'up' : 'down'}">${rs(pl)} <small>${t.inv ? pct(pl / t.inv * 100) : ''}</small></b></div></div>
      <ul class="q-list">${rows.map(r => `<li><div><b>${esc(r.label)}</b><small>${r.err ? esc(r.err) : `${r.n} holdings`}</small></div>
        <div class="q-num">${r.err ? '' : `<span>${rs(r.val)}</span><small class="${r.val - r.inv >= 0 ? 'up' : 'down'}">${rs(r.val - r.inv)} ${r.inv ? pct((r.val - r.inv) / r.inv * 100) : ''}</small>`}</div></li>`).join('')}</ul>`;
  }

  // Results or corporate actions in the next 7 days for stocks you hold -> Today strip
  async function resultsDue(syms) {
    if (!syms.length) return;
    try {
      const cal = await j('api/events.php?action=calendar'), mine = new Set(syms);
      const until = new Date(Date.now() + 5.5 * 3600e3 + 7 * 864e5).toISOString().slice(0, 10);
      const hits = [...cal.meetings.filter(m => mine.has(m.symbol) && m.date <= until).map(m => [m.symbol, m.results ? 'results' : 'board meeting', m.date]),
        ...cal.actions.filter(a => mine.has(a.symbol) && a.exDate <= until).map(a => [a.symbol, 'ex-date', a.exDate])].slice(0, 5);
      if (!hits.length) return;
      let t = document.querySelector('#ck-today .today');
      if (!t) { document.querySelector('#ck-today').innerHTML = '<div class="today"><b>Today</b></div>'; t = document.querySelector('#ck-today .today'); }
      t.insertAdjacentHTML('beforeend', hits.map(([s, w, d]) => `<button class="act" data-sym="${esc(s)}">${esc(s)} ${w} ${new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</button>`).join(''));
    } catch { /* optional */ }
  }

  // ---------- risk meter (admin): money at risk in open trades vs the 2% daily loss limit ----------
  function risk(el, ctx) {
    const st = ctx.trade;
    if (!st) { el.innerHTML = '<p class="home-empty">Risk shows here once trading is set up.</p>'; return; }
    const cap = +st.settings.account || 100000, limit = cap * 0.02;
    const open = st.orders.filter(o => o.purpose === 'entry' && ['open', 'filled'].includes(o.status) && o.stop != null);
    const atRisk = open.reduce((s, o) => s + Math.max(0, ((+o.fill_price || +o.limit_price) - +o.stop) * (o.side === 'sell' ? -1 : 1)) * +o.qty, 0);
    const p = Math.min(100, atRisk / limit * 100);
    el.innerHTML = `<div class="risk-meter"><div class="risk-bar"><i style="width:${p}%" class="${p >= 100 ? 'down' : p >= 70 ? 'warn' : 'up'}"></i></div>
      <p>${rs(atRisk)} at risk in ${open.length} open trade${open.length === 1 ? '' : 's'} · limit ${rs(limit)} (2% of ${rs(cap)})${p >= 100 ? ' · <b class="down">limit reached: no new trades</b>' : ''}</p></div>`;
  }

  async function render(el) {
    const ctx = {};
    el.innerHTML = '<div id="ck-check"></div><div id="ck-mood"></div><div id="ck-today"></div><p class="ck-tools"><button type="button" class="link-btn" data-speak>🔊 Hear summary</button> <button type="button" class="link-btn" data-snap>Share snapshot</button></p>';
    if (root.UX) { UX.checklist(el.querySelector('#ck-check')); el.querySelector('[data-speak]').onclick = UX.speak; el.querySelector('[data-snap]').onclick = UX.snapshot; }
    mood(el.querySelector('#ck-mood'));
    await today(el.querySelector('#ck-today'), ctx);
    const m = document.querySelector('#home-money .home-card-body');
    if (m) money(m, ctx);
    const r = document.querySelector('#home-risk .home-card-body');
    if (r) risk(r, ctx);
  }

  root.Cockpit = { render };
})(typeof window !== 'undefined' ? window : globalThis);

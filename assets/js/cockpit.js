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
  function sumHoldings(h) {
    const src = h.holdings && h.holdings.length ? h.holdings : (h.demat || []);
    let inv = 0, val = 0, n = 0;
    for (const r of src) {
      const q = pick(r, ['quantity', 'demat_avail_quantity', 'demat_total_bulk_quantity']), a = pick(r, ['average_price', 'avg_price', 'purchase_price']), l = pick(r, ['current_market_price', 'ltp']);
      if (!(q > 0)) continue;
      n++;
      if (a && l) { inv += a * q; val += l * q; }
    }
    return { inv, val, n };
  }
  async function money(el, ctx) {
    const b = ctx.brokers || { accounts: [] };
    const accts = [...(b.main && b.main.connectedToday ? [{ label: 'ICICI · main', url: 'api/breeze.php?action=holdings' }] : []),
      ...b.accounts.filter(a => a.connectedToday).map(a => ({ label: a.label, url: `api/brokers.php?action=holdings&id=${a.id}` }))];
    if (!accts.length) {
      el.innerHTML = `<p class="home-empty">${b.main || b.accounts.length ? 'Log in to your broker accounts for today to see your money here.' : 'Add your broker account under <b>Broker accounts</b> (your name, top right) to see holdings and P&amp;L here.'}</p>`;
      return;
    }
    const rows = await Promise.all(accts.map(async a => { try { return { ...a, ...sumHoldings(await j(a.url)) }; } catch (e) { return { ...a, err: e.message }; } }));
    const t = rows.reduce((s, r) => ({ inv: s.inv + (r.inv || 0), val: s.val + (r.val || 0) }), { inv: 0, val: 0 });
    const pl = t.val - t.inv;
    el.innerHTML = `<div class="money-total"><div><span>Value</span><b>${rs(t.val)}</b></div><div><span>Invested</span><b>${rs(t.inv)}</b></div>
        <div><span>P&amp;L</span><b class="${pl >= 0 ? 'up' : 'down'}">${rs(pl)} <small>${t.inv ? pct(pl / t.inv * 100) : ''}</small></b></div></div>
      <ul class="q-list">${rows.map(r => `<li><div><b>${esc(r.label)}</b><small>${r.err ? esc(r.err) : `${r.n} holdings`}</small></div>
        <div class="q-num">${r.err ? '' : `<span>${rs(r.val)}</span><small class="${r.val - r.inv >= 0 ? 'up' : 'down'}">${rs(r.val - r.inv)} ${r.inv ? pct((r.val - r.inv) / r.inv * 100) : ''}</small>`}</div></li>`).join('')}</ul>`;
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
    el.innerHTML = '<div id="ck-mood"></div><div id="ck-today"></div>';
    mood(el.querySelector('#ck-mood'));
    await today(el.querySelector('#ck-today'), ctx);
    const m = document.querySelector('#home-money .home-card-body');
    if (m) money(m, ctx);
    const r = document.querySelector('#home-risk .home-card-body');
    if (r) risk(r, ctx);
  }

  root.Cockpit = { render };
})(typeof window !== 'undefined' ? window : globalThis);

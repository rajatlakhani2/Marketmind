// MarketMind AI — Home: full market overview (overview.js), market at a glance, your Watchlist, today's best setups,
// orders waiting for approval, results dates and MindGuru's record. Every block loads on its own.
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = v => (v == null || !isFinite(v) ? '' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
  const tone = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const IST = 5.5 * 3600e3;
  const istNow = () => new Date(Date.now() + IST);
  const istDate = () => istNow().toISOString().slice(0, 10);
  const marketOpen = () => { const d = istNow(), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && m >= 555 && m <= 930; };

  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }

  // Price + day change: ICICI live quote first, Yahoo (delayed) as the fallback
  async function yahoo(sym) {
    const j = await getJSON(`api/chart.php?symbol=${encodeURIComponent(sym)}&interval=1d&range=5d`);
    const r = j.chart && j.chart.result && j.chart.result[0];
    const closes = ((r && r.indicators.quote[0].close) || []).filter(v => v != null);
    const ltp = r && r.meta.regularMarketPrice != null ? r.meta.regularMarketPrice : closes[closes.length - 1];
    const prev = closes.length >= 2 ? closes[closes.length - 2] : null;
    return { ltp, changePct: ltp && prev ? (ltp / prev - 1) * 100 : null, delayed: true };
  }
  async function quote(sym) {
    try { const q = await MarketData.getQuote(sym); if (q && q.ltp) return q; } catch { /* fall back */ }
    return yahoo(sym + '.NS');
  }

  const INDICES = [['NIFTY 50', '^NSEI'], ['BANK NIFTY', '^NSEBANK'], ['SENSEX', '^BSESN']];

  const card = (id, title, action) => `<section class="home-card" id="${id}"><div class="home-card-head"><h3>${title}</h3>${action || ''}</div><div class="home-card-body"><div class="skeleton"></div><div class="skeleton short"></div></div></section>`;
  const openBtn = (page, label) => `<button type="button" class="link-btn" data-go="${page}">${label} ›</button>`;
  const fill = (id, html) => { const el = document.querySelector(`#${id} .home-card-body`); if (el) el.innerHTML = html; };
  const empty = text => `<p class="home-empty">${text}</p>`;

  async function renderPage(container) {
    const u = root.Account && Account.user;
    const h = istNow().getUTCHours();
    const hello = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = u ? String(u.displayName || u.username || '').split(' ')[0] : '';
    const open = marketOpen();
    const admin = !!(root.Account && Account.isAdmin);
    container.innerHTML = `
      <div class="home-hello">
        <div><h2>${hello}${name ? ', ' + esc(name) : ''}</h2>
        <p>${istNow().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</p></div>
        <span class="mkt-pill ${open ? 'open' : ''}"><i></i>${open ? 'Market open' : 'Market closed'}</span>
      </div>
      ${root.Overview ? '<div id="home-overview"></div>' : `<div class="idx-row" id="home-idx">${INDICES.map(([n]) => `<div class="idx"><span>${n}</span><b class="skeleton-text">—</b><small>&nbsp;</small></div>`).join('')}</div>`}
      <div class="home-grid">
        ${card('home-watch', 'Your Watchlist', openBtn('watchlist', 'Calls'))}
        ${card('home-opps', "Today's best setups", openBtn('opps', 'All'))}
        ${admin ? card('home-orders', 'Orders', openBtn('trading', 'Open')) : ''}
        ${card('home-events', 'Coming up', openBtn('events', 'Calendar'))}
        ${card('home-mg', 'MindGuru record', openBtn('mindguru', 'Details'))}
      </div>`;
    container.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => root.Nav && Nav.go(b.dataset.go); });

    if (root.Overview) Overview.render(container.querySelector('#home-overview')); else indices(container);
    let list = [];
    try { list = (await getJSON('api/watchlist.php?action=list')).items || []; } catch { /* shown below */ }
    watch(list);
    opps();
    if (admin) orders();
    events(list);
    mindguru(list);
  }

  async function indices(container) {
    const out = await Promise.all(INDICES.map(([n, s]) => yahoo(s).then(q => [n, q]).catch(() => [n, null])));
    const el = container.querySelector('#home-idx');
    if (el) el.innerHTML = out.map(([n, q]) => `<div class="idx"><span>${n}</span><b>${q ? num(q.ltp) : '—'}</b><small class="${tone(q && q.changePct)}">${q ? pct(q.changePct) : 'unavailable'}</small></div>`).join('');
  }

  async function watch(list) {
    if (!list.length) return fill('home-watch', empty('No stocks yet. Add some on the Watchlist tab to get buy and sell calls.'));
    const rows = await Promise.all(list.slice(0, 8).map(i => quote(i.symbol).then(q => [i, q]).catch(() => [i, null])));
    fill('home-watch', `<ul class="q-list">${rows.map(([i, q]) => `
      <li data-sym="${esc(i.symbol)}"><div><b>${esc(i.symbol)}</b><small>${esc(i.name || '')}</small></div>
      <div class="q-num"><b>${q ? num(q.ltp) : '—'}</b><small class="chg ${tone(q && q.changePct)}">${q ? pct(q.changePct) : ''}</small></div></li>`).join('')}</ul>
      ${list.length > 8 ? `<p class="home-more">+${list.length - 8} more on the Watchlist</p>` : ''}`);
    document.querySelectorAll('#home-watch [data-sym]').forEach(li => { li.onclick = () => (root.Stock ? Stock.open(li.dataset.sym) : root.Nav && Nav.go('watchlist')); });
  }

  async function opps() {
    try {
      const s = await getJSON('api/scan.php?action=latest');
      if (!s.date) return fill('home-opps', empty('No scan yet. It runs by itself after 3:40 pm on trading days.'));
      const strong = s.rows.filter(r => r.verdict === 'Buy' && (window.Tiers ? Tiers.isStrong(r) : r.agree >= 2) && r.rr >= 1.5 && r.trend && r.trend[0] !== 'Bearish')
        .sort((a, b) => b.rr - a.rr).slice(0, 5);
      const near = s.rows.filter(r => r.verdict === 'Buy on dip' && r.dist != null && r.dist <= 3).length;
      fill('home-opps', `${strong.length ? `<ul class="q-list">${strong.map(r => `
        <li><div><b>${esc(r.symbol)}</b><small>Stop ${num(r.stop)} · Target ${num(r.target)}</small></div>
        <div class="q-num"><span class="call-pill buy">BUY</span><small>R:R ${r.rr}</small></div></li>`).join('')}</ul>`
        : empty('No strong buy setups in the last scan.')}
        <p class="home-more">Scan of ${new Date(s.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${near ? ` · ${near} more near their buy zone` : ''}</p>`);
    } catch (e) { fill('home-opps', empty('Could not load the scan: ' + esc(e.message))); }
  }

  async function orders() {
    try {
      const st = await getJSON('api/trade.php?action=state');
      const pending = st.orders.filter(o => o.status === 'pending');
      const open = st.orders.filter(o => ['placed', 'filled', 'open'].includes(o.status)).length;
      const mode = { live: 'Live', man: 'Manual', test: 'Test' }[st.mode] || st.mode;
      fill('home-orders', `<div class="stat-row">
        <div><span>Waiting for you</span><b class="${pending.length ? 'attn' : ''}">${pending.length}</b></div>
        <div><span>Open</span><b>${open}</b></div>
        <div><span>Mode</span><b class="small-b">${esc(mode)}</b></div></div>
        ${pending.length ? `<ul class="q-list">${pending.slice(0, 3).map(o => `<li><div><b>${esc(o.symbol)}</b><small>${esc(o.product || '')}</small></div><div class="q-num"><span class="call-pill ${o.side === 'sell' ? 'sell' : 'buy'}">${esc(String(o.side || '').toUpperCase())}</span><small>${num(+o.limit_price)}</small></div></li>`).join('')}</ul>` : ''}`);
    } catch (e) { fill('home-orders', empty('Could not load orders.')); }
  }

  async function events(list) {
    try {
      const cal = await getJSON('api/events.php?action=calendar');
      const mine = new Set(list.map(i => i.symbol));
      const until = new Date(Date.now() + IST + 21 * 864e5).toISOString().slice(0, 10);
      const rows = [
        ...cal.meetings.filter(m => mine.has(m.symbol) && m.date <= until).map(m => ({ date: m.date, symbol: m.symbol, what: m.results ? 'Results' : (m.purpose || 'Board meeting') })),
        ...cal.actions.filter(a => mine.has(a.symbol) && a.exDate <= until).map(a => ({ date: a.exDate, symbol: a.symbol, what: a.purpose || a.subject || 'Corporate action' })),
      ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
      if (!list.length) return fill('home-events', empty('Results dates for your Watchlist stocks show here.'));
      fill('home-events', rows.length ? `<ul class="ev-list">${rows.map(r => `<li><time>${new Date(r.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</time><div><b>${esc(r.symbol)}</b><small>${esc(String(r.what).slice(0, 60))}</small></div></li>`).join('')}</ul>`
        : empty('No results or corporate actions for your Watchlist in the next 3 weeks.'));
    } catch { fill('home-events', empty('Could not load the calendar.')); }
  }

  async function mindguru(list) {
    try {
      const [brain, ws] = await Promise.all([
        getJSON('api/mindguru.php?action=brain').catch(() => null),
        list.length ? getJSON('api/mindguru.php?action=watch_stats&symbols=' + encodeURIComponent(list.map(i => i.symbol).join(','))) : Promise.resolve({ stats: {} }),
      ]);
      const st = Object.values(ws.stats || {});
      const judged = st.reduce((a, s) => a + s.judged, 0), right = st.reduce((a, s) => a + s.right, 0), pending = st.reduce((a, s) => a + s.pending, 0);
      const gen = brain && (brain.generation || (brain.brain && brain.brain.generation));
      fill('home-mg', `<div class="stat-row">
        <div><span>Watchlist calls right</span><b>${judged ? `${right}/${judged}` : '—'}</b></div>
        <div><span>Still open</span><b>${pending}</b></div>
        ${gen ? `<div><span>Generation</span><b>${gen}</b></div>` : ''}</div>
        <p class="home-more">${judged ? 'Calls are checked against the real price every day.' : 'Calls are being tracked. Results come in as targets or stops are reached.'}</p>`);
    } catch { fill('home-mg', empty('Could not load MindGuru.')); }
  }

  root.Home = { renderPage };
})(window);

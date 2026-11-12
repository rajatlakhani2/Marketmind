// MarketMind AI — Stock page: one screen per stock.
//   Interactive chart (1m … 1M) with demand/supply zones, buy/sell calls from demand & supply on every
//   timeframe, live buyers and sellers (NSE order book), and the closing prices of each timeframe.
//   Stock.open('TCS') opens it from anywhere (search, Watchlist, Home, Live).
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const rs = v => (v == null || !isFinite(v) ? '—' : '₹' + num(v));
  const pct = v => (v == null || !isFinite(v) ? '' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
  const tone = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const qty = v => (v == null ? '—' : v >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : v >= 1e5 ? (v / 1e5).toFixed(2) + ' L' : Math.round(v).toLocaleString('en-IN'));
  const IST = 5.5 * 3600e3;
  const marketOpen = () => { const d = new Date(Date.now() + IST), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && m >= 555 && m <= 930; };

  const TFS = [['1m', '1 min'], ['5m', '5 min'], ['15m', '15 min'], ['1h', 'Hourly'], ['1d', 'Daily'], ['1w', 'Weekly'], ['1mo', 'Monthly']];
  const HTF = { '1m': '15m', '5m': '1h', '15m': '1h', '1h': '1d', '1d': '1w', '1w': '1mo', '1mo': '1mo' };
  const TF_NAME = Object.fromEntries(TFS);

  const S = { symbol: null, name: '', tf: '1d', md: {}, calls: {}, quote: null, depth: null, depthErr: null, chart: null, timer: null, token: 0, inWatch: null };
  try { S.symbol = localStorage.getItem('mm-stock') || null; S.tf = localStorage.getItem('mm-stock-tf') || '1d'; } catch { /* defaults */ }

  async function getJSON(url, opts) {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'X-Requested-With': 'MarketMind', ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}) }, cache: 'no-store', ...opts });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }

  // ---------- demand & supply call for one timeframe ----------
  // BUY when price sits in a demand zone and the higher timeframe isn't falling;
  // SELL when price sits in a supply zone and the higher timeframe isn't rising; otherwise WAIT with the levels to watch.
  function dsCall(md, htfMd, price) {
    const candles = md.priceHistory || [];
    if (candles.length < 30) return { action: 'N/A', tone: 'wait', say: 'Not enough candles' };
    const htfC = htfMd && htfMd.priceHistory && htfMd.priceHistory.length > 30 ? htfMd.priceHistory : candles;
    const ks = KS001.analyze({ price, ltf: { tf: md.timeframe, candles }, itf: { tf: md.timeframe, candles }, htf: { tf: htfMd ? htfMd.timeframe : md.timeframe, candles: htfC } });
    const D = ks.nearestDemand[0] || null, Sz = ks.nearestSupply[0] || null;
    const tfT = ks.trends.ltf.trend, htfT = ks.trends.htf.trend;
    const inD = D && price <= D.proximal * 1.003 && price >= D.distal;
    const inS = Sz && price >= Sz.proximal * 0.997 && price <= Sz.distal;
    const closes = candles.map(c => c.close);
    const rsi = MarketData.rsi(closes, 14);
    let c;
    if (inD && htfT !== 'Bearish') {
      const target = Sz ? Sz.proximal : D.target;
      c = { action: 'BUY', tone: 'buy', entry: price, stop: D.stop, target, say: `In a ${D.pattern} demand zone${D.fresh ? ' (fresh)' : ''}, higher timeframe ${htfT.toLowerCase()}.` };
    } else if (inS && htfT !== 'Bullish') {
      const target = D ? D.proximal : Sz.target;
      c = { action: 'SELL', tone: 'sell', entry: price, stop: Sz.stop, target, say: `In a ${Sz.pattern} supply zone${Sz.fresh ? ' (fresh)' : ''}, higher timeframe ${htfT.toLowerCase()}.` };
    } else {
      const why = inD ? `In demand, but the higher timeframe is falling` : inS ? `In supply, but the higher timeframe is rising` : D && Sz ? `Between zones` : D ? `Above demand` : Sz ? `Below supply` : 'No fresh zone nearby';
      c = { action: 'WAIT', tone: 'wait', say: why + '.' };
    }
    if (c.entry && c.target && c.stop) c.rr = Math.abs(c.target - c.entry) / Math.max(1e-9, Math.abs(c.entry - c.stop));
    return { ...c, demand: D, supply: Sz, trend: tfT, htfTrend: htfT, rsi, ks, zones: ks.zones.filter(z => !z.garbage || z === D || z === Sz) };
  }

  // ---------- data ----------
  async function loadTf(tf) {
    if (S.md[tf]) return S.md[tf];
    const md = await MarketData.getMarketData(S.symbol, tf);
    S.md[tf] = md;
    return md;
  }
  const livePrice = md => (S.quote && S.quote.ltp) || (md && md.price) || (md && md.priceHistory && md.priceHistory.length ? md.priceHistory[md.priceHistory.length - 1].close : null);

  async function computeCall(tf) {
    const [md, htf] = await Promise.all([loadTf(tf), loadTf(HTF[tf])]);
    S.calls[tf] = dsCall(md, HTF[tf] === tf ? null : htf, livePrice(md));
    return S.calls[tf];
  }

  // ---------- page ----------
  function open(symbol, name) {
    S.symbol = String(symbol || '').toUpperCase();
    S.name = name || '';
    try { localStorage.setItem('mm-stock', S.symbol); } catch { /* ok */ }
    S.md = {}; S.calls = {}; S.quote = null; S.depth = null; S.depthErr = null; S.inWatch = null;
    if (root.Nav) Nav.go('stock');
  }

  async function renderPage(container) {
    const token = ++S.token;
    clearInterval(S.timer);
    if (S.chart) { S.chart.destroy(); S.chart = null; }
    if (!S.symbol) {
      container.innerHTML = `<div class="st-empty"><h2>Look up any stock</h2><p>Search by name or symbol to see its chart, buy and sell calls on every timeframe, and live buyers and sellers.</p><button type="button" class="btn-primary" data-search>Search stocks</button></div>`;
      container.querySelector('[data-search]').onclick = () => root.Nav && Nav.search();
      return;
    }
    container.innerHTML = `
      <div class="st-head card">
        <div class="st-id"><h2>${esc(S.symbol)}</h2><p id="st-name">${esc(S.name)}</p></div>
        <div class="st-px"><b id="st-ltp">—</b><span id="st-chg"></span></div>
        <div class="st-ohlc" id="st-ohlc"></div>
        <div class="st-actions">
          <button type="button" class="btn-secondary" id="st-watch">☆ Watchlist</button>
          <button type="button" class="btn-secondary" id="st-analyze">Full analysis</button>
          <button type="button" class="btn-secondary" id="st-fno">Options</button>
          <button type="button" class="btn-secondary hide-sm" data-search>Change stock</button>
        </div>
      </div>
      <div class="st-grid">
        <div class="st-main">
          <section class="card st-card st-o1">
            <div class="st-card-head"><h3>Chart</h3><div class="chips" id="st-tfs">${TFS.map(([k, l]) => `<button type="button" data-tf="${k}" class="${k === S.tf ? 'active' : ''}">${l.replace(' min', 'm').replace('Hourly', '1H').replace('Daily', '1D').replace('Weekly', '1W').replace('Monthly', '1M')}</button>`).join('')}</div></div>
            <div id="st-chart" class="st-chart"><div class="skeleton" style="height:260px"></div></div>
            <div class="st-callbar" id="st-callbar"></div>
          </section>
          <section class="card st-card st-o4">
            <div class="st-card-head"><h3>Tested strategies · daily</h3><span class="muted small">Proven counts fully, Watch half</span></div>
            <div id="st-tested"><div class="skeleton"></div></div>
          </section>
          <section class="card st-card st-o4">
            <div class="st-card-head"><h3>Buy / sell calls on every timeframe</h3><span class="muted small">from demand & supply zones ${root.Tiers ? Tiers.zoneBadge() : ''}</span></div>
            <div id="st-matrix"></div>
          </section>
          <section class="card st-card st-o5">
            <div class="st-card-head"><h3>Closing prices · <span id="st-close-tf">${TF_NAME[S.tf]}</span></h3></div>
            <div id="st-closes"></div>
          </section>
        </div>
        <aside class="st-side">
          <section class="card st-card st-o2">
            <div class="st-card-head"><h3>Live buyers & sellers</h3><span class="muted small" id="st-depth-at"></span></div>
            <div id="st-depth"><div class="skeleton"></div><div class="skeleton short"></div></div>
          </section>
          <section class="card st-card st-o3" id="st-events-card" hidden>
            <div class="st-card-head"><h3>Coming up</h3></div><div id="st-events"></div>
          </section>
          <section class="card st-card st-o3">
            <div class="st-card-head"><h3>News</h3><span class="muted small" id="st-news-sum"></span></div>
            <div id="st-news"><div class="skeleton"></div><div class="skeleton short"></div></div>
          </section>
        </aside>
      </div>`;
    wire(container);
    quote(token);
    depth(token);
    drawTf(token);
    matrix(token);
    tested(token);
    events(token);
    news(token);
    watchState();
    S.timer = setInterval(() => {
      const page = document.getElementById('page-stock');
      if (!page || !page.classList.contains('active')) { clearInterval(S.timer); return; }
      if (document.hidden || !marketOpen()) return;
      quote(token); depth(token);
    }, 5000);
  }

  function wire(c) {
    c.querySelectorAll('[data-search]').forEach(b => { b.onclick = () => root.Nav && Nav.search(); });
    c.querySelectorAll('#st-tfs [data-tf]').forEach(b => { b.onclick = () => setTf(b.dataset.tf); });
    c.querySelector('#st-analyze').onclick = () => {
      const i = document.getElementById('analyze-custom-symbol'); if (i) i.value = S.symbol;
      const tf = document.getElementById('analyze-timeframe'); if (tf) tf.value = ['5m', '15m'].includes(S.tf) ? S.tf : '1d';
      const st = document.getElementById('analyze-strategy'); if (st) st.value = '__all';
      Nav.go('analyze'); setTimeout(() => document.getElementById('btn-analyze')?.click(), 400);
    };
    c.querySelector('#st-fno').onclick = () => { Nav.go('fno'); setTimeout(() => root.FnO && FnO.openFor(S.symbol), 600); };
    c.querySelector('#st-watch').onclick = toggleWatch;
  }

  function setTf(tf) {
    S.tf = tf;
    try { localStorage.setItem('mm-stock-tf', tf); } catch { /* ok */ }
    document.querySelectorAll('#st-tfs [data-tf]').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
    document.querySelectorAll('#st-matrix tr[data-tf]').forEach(r => r.classList.toggle('sel', r.dataset.tf === tf));
    const l = document.getElementById('st-close-tf'); if (l) l.textContent = TF_NAME[tf];
    drawTf(S.token);
  }

  async function quote(token) {
    try {
      const q = await MarketData.getQuote(S.symbol);
      if (token !== S.token || !q || !q.ltp) return;
      S.quote = q; showPrice();
    } catch { if (!S.quote) showPrice(); }
  }
  function showPrice() {
    const md = S.md['1d'];
    const last = md && md.priceHistory && md.priceHistory.length ? md.priceHistory[md.priceHistory.length - 1] : null;
    const prev = md && md.priceHistory && md.priceHistory.length > 1 ? md.priceHistory[md.priceHistory.length - 2] : null;
    const q = S.quote;
    const ltp = q ? q.ltp : last && last.close;
    const pc = q && q.prevClose ? q.prevClose : prev && prev.close;
    const ch = q && q.changePct != null ? q.changePct : ltp && pc ? (ltp / pc - 1) * 100 : null;
    const set = (id, h) => { const e = document.getElementById(id); if (e) e.innerHTML = h; };
    if (md && md.name && md.name !== S.symbol && !S.name) { S.name = md.name; set('st-name', esc(md.name)); }
    set('st-ltp', ltp ? rs(ltp) : '—');
    set('st-chg', ch != null ? `<span class="${tone(ch)}">${ltp && pc ? (ltp - pc >= 0 ? '+' : '−') + num(Math.abs(ltp - pc)) : ''} (${pct(ch)})</span>${q ? '' : ' <small class="muted">last close</small>'}` : '');
    const o = q || last;
    if (o) set('st-ohlc', [['Open', o.open], ['High', o.high], ['Low', o.low], ['Prev close', pc]].map(([k, v]) => `<div><span>${k}</span><b>${rs(v)}</b></div>`).join(''));
  }

  async function drawTf(token) {
    const tf = S.tf, box = document.getElementById('st-chart');
    try {
      const call = await computeCall(tf);
      const md = S.md[tf];
      if (token !== S.token || tf !== S.tf || !box) return;
      if (!S.chart) { box.innerHTML = ''; S.chart = CandleChart.create(box); }
      const candles = md.priceHistory;
      const ema = MarketData.emaSeries(candles.map(c => c.close), 20);
      const zones = (call.zones || []).filter(z => z === call.demand || z === call.supply || (!z.garbage && Math.abs(z.proximal / livePrice(md) - 1) < 0.25)).slice(-8)
        .map(z => ({ side: z.side, proximal: z.proximal, distal: z.distal, time: z.time, label: z === call.demand || z === call.supply ? `${z.side === 'demand' ? 'Buy zone' : 'Sell zone'} ${num(z.proximal, 0)}–${num(z.distal, 0)}` : '' }));
      const lines = call.action !== 'WAIT' && call.stop ? [{ price: call.stop, label: 'SL', kind: 'stop' }, ...(call.target ? [{ price: call.target, label: 'Target', kind: 'target' }] : [])] : [];
      S.chart.set({ candles, zones, lines, ema, tf, reset: true });
      if (!md.live) box.insertAdjacentHTML('beforeend', '<p class="st-note">Sample data: live prices could not load.</p>');
      const bar = document.getElementById('st-callbar');
      if (bar) bar.innerHTML = callHtml(call, tf, md);
      closes(md);
      if (tf === '1d' || S.md['1d']) showPrice();
    } catch (e) {
      if (box && token === S.token) box.innerHTML = `<p class="muted">Could not load the ${TF_NAME[tf]} chart: ${esc(e.message)}</p>`;
    }
  }

  function callHtml(c, tf, md) {
    const lv = [];
    if (c.action === 'WAIT') {
      if (c.demand) lv.push(`Buy near <b class="up">${rs(c.demand.proximal)}</b> (SL ${rs(c.demand.stop)})`);
      if (c.supply) lv.push(`Sell near <b class="down">${rs(c.supply.proximal)}</b>`);
    } else {
      lv.push(`${c.action === 'BUY' ? 'Buy' : 'Sell'} at <b>${rs(c.entry)}</b>`, `SL <b class="down">${rs(c.stop)}</b>`);
      if (c.target) lv.push(`Target <b class="up">${rs(c.target)}</b>`);
      if (c.rr != null) lv.push(`R:R ${c.rr.toFixed(1)}`);
    }
    return `<div class="st-call"><span class="wl-call ${c.tone}">${c.action}</span><div><b>${TF_NAME[tf]} call.</b> ${esc(c.say)}<div class="st-levels">${lv.join(' · ')}</div></div></div>`;
  }

  async function matrix(token) {
    const box = document.getElementById('st-matrix');
    if (!box) return;
    box.innerHTML = `<div class="tbl-wrap"><table class="st-table"><thead><tr><th>Timeframe</th><th>Call</th><th>Last close</th><th>Change</th><th>Trend</th><th class="hide-sm">RSI</th><th class="hide-sm">Buy zone</th><th class="hide-sm">Sell zone</th></tr></thead>
      <tbody>${TFS.map(([k, l]) => `<tr data-tf="${k}" class="${k === S.tf ? 'sel' : ''}"><td><b>${l}</b></td><td colspan="7" class="muted">Loading…</td></tr>`).join('')}</tbody></table></div>
      <p class="st-sum" id="st-sum"></p>`;
    box.querySelectorAll('tr[data-tf]').forEach(r => { r.onclick = () => { setTf(r.dataset.tf); document.getElementById('st-chart')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }; });
    // longer timeframes first: they're cached for the chart's higher-timeframe checks
    const order = ['1mo', '1w', '1d', '1h', '15m', '5m', '1m'];
    let i = 0;
    const worker = async () => {
      while (i < order.length) {
        const tf = order[i++];
        let html;
        try {
          const c = await computeCall(tf);
          const md = S.md[tf], h = md.priceHistory, n = h.length;
          // last completed candle: skip the one still forming during market hours on intraday/daily
          const done = marketOpen() && n > 2 ? h[n - 2] : h[n - 1], before = marketOpen() && n > 2 ? h[n - 3] : h[n - 2];
          const ch = before ? (done.close / before.close - 1) * 100 : null;
          const tr = c.trend === 'Bullish' ? '<span class="up">▲<span class="hide-sm"> Up</span></span>' : c.trend === 'Bearish' ? '<span class="down">▼<span class="hide-sm"> Down</span></span>' : '<span class="muted">–</span>';
          html = `<td><b>${TF_NAME[tf]}</b></td><td><span class="wl-call ${c.tone}">${c.action}</span></td><td>${rs(done.close)}</td><td class="${tone(ch)}">${pct(ch)}</td><td>${tr}</td><td class="hide-sm">${c.rsi != null ? `<span class="${c.rsi > 70 ? 'down' : c.rsi < 30 ? 'up' : ''}">${c.rsi.toFixed(0)}</span>` : '—'}</td>
            <td class="hide-sm">${c.demand ? `${num(c.demand.proximal, 0)}–${num(c.demand.distal, 0)}` : '—'}</td><td class="hide-sm">${c.supply ? `${num(c.supply.proximal, 0)}–${num(c.supply.distal, 0)}` : '—'}</td>`;
        } catch (e) { html = `<td><b>${TF_NAME[tf]}</b></td><td colspan="7" class="muted">Not available</td>`; }
        if (token !== S.token) return;
        const row = box.querySelector(`tr[data-tf="${tf}"]`); if (row) row.innerHTML = html;
        summary();
      }
    };
    await Promise.all([worker(), worker()]);
  }

  // ---------- the back-tested strategies on the daily chart ----------
  async function tested(token) {
    const box = () => document.getElementById('st-tested');
    try {
      const k = root.app && root.app.analysis && root.app.analysis.knowledge;
      if (!k || !root.Consensus) throw new Error('analysis engine not loaded');
      const md = await loadTf('1d');
      const hist = md.priceHistory || [];
      if (hist.length < 60) throw new Error('not enough daily candles');
      const price = livePrice(md);
      const ks = KS001.analyze({ price, ltf: { tf: '1d', candles: hist }, itf: { tf: '1w', candles: MarketData.aggregateByPeriod(hist, 'week') }, htf: { tf: '1mo', candles: MarketData.aggregateByPeriod(hist, 'month') } });
      const [brain] = await Promise.all([root.MindGuru ? MindGuru.getBrain().catch(() => null) : null, root.Tiers ? Tiers.ready() : null]);
      const cs = Consensus.run({ md: { ...md, price }, ks, strategies: k.strategies, check: (c, d) => k.checkConditionDetail(c, d), learned: brain ? brain.strategies : null });
      if (token !== S.token || !box()) return;
      const c = cs.conclusion;
      const active = cs.results.filter(r => r.status === 'Active');
      const counted = active.filter(r => r.counted), ignored = active.filter(r => !r.counted);
      const near = cs.results.filter(r => r.status === 'Setting up' && r.counted).slice(0, 4);
      const mk = Tiers.market();
      const call = c.tone === 'long' ? `<span class="wl-call ${c.verdict === 'Buy' ? 'buy' : 'dip'}">${esc(c.verdict.toUpperCase())}</span>${c.backing === 'proven' ? Tiers.badge(counted.find(r => r.tier === 'proven').id) : '<span class="tier tier-watch">Watch</span>'}`
        : c.tone === 'short' ? '<span class="wl-call sell">SELL</span>' : '<span class="wl-call wait">WAIT</span>';
      box().innerHTML = `
        <div class="wl-call-row">${call}${c.tone === 'long' ? `<span class="muted">buy ${rs(c.buyLow)}${c.buyHigh !== c.buyLow ? '–' + rs(c.buyHigh) : ''} · SL ${rs(c.stop)} · T1 ${rs(c.sell1)}</span>` : ''}</div>
        <ul class="st-tested">
          ${counted.length ? counted.map(r => `<li>${Tiers.badge(r.id)} <b>${esc(r.name)}</b> <span class="muted">${r.side === 'short' ? 'sell' : 'buy'} signal now</span></li>`).join('') : '<li class="muted">No Proven or Watch strategy has a signal today.</li>'}
          ${near.length ? `<li class="muted">Getting close: ${near.map(r => `${esc(r.name)} (${r.tierLabel})`).join(', ')}</li>` : ''}
          ${ignored.length ? `<li class="muted">Not counted: ${ignored.map(r => esc(r.name) + (r.shortBlocked ? ' (short; NIFTY is above its 200-day)' : '')).join(', ')}</li>` : ''}
        </ul>
        <p class="muted small">${mk ? `NIFTY ${num(mk.nifty, 0)} is ${mk.above200 ? 'above' : 'below'} its 200-day average (${num(mk.ma200, 0)}), so short signals ${mk.above200 ? 'are not counted' : 'count'}.` : 'Short signals are not counted until the NIFTY 200-day check loads.'}</p>`;
    } catch (e) { if (box()) box().innerHTML = `<p class="muted">Not available: ${esc(e.message)}</p>`; }
  }

  function summary() {
    const el = document.getElementById('st-sum'); if (!el) return;
    const got = TFS.filter(([k]) => S.calls[k]);
    const by = a => got.filter(([k]) => S.calls[k].action === a).map(([, l]) => l);
    const b = by('BUY'), s = by('SELL');
    const pos = ['1d', '1w', '1mo'].filter(k => S.calls[k]).map(k => S.calls[k].action);
    let line = b.length || s.length ? [b.length ? `<b class="up">BUY</b> on ${b.join(', ')}` : '', s.length ? `<b class="down">SELL</b> on ${s.join(', ')}` : ''].filter(Boolean).join(' · ') : 'No timeframe is at a demand or supply zone right now: wait for price to reach one.';
    if (pos.length === 3) line += pos.every(a => a === 'BUY') ? ' — daily, weekly and monthly agree: strong positional buy.' : pos.every(a => a === 'SELL') ? ' — daily, weekly and monthly agree: strong exit signal.' : '';
    el.innerHTML = line + ' <span class="muted">Tap a row to see it on the chart.</span>';
  }

  function closes(md) {
    const box = document.getElementById('st-closes'); if (!box) return;
    const h = md.priceHistory.slice(-21);
    const rows = [];
    for (let i = h.length - 1; i >= 1 && rows.length < 20; i--) {
      const c = h[i], p = h[i - 1], ch = (c.close / p.close - 1) * 100;
      const forming = i === h.length - 1 && marketOpen() && md.timeframe !== '1mo' && md.timeframe !== '1w' ? ' <small class="muted">(forming)</small>' : '';
      const d = new Date(c.time + IST);
      const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const t = /m$|h$/.test(md.timeframe) && md.timeframe !== '1mo' ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
        : md.timeframe === '1mo' ? `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      rows.push(`<tr><td>${t}${forming}</td><td><b>${num(c.close)}</b></td><td class="${tone(ch)}">${pct(ch)}</td><td class="hide-sm">${num(c.high)}</td><td class="hide-sm">${num(c.low)}</td><td>${qty(c.volume)}</td></tr>`);
    }
    box.innerHTML = `<div class="tbl-wrap"><table class="st-table"><thead><tr><th>${md.timeframe === '1mo' ? 'Month' : md.timeframe === '1w' ? 'Week of' : /m$|h$/.test(md.timeframe) ? 'Time' : 'Date'}</th><th>Close</th><th>Change</th><th class="hide-sm">High</th><th class="hide-sm">Low</th><th>Volume</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  // ---------- live buyers & sellers ----------
  async function depth(token) {
    try {
      const d = await getJSON('api/events.php?action=depth&symbol=' + encodeURIComponent(S.symbol));
      if (token !== S.token) return;
      S.depth = d; S.depthErr = null;
    } catch (e) {
      if (token !== S.token) return;
      S.depthErr = e.message;
    }
    showDepth();
  }
  function showDepth() {
    const box = document.getElementById('st-depth'); if (!box) return;
    const d = S.depth, q = S.quote;
    if (!d) {
      // ICICI top of book as a fallback
      if (q && q.bidQty != null) {
        box.innerHTML = `${pressureBar(q.bidQty, q.askQty, 'Best bid qty', 'Best offer qty')}<p class="muted small">Showing only the best bid and offer from ICICI. NSE's full order book did not load${S.depthErr ? ` (${esc(S.depthErr)})` : ''}.</p>`;
      } else box.innerHTML = `<p class="muted">The order book could not load${S.depthErr ? `: ${esc(S.depthErr)}` : ''}. It shows during market hours.</p>`;
      return;
    }
    const at = document.getElementById('st-depth-at');
    if (at) at.textContent = (marketOpen() ? 'live · ' : 'at close · ') + new Date(d.at * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const maxQ = Math.max(1, ...d.bids.map(x => x.qty), ...d.asks.map(x => x.qty));
    const rows = Array.from({ length: Math.max(d.bids.length, d.asks.length, 1) }, (_, i) => {
      const b = d.bids[i], a = d.asks[i];
      return `<tr><td class="ob-q"><i class="bar buy" style="width:${b ? b.qty / maxQ * 100 : 0}%"></i>${b ? qty(b.qty) : ''}</td><td class="up">${b ? num(b.price) : ''}</td><td class="down">${a ? num(a.price) : ''}</td><td class="ob-q r"><i class="bar sell" style="width:${a ? a.qty / maxQ * 100 : 0}%"></i>${a ? qty(a.qty) : ''}</td></tr>`;
    }).join('');
    const ratio = d.totalSell ? d.totalBuy / d.totalSell : null;
    const lean = ratio == null ? '' : ratio >= 1.5 ? '<b class="up">Buyers are in control</b>' : ratio >= 1.1 ? '<b class="up">Slightly more buyers</b>' : ratio <= 0.67 ? '<b class="down">Sellers are in control</b>' : ratio <= 0.9 ? '<b class="down">Slightly more sellers</b>' : '<b>Balanced</b>';
    box.innerHTML = `${pressureBar(d.totalBuy, d.totalSell, 'Buyers', 'Sellers')}
      <p class="st-lean">${lean}${ratio != null ? ` <span class="muted">· ${ratio.toFixed(2)}× buy vs sell quantity waiting</span>` : ''}</p>
      <table class="ob"><thead><tr><th>Qty</th><th>Bid</th><th>Offer</th><th class="r">Qty</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="ob-stats">${d.vwap ? `<div><span>VWAP</span><b>${num(d.vwap)}</b></div>` : ''}${d.deliveryPct != null ? `<div><span>Delivery</span><b>${num(d.deliveryPct)}%</b></div>` : ''}${d.volume != null ? `<div><span>Volume</span><b>${num(d.volume)} L</b></div>` : ''}</div>
      <p class="muted small">From NSE's order book: the 5 best bids and offers, and every share waiting to be bought or sold. Delivery % = shares actually taken home, a sign of real buying.</p>`;
  }
  function pressureBar(buy, sell, lb, ls) {
    const t = (buy || 0) + (sell || 0), b = t ? buy / t * 100 : 50;
    return `<div class="pbar"><div class="pbar-b" style="width:${b}%"></div></div>
      <div class="pbar-l"><span class="up"><b>${b.toFixed(0)}%</b> ${lb} · ${qty(buy)}</span><span class="down">${ls} · ${qty(sell)} <b>${(100 - b).toFixed(0)}%</b></span></div>`;
  }

  // ---------- extras ----------
  async function events(token) {
    if (!root.EventsPage || !EventsPage.eventWarning) return;
    try {
      const w = await EventsPage.eventWarning(S.symbol);
      if (token !== S.token || !w || !w.length) return;
      const card = document.getElementById('st-events-card'); if (!card) return;
      card.hidden = false;
      document.getElementById('st-events').innerHTML = w.map(x => `<p class="st-ev">${x}</p>`).join('');
    } catch { /* optional */ }
  }

  // ---------- latest news (Google News, last 14 days) ----------
  const POS = /\b(surge|surges|soar|soars|rally|rallies|jump|jumps|gain|gains|rise|rises|record high|upgrade|upgrades|outperform|beats|strong|robust|growth|boost|order win|bags order|wins order|expansion|profit rises|profit jumps|buy rating|bullish|rebound|approval|approves|acquire|acquires)\b/i;
  const NEG = /\b(fall|falls|fell|slump|slumps|plunge|plunges|crash|tumble|tumbles|drop|drops|decline|declines|slide|slides|downgrade|downgrades|underperform|misses|weak|loss|losses|profit falls|concern|concerns|pressure|selloff|sell-off|bearish|probe|penalty|ban|slowdown|default|fraud|raid|resigns|sell rating|warning|pledge)\b/i;
  const newsTone = t => { const p = POS.test(t), n = NEG.test(t); return p && !n ? 1 : n && !p ? -1 : 0; };
  async function news(token) {
    const box = () => document.getElementById('st-news');
    try {
      const j = await getJSON(`api/events.php?action=news&symbol=${encodeURIComponent(S.symbol)}`);
      if (token !== S.token || !box()) return;
      const items = (j.items || []).slice(0, 8).map(n => ({ ...n, s: newsTone(n.title) }));
      if (!items.length) { box().innerHTML = '<p class="muted small">No news in the last 14 days.</p>'; return; }
      const pos = items.filter(n => n.s > 0).length, neg = items.filter(n => n.s < 0).length;
      const sum = document.getElementById('st-news-sum');
      if (sum) sum.innerHTML = `<span class="up">${pos} positive</span> · <span class="down">${neg} negative</span>`;
      const ago = t => { const h = Math.round((Date.now() / 1000 - t) / 3600); return h < 1 ? 'just now' : h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`; };
      box().innerHTML = `<ul class="ov-news">${items.map(n => `<li><span class="${n.s > 0 ? 'up' : n.s < 0 ? 'down' : 'muted'}">${n.s > 0 ? '▲' : n.s < 0 ? '▼' : '•'}</span> <a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a> <small class="muted">${esc(n.source || '')} · ${ago(n.at)}</small></li>`).join('')}</ul>
        <p class="citation">Headlines from Google News. ▲ / ▼ is a simple word check of the headline, for context only: it does not change the buy or sell calls.</p>`;
    } catch (e) { if (token === S.token && box()) box().innerHTML = `<p class="muted small">News not available: ${esc(e.message)}</p>`; }
  }

  let wlItems = null;
  async function watchState() {
    try { wlItems = (await getJSON('api/watchlist.php?action=list')).items || []; } catch { return; }
    const it = wlItems.find(i => i.symbol === S.symbol);
    S.inWatch = it || null;
    const b = document.getElementById('st-watch'); if (b) { b.textContent = it ? '★ In Watchlist' : '☆ Add to Watchlist'; b.classList.toggle('on', !!it); }
  }
  async function toggleWatch() {
    const b = document.getElementById('st-watch'); if (b) b.disabled = true;
    try {
      if (S.inWatch) await getJSON('api/watchlist.php?action=remove', { method: 'POST', body: JSON.stringify({ id: S.inWatch.id }) });
      else await getJSON('api/watchlist.php?action=add', { method: 'POST', body: JSON.stringify({ symbol: S.symbol }) });
      await watchState();
    } catch (e) { if (root.app && app.ui && app.ui._toast) app.ui._toast(e.message, 'error'); }
    if (b) b.disabled = false;
  }

  root.Stock = { renderPage, open, dsCall, current: () => S.symbol };
})(window);

// MarketMind AI — Back-tester.
// Replays the real engine (KS-001 zones + every strategy + the All-Strategy Verdict) bar by bar on past prices,
// simulates each plan as a real trade (next-bar fills, gaps, stop checked before target, time exit, costs),
// and ranks strategies by what they would have made. Swing: daily bars up to 5 years. Intraday: 15-minute bars
// (Yahoo keeps about 60 days), entries 9:30–14:30, everything squared off by 15:15.
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IST = 5.5 * 3600e3;
  const istDate = ms => new Date(ms + IST).toISOString().slice(0, 10);
  const istMin = ms => { const d = new Date(ms + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const fmtR = v => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`);
  const inr = v => (v == null || !isFinite(v) ? '—' : `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}`);

  const LARGE = ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'BHARTIARTL', 'ITC', 'SBIN', 'LT', 'KOTAKBANK', 'AXISBANK', 'HINDUNILVR',
    'BAJFINANCE', 'MARUTI', 'SUNPHARMA', 'M&M', 'TITAN', 'NTPC', 'ULTRACEMCO', 'HCLTECH', 'ASIANPAINT', 'POWERGRID', 'NESTLEIND', 'WIPRO',
    'TATASTEEL', 'JSWSTEEL', 'ADANIPORTS', 'ONGC', 'COALINDIA', 'BAJAJFINSV', 'TECHM', 'GRASIM', 'HINDALCO', 'CIPLA', 'DRREDDY', 'EICHERMOT',
    'HEROMOTOCO', 'BRITANNIA', 'APOLLOHOSP', 'DIVISLAB', 'INDUSINDBK', 'SBILIFE', 'HDFCLIFE', 'BAJAJ-AUTO', 'TRENT', 'BEL', 'SHRIRAMFIN',
    'ADANIENT', 'TATACONSUM', 'DLF'];
  const MID = ['PIDILITIND', 'SIEMENS', 'HAVELLS', 'DABUR', 'GODREJCP', 'AMBUJACEM', 'SHREECEM', 'BERGEPAINT', 'MARICO', 'COLPAL',
    'ICICIGI', 'ICICIPRULI', 'BANKBARODA', 'PNB', 'CANBK', 'IOC', 'BPCL', 'GAIL', 'TATAPOWER', 'VEDL', 'JINDALSTEL', 'LUPIN',
    'AUROPHARMA', 'TORNTPHARM', 'ZYDUSLIFE', 'BOSCHLTD', 'MOTHERSON', 'TVSMOTOR', 'ASHOKLEY', 'BHARATFORG', 'MUTHOOTFIN', 'CHOLAFIN',
    'PAGEIND', 'NAUKRI', 'PERSISTENT', 'LTIM', 'MPHASIS', 'COFORGE', 'INDIGO', 'IRCTC', 'HAL', 'DMART', 'POLYCAB', 'ABB',
    'CUMMINSIND', 'VOLTAS', 'MRF', 'PETRONET', 'HINDPETRO', 'NMDC'];
  // Background tabs slow setTimeout to once a second; a MessageChannel hop is not throttled
  const yieldNow = (() => { const ch = new MessageChannel(); const q = []; ch.port1.onmessage = () => { const f = q.shift(); if (f) f(); }; return () => new Promise(r => { q.push(r); ch.port2.postMessage(0); }); })();

  // Round-trip costs as % of trade value: brokerage, STT, exchange, stamp, GST and slippage
  const COST = { swing: 0.25, intraday: 0.10 };
  const RULES = {
    swing: { entryBars: 10, holdBars: 30, step: 2 },
    intraday: { step: 2, firstEntry: 9 * 60 + 30, lastEntry: 14 * 60 + 30, squareOff: 15 * 60 + 15 },
  };

  const S = { running: false, cancel: false, res: null, cfg: null };
  try { S.res = JSON.parse(localStorage.getItem('mm-bt-last') || 'null'); } catch { /* none */ }

  async function yahoo(sym, interval, range) {
    const r = await fetch(`api/chart.php?symbol=${encodeURIComponent(sym)}&interval=${interval}&range=${range}`, { headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return MarketData.parseYahooChart(j);
  }
  const ySym = s => MarketData.toYahooSymbol(s);

  // NIFTY above its 200-day average = market filter "on"
  async function marketFilter(years) {
    const { candles } = await yahoo('^NSEI', '1d', years > 2 ? '10y' : '5y');
    const map = new Map(); let sum = 0; const q = [];
    for (const c of candles) {
      q.push(c.close); sum += c.close; if (q.length > 200) sum -= q.shift();
      map.set(istDate(c.time), q.length === 200 ? c.close > sum / 200 : true);
    }
    return d => (map.has(d) ? map.get(d) : true);
  }

  // ---------- the new demand rule: wait for the bounce ----------
  // Price dipped into a fresh demand zone in the last 3 bars without breaking it, and the current bar closed
  // green back above the zone. Higher timeframe not falling. Stop below the zone, target 2R.
  function demandBounce(ks, candles) {
    const n = candles.length, c = candles[n - 1];
    if (c.close <= c.open || ks.trends.htf.trend === 'Bearish') return null;
    const recent = candles.slice(-4, -1);
    for (const z of ks.zones) {
      if (z.side !== 'demand' || z.tests > 1 || z.violated) continue;
      const dipped = recent.some(b => b.low <= z.proximal * 1.002 && b.low >= z.distal * 0.997);
      if (!dipped || c.close <= z.proximal) continue;
      const stop = Math.min(z.stop, ...recent.map(b => b.low)) * 0.999;
      if (stop >= c.close) continue;
      return { strategyId: '__ks_bounce', strategyName: 'Demand zone + bounce (new rule)', side: 'long', entry: c.close, stop, target: c.close + 2 * (c.close - stop), market: true };
    }
    return null;
  }

  // ---------- trade simulation ----------
  function simulate(p, bars, from, opts) {
    const long = p.side !== 'short';
    if (!(long ? p.stop < p.entry && p.entry < p.target : p.target < p.entry && p.entry < p.stop)) return null;
    const near = p.market || Math.abs(p.entry / bars[from - 1].close - 1) < 0.003;
    let i = from, fill = null, fi = -1;
    const lastEntry = opts.lastEntryIdx(from);
    for (; i <= lastEntry && i < bars.length; i++) {
      const b = bars[i];
      if (near) { fill = b.open; fi = i; break; }
      if (long ? b.low <= p.entry : b.high >= p.entry) { fill = long ? Math.min(b.open, p.entry) : Math.max(b.open, p.entry); fi = i; break; }
    }
    if (fill == null) return { noEntry: true };
    const risk = Math.abs(fill - p.stop);
    if (!(risk > 0) || (long ? fill <= p.stop : fill >= p.stop)) return null;
    const end = opts.exitIdx(fi);
    let exit = null, ei = end, why = 'time';
    for (let j = fi; j <= end && j < bars.length; j++) {
      const b = bars[j];
      const open = j === fi ? fill : b.open;
      if (long) {
        if (b.low <= p.stop) { exit = Math.min(open, p.stop); ei = j; why = 'stop'; break; }
        if (b.high >= p.target) { exit = Math.max(open, p.target); ei = j; why = 'target'; break; }
      } else {
        if (b.high >= p.stop) { exit = Math.max(open, p.stop); ei = j; why = 'stop'; break; }
        if (b.low <= p.target) { exit = Math.min(open, p.target); ei = j; why = 'target'; break; }
      }
    }
    if (exit == null) { ei = Math.min(end, bars.length - 1); exit = bars[ei].close; }
    const gross = (long ? exit - fill : fill - exit) / risk;
    const cost = (opts.costPct / 100) * fill / risk;
    return { r: gross - cost, why, entryAt: bars[fi].time, exitAt: bars[ei].time, fillIdx: fi, exitIdx: ei };
  }

  // ---------- replay one stock ----------
  async function replaySwing(sym, years, strategies, check, mkt, push) {
    const { candles: daily, meta } = await yahoo(ySym(sym), '1d', years > 2 ? '10y' : '5y');
    const weeklyAll = MarketData.aggregateByPeriod(daily, 'week'), monthlyAll = MarketData.aggregateByPeriod(daily, 'month');
    const n = daily.length, start = Math.max(260, n - Math.round(years * 248));
    const busy = new Map();   // strategy -> bar index its last trade closed
    let wi = 0, mi = 0;
    for (let t = start; t <= n - 2; t += RULES.swing.step) {
      const T = daily[t].time;
      while (wi < weeklyAll.length && weeklyAll[wi].time <= T) wi++;
      while (mi < monthlyAll.length && monthlyAll[mi].time <= T) mi++;
      const weekly = weeklyAll.slice(0, Math.max(0, wi - 1)), monthly = monthlyAll.slice(0, Math.max(0, mi - 1));   // completed periods only
      if (weekly.length < 25 || monthly.length < 12) continue;
      const window = daily.slice(Math.max(0, t - 399), t + 1);
      const md = MarketData.buildMarketData({ symbol: sym, timeframe: '1d', candles: window, meta: { longName: meta && meta.longName }, source: 'History' });
      const ks = KS001.analyze({ price: md.price, ltf: { tf: '1d', candles: window }, itf: { tf: '1w', candles: weekly.slice(-200) }, htf: { tf: '1mo', candles: monthly.slice(-120) } });
      const cs = Consensus.run({ md, ks, strategies, check });
      const plans = MindGuru.projections(cs, md, ks, istDate(T));
      const b = demandBounce(ks, window); if (b) plans.push(b);
      const day = istDate(T), up = mkt(day);
      for (const p of plans) {
        if ((busy.get(p.strategyId) || -1) >= t) continue;
        const tr = simulate(p, daily, t + 1, { lastEntryIdx: f => f + RULES.swing.entryBars - 1, exitIdx: fi => fi + RULES.swing.holdBars, costPct: COST.swing });
        if (!tr) continue;
        if (tr.noEntry) { push({ s: p.strategyId, name: p.strategyName, noEntry: true }); continue; }
        busy.set(p.strategyId, tr.exitIdx);
        push({ s: p.strategyId, name: p.strategyName, sym, side: p.side, r: tr.r, why: tr.why, at: tr.exitAt, year: day.slice(0, 4), up: p.side === 'short' ? !up : up });
      }
      if (t % 20 === 0) await yieldNow();
      if (S.cancel) return;
    }
  }

  async function replayIntraday(sym, strategies, check, mkt, push) {
    const [m15, h1, d1] = await Promise.all([yahoo(ySym(sym), '15m', '1mo'), yahoo(ySym(sym), '60m', '6mo'), yahoo(ySym(sym), '1d', '2y')]);
    const bars = m15.candles; if (bars.length < 120) return;
    const days = []; let cur = null;
    bars.forEach((b, i) => { const d = istDate(b.time); if (!cur || cur.d !== d) { cur = { d, from: i, to: i }; days.push(cur); } else cur.to = i; });
    for (const dy of days.slice(3)) {
      const busy = new Map();
      const htf = d1.candles.filter(c => istDate(c.time) < dy.d).slice(-250);
      const up = mkt(htf.length ? istDate(htf[htf.length - 1].time) : dy.d);
      const lastIdx = (() => { let k = dy.from; for (let i = dy.from; i <= dy.to; i++) if (istMin(bars[i].time) <= RULES.intraday.squareOff) k = i; return k; })();
      for (let t = dy.from; t <= dy.to; t += RULES.intraday.step) {
        const m = istMin(bars[t].time) + 15;      // bar close time
        if (m < RULES.intraday.firstEntry || m > RULES.intraday.lastEntry) continue;
        const window = bars.slice(Math.max(0, t - 299), t + 1);
        const itf = h1.candles.filter(c => c.time + 36e5 <= bars[t].time + 9e5).slice(-200);
        if (itf.length < 30 || htf.length < 60) continue;
        const md = MarketData.buildMarketData({ symbol: sym, timeframe: '15m', candles: window, meta: null, source: 'History' });
        const ks = KS001.analyze({ price: md.price, ltf: { tf: '15m', candles: window }, itf: { tf: '1h', candles: itf }, htf: { tf: '1d', candles: htf } });
        const cs = Consensus.run({ md, ks, strategies, check });
        const plans = MindGuru.projections(cs, md, ks, dy.d);
        const b = demandBounce(ks, window); if (b) plans.push(b);
        for (const p of plans) {
          if ((busy.get(p.strategyId) || -1) >= t) continue;
          const tr = simulate(p, bars, t + 1, {
            lastEntryIdx: () => { let k = t + 1; for (let i = t + 1; i <= dy.to; i++) if (istMin(bars[i].time) <= 14 * 60 + 45) k = i; return k; },
            exitIdx: () => lastIdx, costPct: COST.intraday,
          });
          if (!tr) continue;
          if (tr.noEntry) { push({ s: p.strategyId, name: p.strategyName, noEntry: true }); continue; }
          busy.set(p.strategyId, tr.exitIdx);
          push({ s: p.strategyId, name: p.strategyName, sym, side: p.side, r: tr.r, why: tr.why, at: tr.exitAt, year: dy.d.slice(0, 7), up: p.side === 'short' ? !up : up });
        }
      }
      await yieldNow();
      if (S.cancel) return;
    }
  }

  // ---------- statistics ----------
  function summarise(trades) {
    const by = new Map();
    for (const t of trades) {
      const o = by.get(t.s) || { id: t.s, name: t.name, n: 0, wins: 0, sumR: 0, gw: 0, gl: 0, noEntry: 0, rs: [], years: {}, nUp: 0, sumUp: 0, longs: 0 };
      if (t.noEntry) { o.noEntry++; by.set(t.s, o); continue; }
      o.n++; o.sumR += t.r; if (t.r > 0) { o.wins++; o.gw += t.r; } else o.gl -= t.r;
      o.rs.push([t.at, t.r]);
      (o.years[t.year] = o.years[t.year] || [0, 0])[0] += t.r; o.years[t.year][1]++;
      if (t.side !== 'short') o.longs++;
      if (t.up) { o.nUp++; o.sumUp += t.r; }
      by.set(t.s, o);
    }
    const out = [];
    for (const o of by.values()) {
      if (!o.n) continue;
      o.rs.sort((a, b) => a[0] - b[0]);
      let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
      const curve = [];
      for (const [at, r] of o.rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); streak = r <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); curve.push([at, eq]); }
      const avg = o.sumR / o.n;
      out.push({
        id: o.id, name: o.name, n: o.n, win: o.wins / o.n, avg, total: o.sumR, pf: o.gl ? o.gw / o.gl : null, dd, worst, noEntry: o.noEntry,
        avgUp: o.nUp ? o.sumUp / o.nUp : null, nUp: o.nUp,
        years: Object.fromEntries(Object.entries(o.years).map(([y, [s, c]]) => [y, { avg: s / c, n: c }])),
        curve: curve.filter((_, i) => i % Math.max(1, Math.floor(curve.length / 160)) === 0 || i === curve.length - 1),
        verdict: o.n < 30 ? 'few' : avg >= 0.1 ? 'keep' : avg >= 0 ? 'weak' : 'drop',
      });
    }
    return out.sort((a, b) => (b.n >= 30) - (a.n >= 30) || b.avg - a.avg);
  }

  // ---------- run ----------
  async function run(cfg, onProgress) {
    S.running = true; S.cancel = false;
    const strategies = (app.engine.strategies || []).filter(s => Consensus.LEVELS[s.id]);
    const check = (c, d) => app.engine.checkConditionDetail(c, d);
    const mkt = await marketFilter(cfg.years).catch(() => () => true);
    const trades = [], failed = [];
    let done = 0;
    for (const sym of cfg.symbols) {
      if (S.cancel) break;
      onProgress({ sym, done, total: cfg.symbols.length, trades: trades.length });
      try {
        if (cfg.style === 'swing') await replaySwing(sym, cfg.years, strategies, check, mkt, t => trades.push(t));
        else await replayIntraday(sym, strategies, check, mkt, t => trades.push(t));
      } catch (e) { failed.push(`${sym}: ${e.message}`); }
      done++;
    }
    onProgress({ done, total: cfg.symbols.length, trades: trades.length });
    S.running = false;
    const res = { cfg: { ...cfg, symbols: cfg.symbols.length }, at: Date.now(), stats: summarise(trades), failed, cancelled: S.cancel, totalTrades: trades.filter(t => !t.noEntry).length };
    S.res = res;
    try { localStorage.setItem('mm-bt-last', JSON.stringify(res)); } catch { /* too big: keep in memory */ }
    return res;
  }

  // ---------- page ----------
  async function renderPage(container) {
    let wl = [];
    try { wl = ((await (await fetch('api/watchlist.php?action=list', { headers: { Accept: 'application/json' } })).json()).items || []).map(i => i.symbol); } catch { /* none */ }
    const cfg = S.cfg || { style: 'swing', years: 5, universe: 'quick', capital: 100000, risk: 1 };
    container.innerHTML = `
      <div class="card bt-form">
        <div class="bt-row">
          <label>Style<div class="seg" id="bt-style"><button type="button" data-v="swing" class="${cfg.style === 'swing' ? 'active' : ''}">Swing (daily)</button><button type="button" data-v="intraday" class="${cfg.style === 'intraday' ? 'active' : ''}">Intraday (15 min)</button></div></label>
          <label id="bt-years-l" ${cfg.style === 'intraday' ? 'hidden' : ''}>Years<select id="bt-years">${[1, 2, 3, 5].map(y => `<option value="${y}"${y === cfg.years ? ' selected' : ''}>${y}</option>`).join('')}</select></label>
          <label>Stocks<select id="bt-universe">
            <option value="quick"${cfg.universe === 'quick' ? ' selected' : ''}>Quick test: 10 large caps</option>
            <option value="large"${cfg.universe === 'large' ? ' selected' : ''}>50 large caps</option>
            <option value="hundred"${cfg.universe === 'hundred' ? ' selected' : ''}>100 large &amp; mid caps</option>
            <option value="watch"${cfg.universe === 'watch' ? ' selected' : ''}>My Watchlist (${wl.length})</option>
          </select></label>
          <label>Capital (₹)<input type="number" id="bt-capital" value="${cfg.capital}" min="10000" step="10000"></label>
          <label>Risk per trade (%)<input type="number" id="bt-risk" value="${cfg.risk}" min="0.25" max="3" step="0.25"></label>
          <button type="button" class="btn-primary" id="bt-run">${S.running ? 'Running…' : 'Run back-test'}</button>
          ${S.running ? '<button type="button" class="btn-secondary" id="bt-stop">Stop</button>' : ''}
        </div>
        <p class="citation">Replays the real engine on past prices: every strategy, the All-Strategy Verdict, and the new "demand zone + bounce" rule. Signals fill on the next bar (gaps included), the stop is checked before the target, swing trades exit after 30 days at most, intraday trades by 15:15. Costs are taken off every trade (${COST.swing}% swing, ${COST.intraday}% intraday, round trip). Only one open trade per strategy per stock at a time. Intraday history is only about 60 days (Yahoo's limit), so intraday results are a rough first look. Past results do not guarantee future ones.</p>
        <div id="bt-progress"></div>
      </div>
      <div id="bt-results"></div>`;
    const $ = s => container.querySelector(s);
    container.querySelectorAll('#bt-style [data-v]').forEach(b => { b.onclick = () => { cfg.style = b.dataset.v; S.cfg = cfg; renderPage(container); }; });
    $('#bt-run').onclick = async () => {
      if (S.running) return;
      cfg.years = +$('#bt-years').value; cfg.universe = $('#bt-universe').value; cfg.capital = +$('#bt-capital').value || 100000; cfg.risk = +$('#bt-risk').value || 1;
      S.cfg = cfg;
      const symbols = cfg.universe === 'watch' ? wl : cfg.universe === 'hundred' ? LARGE.concat(MID) : cfg.universe === 'large' ? LARGE : LARGE.slice(0, 10);
      if (!symbols.length) { $('#bt-progress').innerHTML = '<p class="auth-error">Your Watchlist is empty.</p>'; return; }
      renderPage(container);
      S.running = true;
      const t0 = Date.now();
      await run({ ...cfg, symbols }, p => {
        const el = document.getElementById('bt-progress'); if (!el) return;
        const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
        const eta = p.done ? Math.round((Date.now() - t0) / p.done * (p.total - p.done) / 1000) : null;
        el.innerHTML = `<div class="pbar sm bt-bar"><div class="pbar-b" style="width:${pct}%"></div></div><p class="muted small">${p.sym ? `Replaying ${esc(p.sym)} · ` : ''}${p.done} of ${p.total} stocks · ${p.trades} trades so far${eta != null ? ` · about ${eta > 90 ? Math.round(eta / 60) + ' min' : eta + ' s'} left` : ''}. Keep this page open.</p>`;
      });
      renderPage(container);
    };
    const st = $('#bt-stop'); if (st) st.onclick = () => { S.cancel = true; };
    if (S.res) results($('#bt-results'), S.res, cfg);
  }

  function results(el, res, cfg) {
    const c = res.cfg, money = r => r * (cfg.capital || 100000) * (cfg.risk || 1) / 100;
    const keep = res.stats.filter(s => s.verdict === 'keep');
    const V = { keep: ['Keep', 'buy'], weak: ['Weak', 'dip'], drop: ['Switch off', 'sell'], few: ['Too few trades', 'wait'] };
    const years = [...new Set(res.stats.flatMap(s => Object.keys(s.years)))].sort();
    const verdict = res.stats.find(s => s.id === '__verdict'), bounce = res.stats.find(s => s.id === '__ks_bounce'), oldDemand = res.stats.find(s => /ks_demand/.test(s.id));
    el.innerHTML = `
      <div class="card bt-sum">
        <h3>${c.style === 'swing' ? `Swing · ${c.years} year${c.years > 1 ? 's' : ''}` : 'Intraday · last ~60 days'} · ${c.symbols} stocks · ${res.totalTrades.toLocaleString('en-IN')} trades${res.cancelled ? ' (stopped early)' : ''}</h3>
        <p class="muted small">Run ${new Date(res.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. ₹ figures use ${cfg.risk}% risk per trade on ${inr(cfg.capital)} (no compounding, trades counted one by one).</p>
        <ul class="bt-find">
          ${verdict ? `<li>The <b>All-Strategy Verdict</b> (what Analyze shows): ${verdict.n} trades, ${Math.round(verdict.win * 100)}% right, <b class="${verdict.avg >= 0 ? 'up' : 'down'}">${fmtR(verdict.avg)}</b> per trade.</li>` : ''}
          ${bounce ? `<li><b>New demand rule</b> (wait for the bounce): ${bounce.n} trades, ${Math.round(bounce.win * 100)}% right, <b class="${bounce.avg >= 0 ? 'up' : 'down'}">${fmtR(bounce.avg)}</b>${oldDemand ? ` vs the old demand rule ${fmtR(oldDemand.avg)}` : ''}.${bounce.avgUp != null ? ` With the NIFTY-above-200-day filter: ${fmtR(bounce.avgUp)}.` : ''}</li>` : ''}
          <li><b>${keep.length}</b> strateg${keep.length === 1 ? 'y makes' : 'ies make'} at least +0.1R per trade after costs${keep.length ? `: ${keep.slice(0, 4).map(s => esc(s.name)).join(', ')}` : ''}.</li>
        </ul>
        ${chart(res.stats.filter(s => s.n >= 30).slice(0, 4).concat(verdict && verdict.n >= 30 && !res.stats.slice(0, 4).includes(verdict) ? [verdict] : []))}
      </div>
      <div class="card"><div class="tbl-wrap"><table class="st-table bt-table">
        <thead><tr><th>Strategy</th><th>Result</th><th>Trades</th><th>Right</th><th>Avg / trade</th><th class="hide-sm">Profit factor</th><th class="hide-sm">Worst losing run</th><th class="hide-sm">Deepest drop</th><th>Total at ${cfg.risk}%</th><th class="hide-sm">With market filter</th>${years.length <= 6 ? years.map(y => `<th class="hide-sm">${y}</th>`).join('') : ''}</tr></thead>
        <tbody>${res.stats.map(s => `<tr>
          <td><b>${esc(s.name)}</b></td><td><span class="wl-call ${V[s.verdict][1]}">${V[s.verdict][0]}</span></td><td>${s.n}</td><td>${Math.round(s.win * 100)}%</td>
          <td class="${s.avg >= 0 ? 'up' : 'down'}"><b>${fmtR(s.avg)}</b></td><td class="hide-sm">${s.pf != null ? s.pf.toFixed(2) : '—'}</td><td class="hide-sm">${s.worst}</td><td class="hide-sm">${s.dd.toFixed(1)}R</td>
          <td class="${s.total >= 0 ? 'up' : 'down'}">${inr(money(s.total))}</td><td class="hide-sm">${s.avgUp != null && s.nUp >= 10 ? fmtR(s.avgUp) : '—'}</td>
          ${years.length <= 6 ? years.map(y => `<td class="hide-sm ${s.years[y] ? (s.years[y].avg >= 0 ? 'up' : 'down') : ''}">${s.years[y] ? fmtR(s.years[y].avg) : ''}</td>`).join('') : ''}</tr>`).join('')}</tbody></table></div>
        <p class="citation">Keep = makes at least +0.1R per trade after costs with 30+ trades. Profit factor = money won ÷ money lost (above 1.3 is good). Worst losing run = most losses in a row; deepest drop = the biggest fall from a high, in R. "With market filter" counts only buys taken while NIFTY was above its 200-day average (and sells while below). A strategy that is positive in most years is more trustworthy than one with one lucky year.</p>
        ${res.failed.length ? `<p class="muted small">Skipped: ${res.failed.map(esc).join(' · ')}</p>` : ''}
      </div>`;
  }

  // Equity curves (cumulative R) for the best strategies
  function chart(list) {
    if (!list.length) return '';
    const W = 680, H = 220, L = 44, R = 10, T = 10, B = 24;
    const all = list.flatMap(s => s.curve);
    const t0 = Math.min(...all.map(p => p[0])), t1 = Math.max(...all.map(p => p[0]));
    let lo = Math.min(0, ...all.map(p => p[1])), hi = Math.max(0, ...all.map(p => p[1]));
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const X = t => L + (t - t0) / Math.max(1, t1 - t0) * (W - L - R), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const COLORS = ['#2b59c3', '#0b8a52', '#b9520c', '#6a44bd', '#7b8595'];
    const ticks = [lo, (lo + hi) / 2, hi].map(v => Math.round(v));
    return `<div class="bt-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative result over time">
      ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="cc-grid"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="cc-ax">${v}R</text>`).join('')}
      <line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--text-muted)" stroke-width="1"/>
      <text x="${L}" y="${H - 6}" class="cc-ax">${new Date(t0).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end" class="cc-ax">${new Date(t1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</text>
      ${list.map((s, i) => `<path fill="none" stroke="${COLORS[i]}" stroke-width="${s.id === '__verdict' ? 1.5 : 2}" ${s.id === '__verdict' ? 'stroke-dasharray="5 4"' : ''} d="${s.curve.map((p, k) => `${k ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}"/>`).join('')}
    </svg><div class="bt-legend">${list.map((s, i) => `<span><i style="background:${COLORS[i]}"></i>${esc(s.name)} <b class="${s.total >= 0 ? 'up' : 'down'}">${fmtR(s.total)}</b></span>`).join('')}</div></div>`;
  }

  root.Backtest = { renderPage, _simulate: simulate, _summarise: summarise, _demandBounce: demandBounce };
})(window);

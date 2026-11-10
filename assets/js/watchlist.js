// ============================================================
// MarketMind AI — Watchlist with buy / sell calls (personal per user)
//
// For every stock, two calls side by side:
//   Positional  daily chart  (trend from monthly / weekly / daily)
//   Intraday    15-min chart (trend from daily / hourly / 15-min)
// Each call comes from the 24 strategies (All-Strategy Verdict) plus concept checks
// (trend, RSI, moving averages, MACD), and its levels come from demand and supply zones:
//   entry  = the demand zone (where buyers stepped in before)
//   stop   = just below that zone; a close below it means the zone failed
//   exit   = the next supply zone above (where sellers stepped in before), then the one after
// SELL means exit / book profit if you hold it (no short selling).
// During market hours the list re-checks on live prices and pops up when a call changes
// or price reaches an entry, target or stop.
// ============================================================
(function (root) {
  'use strict';

  const API = 'api/watchlist.php';
  const IST = 5.5 * 3600e3;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = v => (v == null || !isFinite(v) ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const pct = v => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
  const istNow = () => new Date(Date.now() + IST);
  const istDate = () => istNow().toISOString().slice(0, 10);
  const marketOpen = () => { const d = istNow(), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && m >= 555 && m <= 930; };
  const toast = (m, t) => root.app && root.app.ui && root.app.ui._toast(m, t || 'info');

  async function call(action, body) {
    const opts = { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.headers['X-Requested-With'] = 'MarketMind'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${API}?action=${action}`, opts);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }

  // ---------- data ----------
  let brain = null, brainAt = 0;
  async function learned() {
    if (root.MindGuru && Date.now() - brainAt > 10 * 60e3) { brain = await MindGuru.getBrain().catch(() => null); brainAt = Date.now(); }
    return brain ? brain.strategies : null;
  }

  // 15-minute candles -> NSE hourly bars (9:15–10:15, 10:15–11:15, …) within each day
  function toHourly(c) {
    const out = [];
    let key = null, cur = null;
    for (const x of c) {
      const d = new Date(x.time + IST), m = d.getUTCHours() * 60 + d.getUTCMinutes();
      const k = d.toISOString().slice(0, 10) + ':' + Math.floor((m - 555) / 60);
      if (k !== key) {
        if (cur) out.push(cur);
        key = k;
        cur = { time: x.time, date: x.date, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume || 0 };
      } else {
        cur.high = Math.max(cur.high, x.high); cur.low = Math.min(cur.low, x.low); cur.close = x.close; cur.volume += x.volume || 0;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  async function livePrice(md) {
    if (md.source !== 'ICICI Breeze') return md.price;
    try { const q = await MarketData.getQuote(md.symbol); return q && q.ltp > 0 ? q.ltp : md.price; } catch { return md.price; }
  }

  // ---------- options for F&O stocks ----------
  let foMeta = null, foMetaAt = 0;
  const chainCache = new Map();   // isec|expiry -> { at, calls, puts }
  async function getJSON(url) { const r = await fetch(url, { cache: 'no-store' }); const j = await r.json().catch(() => null); if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`); return j; }
  async function optionsFor(symbol, posCall, spot) {
    if (!root.FnO || !posCall || posCall.error) return null;
    if (!foMeta || Date.now() - foMetaAt > 6 * 3600e3) { foMeta = (await getJSON('api/breeze.php?action=fo_meta')).underlyings; foMetaAt = Date.now(); }
    const u = foMeta.find(x => x.symbol === symbol || x.isec === symbol);
    if (!u) return null;                              // not an F&O stock
    const expiry = FnO.firstExpiry(u);
    const key = `${u.isec}|${expiry}`;
    let ch = chainCache.get(key);
    if (!ch || Date.now() - ch.at > 2 * 60e3) {       // option chains refresh every 2 minutes
      const [c, p] = await Promise.all(['call', 'put'].map(right => getJSON(`api/breeze.php?action=option_chain&isec=${encodeURIComponent(u.isec)}&expiry=${expiry}&right=${right}`)));
      ch = { at: Date.now(), calls: c.rows, puts: p.rows };
      chainCache.set(key, ch);
    }
    const chainSpot = [...ch.calls, ...ch.puts].map(r => r.spot).find(v => v > 0);
    return FnO.optionPlans({ u, expiry, calls: ch.calls, puts: ch.puts, spot: spot || chainSpot, call: posCall });
  }

  async function analyse(symbol) {
    const k = root.app.analysis.knowledge;
    const out = { symbol };
    // Positional: daily chart, weekly and monthly built from the same candles
    const pos = await root.Opportunities.verdict(symbol);
    out.price = pos.md.price; out.change = pos.md.changePercent; out.name = pos.md.name; out.source = pos.md.source;
    out.pos = makeCall(pos, 'pos');
    recordCall(symbol, pos, out.pos);
    try { out.opt = await optionsFor(symbol, out.pos, out.price); } catch (e) { out.opt = null; out.optError = e.message; }
    // Intraday: 15-minute chart, hourly built from it, daily from above
    try {
      const md = await k.getMarketData(symbol, '15m');
      if (!md.live) throw new Error('no live intraday prices');
      md.price = await livePrice(md);
      const hist = md.priceHistory;
      const ks = KS001.analyze({ price: md.price, ltf: { tf: '15m', candles: hist }, itf: { tf: '1h', candles: toHourly(hist) }, htf: { tf: '1d', candles: pos.md.priceHistory } });
      const cs = Consensus.run({ md, ks, strategies: k.strategies, check: (c, d) => k.checkConditionDetail(c, d), learned: await learned() });
      out.intra = makeCall({ md, ks, cs }, 'intra');
    } catch (e) { out.intra = { error: e.message }; }
    return out;
  }

  // ---------- MindGuru: record each positional call so it gets judged ----------
  // The call itself goes in as '__watch_pos' (source 'watch'); the strategies behind it
  // as normal live projections, so their record on this stock builds up too.
  function recordCall(symbol, v, c) {
    try {
      if (!root.MindGuru || !c || !['BUY', 'BUY ON DIP', 'SELL'].includes(c.action)) return;
      const hist = v.md.priceHistory || [];
      if (!hist.length) return;
      const last = new Date(hist[hist.length - 1].time + IST).toISOString().slice(0, 10);
      if (marketOpen() && last !== istDate()) return;          // today's price didn't load: don't record a stale call
      const key = `${symbol}|rec`;
      if (seen[key]) return;
      let call = null;
      if (c.action === 'SELL') {
        // Judged as a fall: right if price reaches the demand zone below before rising above the supply zone's stop
        // No demand zone below: judge it against a fall of 1.5× the risk instead
        const stop = c.supply ? c.supply.stop : null;
        const target = c.demand ? c.demand.proximal : stop > c.price ? c.price - 1.5 * (stop - c.price) : null;
        if (stop > c.price && target < c.price) call = { side: 'short', entry: c.price, stop, target };
      } else if (c.entry && c.stop && c.t1 && c.stop < c.entry && c.entry < c.t1) {
        call = { side: 'long', entry: c.action === 'BUY' ? c.price : c.entry, stop: c.stop, target: c.t1 };
      }
      const preds = MindGuru.projections(v.cs, v.md, v.ks, last).filter(p => p.kind === 'strategy');
      seen[key] = true; saveSeen();
      const jobs = [];
      if (preds.length) jobs.push(MindGuru.api('record', { source: 'live', predictions: preds }));
      if (call) jobs.push(MindGuru.api('record', { source: 'watch', predictions: [{ ...call, kind: 'watch', strategyId: '__watch_pos', strategyName: 'Watchlist call',
        symbol, name: v.md.name || symbol, signalDate: last, price: c.price, trend: v.ks.trends.htf.trend,
        context: { action: c.action, agree: c.agree, of: c.of, t2: c.t2, rr: c.rr } }] }));
      Promise.all(jobs).catch(e => { delete seen[key]; saveSeen(); console.warn('MindGuru could not save the Watchlist call:', e.message); });
    } catch (e) { console.warn('recordCall', e); }
  }

  // Track record of past calls per stock
  let track = {}, trackAt = 0;
  async function loadTrack(force) {
    if (!root.MindGuru || !S.items.length || (!force && Date.now() - trackAt < 10 * 60e3)) return;
    trackAt = Date.now();
    try { track = (await MindGuru.api('watch_stats', undefined, '&symbols=' + encodeURIComponent(S.items.map(i => i.symbol).join(',')))).stats || {}; }
    catch { /* shown when available */ }
  }
  const STATUS_WORD = { target_hit: 'target hit', stop_hit: 'stop hit', expired: 'ran out of time', no_entry: 'price never came to entry', pending: 'still open' };
  function trackHtml(sym) {
    const t = track[sym];
    if (!t) return `<div class="wl-track muted">MindGuru record: no judged calls on this stock yet. Each BUY / SELL call is saved and checked against the real price.</div>`;
    const head = t.judged
      ? `MindGuru record: <b>${t.right} of ${t.judged}</b> past calls right, average <b class="${t.avgR >= 0 ? 'text-green' : 'text-red'}">${t.avgR > 0 ? '+' : ''}${t.avgR}R</b>`
      : 'MindGuru record: no call has finished yet';
    const extra = [t.pending ? `${t.pending} open` : '', t.noEntry ? `${t.noEntry} never reached entry` : ''].filter(Boolean).join(', ');
    const rows = t.recent.map(r => `<li>${esc(r.date)} · ${r.side === 'long' ? 'BUY' : 'SELL'} at ${rs(r.entry)} (stop ${rs(r.stop)}, target ${rs(r.target)}): ${STATUS_WORD[r.status] || r.status}${r.r != null ? ` <b class="${r.r >= 0 ? 'text-green' : 'text-red'}">${r.r > 0 ? '+' : ''}${r.r.toFixed(2)}R</b>` : ''}</li>`).join('');
    return `<details class="wl-track"><summary>${head}${extra ? ` <span class="muted">(${extra})</span>` : ''}</summary><ul>${rows}</ul>
      <p class="muted small">R = result in units of the risk taken (entry to stop). +2R means it made twice what it risked. Strategies that keep failing on this stock get less say in its calls once it has 8 judged trades.</p></details>`;
  }

  // ---------- the call ----------
  const TF_WORDS = { pos: ['monthly', 'weekly', 'daily'], intra: ['daily', 'hourly', '15-min'] };

  function makeCall({ md, ks, cs }, kind) {
    const c = cs.conclusion, p = md.price;
    const demand = (ks.nearestDemand || []).filter(z => z.distal <= p);
    const supply = (ks.nearestSupply || []).filter(z => z.distal >= p);
    const D = demand[0], S = supply[0];
    const S2 = S ? supply.find(z => z.proximal > S.distal) : null;   // the next zone fully above the first
    const stopOf = z => (z.stop != null ? z.stop : z.distal);
    const htf = ks.trends.htf.trend;
    const inDemand = D && p <= D.proximal;
    const atSupply = S && p >= S.proximal * 0.997;

    // Concept checks (each is a short reason line)
    const concepts = [];
    const tw = TF_WORDS[kind];
    const word = t => (t === 'Bullish' ? 'up' : t === 'Bearish' ? 'down' : 'sideways');
    concepts.push(`Trend: ${tw[0]} ${word(ks.trends.htf.trend)}, ${tw[1]} ${word(ks.trends.itf.trend)}, ${tw[2]} ${word(ks.trends.ltf.trend)}${ks.aligned ? ' (aligned)' : ''}.`);
    if (md.rsi != null) concepts.push(`RSI ${md.rsi.toFixed(0)}: ${md.rsi >= 70 ? 'overbought, buyers may be stretched' : md.rsi <= 30 ? 'oversold, sellers may be stretched' : md.rsi >= 40 && md.rsi <= 55 && htf === 'Bullish' ? 'a healthy pullback in an uptrend' : md.rsi > 55 ? 'momentum is with the buyers' : 'momentum is weak'}.`);
    if (md.ma50 && md.ma200) concepts.push(`Price is ${p > md.ma50 ? 'above' : 'below'} its 50-${kind === 'pos' ? 'day' : 'bar'} and ${p > md.ma200 ? 'above' : 'below'} its 200-${kind === 'pos' ? 'day' : 'bar'} average${md.ma50 > md.ma200 ? ' (50 above 200: long-term uptrend)' : ' (50 below 200: long-term downtrend)'}.`);
    if (md.macdHist != null) concepts.push(`MACD ${md.macdHist > 0 ? 'above' : 'below'} its signal line: momentum ${md.macdHist > 0 ? 'rising' : 'falling'}.`);

    const zoneText = (z, side) => `${z.pattern} ${side} zone ${rs(z.distal)} – ${rs(z.proximal)}${z.score ? `, score ${z.score.total}/10` : ''}, ${z.fresh ? 'fresh (not yet retested)' : `tested ${z.tests}×`}`;
    const zones = [];
    if (D) zones.push(`Demand: ${zoneText(D, 'demand')}${inDemand ? ' — price is inside it now' : ''}.`);
    else zones.push('No demand zone below the price on this chart.');
    if (S) zones.push(`Supply: ${zoneText(S, 'supply')}${atSupply ? ' — price has reached it' : ''}.`);
    else zones.push('No supply zone above the price on this chart.');

    // Which call
    let action, tone;
    // A BUY needs a counted strategy behind it (Proven, or Watch at half weight). A zone on its own is not proven
    // (demand-zone buys were −0.15R in the 5-year back-test), so a zone-only setup is at most BUY ON DIP.
    const strongStrategies = c.verdict === 'Buy' && root.Tiers && Tiers.isStrong(c);
    const counted = c.tone === 'long' && (c.score || 0) >= 0.4;
    if (c.tone === 'short' || atSupply) { action = 'SELL'; tone = 'sell'; }
    else if (htf !== 'Bearish' && (strongStrategies || (inDemand && D.qualifies && counted))) { action = 'BUY'; tone = 'buy'; }
    else if (c.tone === 'long' || (D && htf === 'Bullish')) { action = 'BUY ON DIP'; tone = 'dip'; }
    else { action = 'WAIT'; tone = 'wait'; }

    // Levels from the zones (strategy levels if a zone is missing)
    let entry = null, entryZone = null, stop = null;
    if (action === 'BUY') {
      entry = p;
      const nearZone = D && (inDemand || (p - D.proximal) / p <= 0.03);
      entryZone = nearZone ? [D.distal, D.proximal] : c.buyLow != null ? [c.buyLow, c.buyHigh] : null;
      stop = nearZone ? stopOf(D) : c.stop;
    } else if (action === 'BUY ON DIP' || action === 'WAIT') {
      entry = D ? D.proximal : c.buyHigh;
      entryZone = D ? [D.distal, D.proximal] : c.buyLow != null ? [c.buyLow, c.buyHigh] : null;
      stop = D ? stopOf(D) : c.stop;
    } else { // SELL: exit now; where to look at buying again
      entry = D ? D.proximal : null;
      entryZone = D ? [D.distal, D.proximal] : null;
      stop = D ? stopOf(D) : null;
    }
    const base = entry || p;
    let t1 = S && S.proximal > base ? S.proximal : (c.sell1 != null && c.sell1 > base ? c.sell1 : null);
    let t2 = S2 && S2.proximal > base ? S2.proximal : (t1 && stop && base > stop ? base + 3 * (base - stop) : null);
    if (t2 != null && t1 != null && t2 <= t1 * 1.005) t2 = null;
    const rr = entry && stop && t1 && entry > stop ? (t1 - entry) / (entry - stop) : null;

    // A buy with little room to the next supply zone is not worth it yet
    let note = '';
    let rrOut = rr;
    // Buying the dip only makes sense if the dip leaves room to the next supply zone
    if (action === 'BUY ON DIP' && (rr == null || rr < 1.5)) {
      action = 'WAIT'; tone = 'wait';
      note = rr == null
        ? `Leaning bullish, but there is no clear demand zone and stop to buy from on this chart. Wait.`
        : `Leaning bullish, but even a dip to ${rs(entry)} leaves only ${rr.toFixed(1)}× the risk before the next supply zone at ${rs(t1)}. Wait.`;
    }
    if (action === 'BUY' && rr != null && rr < 1.5) {
      action = 'WAIT'; tone = 'wait';
      note = `Strategies point up, but the supply zone at ${rs(t1)} is close: the possible gain is only ${rr.toFixed(1)}× the risk. Wait for a dip to the demand zone${D ? ` (${rs(D.proximal)})` : ''} or a breakout above ${rs(S ? S.distal : t1)}.`;
      if (D) {
        entry = D.proximal; entryZone = [D.distal, D.proximal]; stop = stopOf(D);
        rrOut = t1 && entry > stop ? (t1 - entry) / (entry - stop) : null;
      }
    }

    // Plain-words instruction
    let say;
    if (action === 'BUY') say = `Buy now around ${rs(p)}${entryZone ? ` (demand zone ${rs(entryZone[0])} – ${rs(entryZone[1])})` : ''}. Stop-loss ${rs(stop)}: exit if a ${kind === 'pos' ? 'day' : '15-min candle'} closes below it. Book profit near ${rs(t1)}${t2 ? `, then ${rs(t2)}` : ''}.`;
    else if (action === 'BUY ON DIP') say = `Don't buy at ${rs(p)}. Buy only if it dips to ${rs(entry)} (${D ? 'demand zone' : 'strategy buy zone'} ${rs(entryZone[0])} – ${rs(entryZone[1])}), stop-loss ${rs(stop)}, target ${rs(t1)}.`;
    else if (action === 'SELL') say = `If you hold it, sell / book profit around ${rs(p)}${S && atSupply ? ` (price has reached the supply zone ${rs(S.proximal)} – ${rs(S.distal)})` : ''}${c.tone === 'short' ? '; strategies point down' : ''}. Don't buy now${entry ? `; look again near ${rs(entry)}` : ''}.`;
    else say = note || (entry ? `No trade now. Buy near ${rs(entry)} if price comes down to the ${D ? 'demand' : 'strategy buy'} zone${t1 ? `; the next supply (selling) zone is ${rs(t1)}` : ''}.` : 'No trade now: no demand zone below the price on this chart.');

    const strategies = [];
    if (c.supporting && c.supporting.length) strategies.push(`${c.tone === 'short' ? 'Sell' : 'Buy'} signal from ${c.supporting.length} of ${c.of}: ${c.supporting.join(', ')}.`);
    else strategies.push(`None of the ${c.of} strategies has a complete signal.`);
    if (c.settingUp && c.settingUp.length) strategies.push(`Getting close: ${c.settingUp.slice(0, 4).join(', ')}${c.settingUp.length > 4 ? '…' : ''}.`);
    if (c.against && c.against.length) strategies.push(`Against: ${c.against.join(', ')}.`);

    const zone = z => z && { proximal: z.proximal, distal: z.distal, stop: stopOf(z) };
    // Who backs this call: a Proven strategy, a Watch one, or only the zones
    const backing = action === 'SELL' ? (c.tone === 'short' ? 'counted' : 'zone') : c.tone === 'long' && c.backing && c.backing !== 'none' ? c.backing : 'zone';
    if (backing === 'zone' && action !== 'WAIT' && c.notCounted && c.notCounted.length) strategies.push(`Not counted (not proven in the back-test): ${c.notCounted.slice(0, 4).join(', ')}.`);
    return { action, tone, say, price: p, entry, entryZone, stop, t1, t2, rr: rrOut, agree: c.agree, of: c.of, score: c.score, backing, strategies, concepts, zones,
      demand: zone(D), supply: zone(S), at: Date.now() };
  }

  // ---------- state, alerts ----------
  const S = { items: [], rows: new Map(), busy: false, lastRun: 0, loaded: false, timer: null, progress: 0 };
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem('mm-wl-seen') || '{}'); if (seen.date !== istDate()) seen = { date: istDate() }; } catch { seen = { date: istDate() }; }
  const saveSeen = () => { try { localStorage.setItem('mm-wl-seen', JSON.stringify(seen)); } catch { /* storage unavailable */ } };

  function alertsFor(row) {
    if (!marketOpen()) return;
    for (const kind of ['pos', 'intra']) {
      const c = row[kind];
      if (!c || c.error) continue;
      const key = `${row.symbol}|${kind}`;
      const prev = seen[key] || {};
      const label = kind === 'pos' ? 'positional' : 'intraday';
      const msgs = [];
      if (prev.action && prev.action !== c.action) msgs.push(`${row.symbol} (${label}): ${prev.action} → ${c.action} at ${rs(c.price)}`);
      if (c.action === 'BUY ON DIP' && c.entry && c.price <= c.entry && !prev.hitEntry) { msgs.push(`${row.symbol} (${label}) reached the buy zone ${rs(c.entry)}`); prev.hitEntry = true; }
      if (c.t1 && c.price >= c.t1 && !prev.hitTarget) { msgs.push(`${row.symbol} (${label}) reached the target / supply zone ${rs(c.t1)}`); prev.hitTarget = true; }
      if (c.stop && c.price < c.stop && !prev.hitStop) { msgs.push(`${row.symbol} (${label}) fell below the stop-loss ${rs(c.stop)}`); prev.hitStop = true; }
      seen[key] = { ...prev, action: c.action };
      msgs.forEach(m => toast(m, /BUY|buy zone|target/.test(m) && !/SELL|below/.test(m) ? 'success' : 'warning'));
    }
    saveSeen();
  }

  async function refreshAll(container) {
    if (S.busy || !S.items.length) return;
    S.busy = true; S.progress = 0;
    const queue = [...S.items];
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        try { const row = await analyse(it.symbol); row.name = it.name || row.name; S.rows.set(it.symbol, row); alertsFor(row); }
        catch (e) { S.rows.set(it.symbol, { symbol: it.symbol, name: it.name, error: e.message }); }
        S.progress++;
        if (container && pageActive()) render(container);
      }
    };
    try { await Promise.all([worker(), worker()]); }
    finally { S.busy = false; S.lastRun = Date.now(); await loadTrack(); if (container && pageActive()) render(container); }
  }

  const pageActive = () => { const p = document.getElementById('page-watchlist'); return p && p.classList.contains('active'); };
  // Re-check interval: every minute, slower for long lists so ICICI's rate limit is respected
  const intervalMs = () => Math.max(60e3, S.items.length * 3 * 1300);

  function startLoop() {
    if (S.timer) return;
    const tick = async () => {
      // Pick up changes made on other devices every 5 minutes
      if (!S.loaded || Date.now() - (S.listAt || 0) > 5 * 60e3) { try { S.items = (await call('list')).items; S.loaded = true; S.listAt = Date.now(); } catch { if (!S.loaded) return; } }
      if (marketOpen() && !document.hidden && Date.now() - S.lastRun >= intervalMs() - 5e3) refreshAll(document.getElementById('watchlist-container'));
    };
    S.timer = setInterval(tick, 15e3);
    tick();
  }

  // ---------- rendering ----------
  let results = null;
  async function resultsDates() {
    if (results) return results;
    try { const cal = await (await fetch('api/events.php?action=calendar')).json(); results = {}; for (const m of cal.meetings || []) if (m.results && !results[m.symbol]) results[m.symbol] = m.date; }
    catch { results = {}; }
    return results;
  }
  const daysUntil = d => Math.round((new Date(d + 'T00:00:00') - new Date(istDate() + 'T00:00:00')) / 864e5);

  function callBox(c, kind) {
    const title = kind === 'pos' ? 'Positional · daily chart' : 'Intraday · 15-min chart';
    if (!c) return `<div class="wl-col"><div class="wl-col-title">${title}</div><p class="muted">Checking…</p></div>`;
    if (c.error) return `<div class="wl-col"><div class="wl-col-title">${title}</div><p class="muted">Not available: ${esc(c.error)}</p></div>`;
    const lv = (label, v, cls) => `<div><span class="label">${label}</span><b class="${cls || ''}">${v}</b></div>`;
    const entryTxt = c.entryZone ? `${rs(c.entryZone[0])} – ${rs(c.entryZone[1])}` : rs(c.entry);
    return `<div class="wl-col">
      <div class="wl-col-title">${title}${kind === 'intra' && !marketOpen() ? ' <span class="muted">(for the next session)</span>' : ''}</div>
      <div class="wl-call-row"><span class="wl-call ${c.tone}">${c.action}</span>${backingTag(c)}</div>
      <p class="wl-say">${esc(c.say)}</p>
      <div class="wl-levels">
        ${lv(c.action === 'SELL' ? 'Buy again near' : 'Entry (demand)', entryTxt)}
        ${lv('Stop-loss', rs(c.stop), 'text-red')}
        ${lv('Target 1 (supply)', rs(c.t1), 'text-green')}
        ${lv('Target 2', rs(c.t2), 'text-green')}
        ${lv('Reward : risk', c.rr != null ? '1 : ' + c.rr.toFixed(1) : '—')}
      </div>
      <details class="wl-why"><summary>Why: strategies, concepts, zones</summary>
        <ul>${[...c.strategies, ...c.concepts, ...c.zones].map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      </details>
    </div>`;
  }

  // Proven / Watch / zone-only tag for a call
  function backingTag(c) {
    if (!c || c.action === 'WAIT') return `<span class="muted">${c ? `${c.agree}/${c.of} strategies` : ''}</span>`;
    if (c.backing === 'proven') return '<span class="tier tier-proven" title="Backed by a strategy that is proven in the 5-year back-test">Proven</span>';
    if (c.backing === 'watch') return '<span class="tier tier-watch" title="Backed only by Watch strategies (small positive back-test, half weight)">Watch</span>';
    if (c.backing === 'counted') return '<span class="tier tier-watch">Strategies</span>';
    return root.Tiers ? Tiers.zoneBadge() : '';
  }

  // Compact one-line summary of a call, for the collapsed row
  function callLine(c) {
    if (!c) return '<span class="muted">Checking…</span>';
    if (c.error) return `<span class="muted">Not available</span>`;
    const r0 = v => (v == null || !isFinite(v) ? '—' : '₹' + Math.round(v).toLocaleString('en-IN'));
    const e = c.entryZone ? `${r0(c.entryZone[0])}–${r0(c.entryZone[1])}` : r0(c.entry);
    const bits = c.action === 'SELL'
      ? [`Book profit ~<b>${r0(c.price)}</b>`, c.entry || c.entryZone ? `re-buy ${e}` : '']
      : [c.entry || c.entryZone ? `Entry ${e}` : '', c.stop ? `SL <b class="text-red">${r0(c.stop)}</b>` : '', c.t1 ? `T1 <b class="text-green">${r0(c.t1)}</b>` : '', c.rr != null && c.action !== 'WAIT' ? `R:R ${c.rr.toFixed(1)}` : ''];
    const filtered = bits.filter(Boolean);
    const mini = c.action === 'WAIT' ? '' : c.backing === 'proven' ? '<span class="tier tier-proven sm">P</span>' : c.backing === 'watch' || c.backing === 'counted' ? '<span class="tier tier-watch sm">W</span>' : '<span class="tier tier-unproven sm" title="Zone only · not proven">Z</span>';
    return `<span class="wl-call ${c.tone}">${c.action}</span>${mini}<span class="wl-line">${filtered.join(' · ') || esc(c.say).slice(0, 60)}</span>`;
  }
  let view = 'pos';
  try { view = localStorage.getItem('mm-wl-view') === 'intra' ? 'intra' : 'pos'; } catch { /* default */ }
  const openRows = new Set();

  function render(container) {
    const rows = S.items.map(it => S.rows.get(it.symbol) || { symbol: it.symbol, name: it.name });
    const count = a => rows.filter(r => r[view] && r[view].action === a).length;
    const time = S.lastRun ? new Date(S.lastRun).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
    const bar = S.busy
      ? `<span class="live-dot"></span><span>Checking ${S.progress} of ${S.items.length} stocks…</span>`
      : marketOpen()
        ? `<span class="live-dot"></span><span><strong>Live</strong> · re-checks every ${Math.round(intervalMs() / 60e3)} min on live prices${time ? ` · last check ${time}` : ''}. Pop-ups when a call changes or a level is reached.</span><button type="button" class="live-toggle" id="wl-refresh">Check now</button>`
        : `<span class="tag tag-yellow">Market closed</span><span>Calls use the last traded prices${time ? ` (checked ${time})` : ''}.</span><button type="button" class="live-toggle" id="wl-refresh">Check now</button>`;
    container.innerHTML = `
      <div class="fno-controls">
        <label>Add a stock<input type="text" id="wl-add-sym" placeholder="e.g. RELIANCE" autocomplete="off" /></label>
        <button type="button" class="btn-primary" id="wl-add">Add</button>
        <span class="muted">${S.items.length} of 30</span>
      </div>
      <div class="live-bar">${bar}</div>
      ${S.items.length ? `<div class="wl-toolbar">
        <div class="seg" role="tablist"><button type="button" role="tab" data-view="pos" class="${view === 'pos' ? 'active' : ''}">Positional</button><button type="button" role="tab" data-view="intra" class="${view === 'intra' ? 'active' : ''}">Intraday</button></div>
        <div class="wl-summary"><span class="wl-call buy">BUY ${count('BUY')}</span><span class="wl-call dip">DIP ${count('BUY ON DIP')}</span><span class="wl-call sell">SELL ${count('SELL')}</span><span class="wl-call wait">WAIT ${count('WAIT')}</span></div>
      </div>` : ''}
      ${S.items.length ? rows.map(r => {
        const res = results && results[r.symbol] && daysUntil(results[r.symbol]) >= 0 && daysUntil(results[r.symbol]) <= 7 ? `<span class="tag tag-orange">Results ${daysUntil(results[r.symbol]) === 0 ? 'today' : 'in ' + daysUntil(results[r.symbol]) + 'd'}: levels may not hold</span>` : '';
        const id = (S.items.find(i => i.symbol === r.symbol) || {}).id;
        const isOpen = openRows.has(r.symbol);
        return `<div class="wl-card${isOpen ? ' open' : ''}">
          <button type="button" class="wl-row" data-toggle="${esc(r.symbol)}" aria-expanded="${isOpen}">
            <div class="wl-row-top">
              <div class="wl-id"><b class="wl-sym">${esc(r.symbol)}</b><small>${esc(String(r.name || '').slice(0, 34))}</small></div>
              <div class="wl-price">${r.price != null ? `<b>${rs(r.price)}</b><small class="${r.change > 0 ? 'up' : r.change < 0 ? 'down' : ''}">${pct(r.change)}</small>` : ''}</div>
            </div>
            <div class="wl-row-call">${r.error ? `<span class="muted">Couldn't check: ${esc(r.error)}</span>` : callLine(r[view])}<span class="wl-chev" aria-hidden="true">›</span></div>
            ${res ? `<div>${res}</div>` : ''}
          </button>
          ${isOpen ? `<div class="wl-detail">
            ${r.error ? '' : callBox(r[view], view)}
            ${trackHtml(r.symbol)}
            ${r.opt ? `<details class="wl-opt"><summary>Options · buy &amp; sell points (ATM, lot ${r.opt.lot})</summary>${FnO.plansHtml(r.opt, null, true)}</details>` : ''}
            <div class="wl-actions"><button type="button" class="btn-primary" data-stock="${esc(r.symbol)}">Chart, all timeframes &amp; live buyers</button><button type="button" class="btn-secondary" data-analyze="${esc(r.symbol)}">Full analysis</button><button type="button" class="btn-danger" data-remove="${id}">Remove</button></div>
          </div>` : ''}
        </div>`;
      }).join('') : '<p class="muted" style="padding:8px 0;">Add stocks to get buy and sell calls with entry, stop-loss and targets from demand and supply zones.</p>'}
      <p class="citation">BUY = buy now; BUY ON DIP = buy only if price falls to the demand zone; SELL = sell / book profit if you hold it; WAIT = no trade. Entry and stop come from the nearest demand zone, targets from the supply zones above. Calls combine the 24 strategies with trend, RSI, moving-average and MACD checks. Not a recommendation.</p>`;
    wire(container);
  }

  function wire(container) {
    container.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => { view = b.dataset.view; try { localStorage.setItem('mm-wl-view', view); } catch { /* ok */ } render(container); }; });
    container.querySelectorAll('[data-stock]').forEach(b => { b.onclick = () => root.Stock && Stock.open(b.dataset.stock); });
    container.querySelectorAll('[data-toggle]').forEach(b => { b.onclick = () => { const k = b.dataset.toggle; openRows.has(k) ? openRows.delete(k) : openRows.add(k); render(container); }; });
    const input = container.querySelector('#wl-add-sym');
    if (root.StockPicker) root.StockPicker.attach(input, { popular: [] });
    const add = async () => {
      const sym = (input.value || '').trim().toUpperCase().split(/\s|—/)[0];
      if (!sym) return;
      try {
        S.items = (await call('add', { symbol: sym })).items;
        render(container);
        const it = S.items.find(i => i.symbol === sym);
        if (it && !S.rows.has(sym)) {
          const row = await analyse(sym).catch(e => ({ symbol: sym, error: e.message }));
          row.name = it.name || row.name; S.rows.set(sym, row); seen[`${sym}|pos`] = { action: row.pos && row.pos.action }; seen[`${sym}|intra`] = { action: row.intra && row.intra.action }; saveSeen();
          render(container);
        }
      } catch (e) { toast(e.message, 'warning'); }
    };
    container.querySelector('#wl-add').onclick = add;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    const rf = container.querySelector('#wl-refresh');
    if (rf) rf.onclick = () => refreshAll(container);
    container.querySelectorAll('[data-remove]').forEach(b => {
      b.onclick = async () => {
        try { S.items = (await call('remove', { id: Number(b.dataset.remove) })).items; render(container); } catch (e) { toast(e.message, 'warning'); }
      };
    });
    container.querySelectorAll('[data-analyze]').forEach(b => {
      b.onclick = () => {
        const i = document.getElementById('analyze-custom-symbol'); if (i) i.value = b.dataset.analyze;
        const tf = document.getElementById('analyze-timeframe'); if (tf) tf.value = '1d';
        const st = document.getElementById('analyze-strategy'); if (st) st.value = '__all';
        document.querySelector('#nav-links a[data-page="analyze"]').click();
        setTimeout(() => document.getElementById('btn-analyze')?.click(), 400);
      };
    });
  }

  async function renderPage(container) {
    if (!container) return;
    // Always re-read the list: it may have changed on another device or tab
    if (!S.loaded) container.innerHTML = '<p class="muted" style="padding:16px;">Loading your watchlist…</p>';
    try { S.items = (await call('list')).items; S.loaded = true; } catch (e) { if (!S.loaded) { container.innerHTML = `<div class="data-warning">${esc(e.message)}</div>`; return; } }
    const missing = S.items.some(it => !S.rows.has(it.symbol));
    await Promise.all([resultsDates(), loadTrack(true)]);
    render(container);
    startLoop();
    // Fresh calls when the page opens (if the last check is more than a minute old, or a stock is new)
    if (missing || Date.now() - S.lastRun > 60e3) refreshAll(container);
  }

  // Keep checking in the background (pop-ups on any page) once someone is signed in
  function autoStart() {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (root.Account && root.Account.user && root.app && root.app.analysis && root.Opportunities) { clearInterval(iv); startLoop(); }
      else if (tries > 120) clearInterval(iv);
    }, 1000);
  }
  if (typeof document !== 'undefined') autoStart();

  root.Watchlist = { renderPage, _makeCall: makeCall, _toHourly: toHourly };
})(typeof window !== 'undefined' ? window : globalThis);

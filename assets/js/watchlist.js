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
    const strongStrategies = c.verdict === 'Buy' && c.agree >= 2;
    if (c.tone === 'short' || atSupply) { action = 'SELL'; tone = 'sell'; }
    else if (htf !== 'Bearish' && (strongStrategies || (inDemand && D.qualifies && c.agree >= 1))) { action = 'BUY'; tone = 'buy'; }
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
    return { action, tone, say, price: p, entry, entryZone, stop, t1, t2, rr: rrOut, agree: c.agree, of: c.of, strategies, concepts, zones,
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
    finally { S.busy = false; S.lastRun = Date.now(); if (container && pageActive()) render(container); }
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
      <div class="wl-call-row"><span class="wl-call ${c.tone}">${c.action}</span><span class="muted">${c.agree}/${c.of} strategies</span></div>
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

  function render(container) {
    const rows = S.items.map(it => S.rows.get(it.symbol) || { symbol: it.symbol, name: it.name });
    const count = a => rows.filter(r => r.pos && r.pos.action === a).length;
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
      ${S.items.length ? `<div class="wl-summary">Positional calls: <span class="wl-call buy">BUY ${count('BUY')}</span> <span class="wl-call dip">BUY ON DIP ${count('BUY ON DIP')}</span> <span class="wl-call sell">SELL ${count('SELL')}</span> <span class="wl-call wait">WAIT ${count('WAIT')}</span></div>` : ''}
      ${S.items.length ? rows.map(r => {
        const res = results && results[r.symbol] && daysUntil(results[r.symbol]) >= 0 && daysUntil(results[r.symbol]) <= 7 ? `<span class="tag tag-orange">Results ${daysUntil(results[r.symbol]) === 0 ? 'today' : 'in ' + daysUntil(results[r.symbol]) + 'd'}: levels may not hold</span>` : '';
        const id = (S.items.find(i => i.symbol === r.symbol) || {}).id;
        return `<div class="wl-card">
          <div class="wl-head">
            <div><b class="wl-sym">${esc(r.symbol)}</b> <span class="muted">${esc(String(r.name || '').slice(0, 40))}</span> ${res}</div>
            <div class="wl-price">${r.price != null ? `${rs(r.price)} <span class="${r.change > 0 ? 'text-green' : r.change < 0 ? 'text-red' : ''}">${pct(r.change)}</span>` : ''}
              <button type="button" class="link-btn" data-analyze="${esc(r.symbol)}">Analyze</button>
              <button type="button" class="link-btn" data-remove="${id}">Remove</button></div>
          </div>
          ${r.error ? `<p class="muted">Couldn't check ${esc(r.symbol)}: ${esc(r.error)}</p>` : `<div class="wl-cols">${callBox(r.pos, 'pos')}${callBox(r.intra, 'intra')}</div>${r.opt ? `<details class="wl-opt" open><summary>Options · buy &amp; sell points (${esc(r.symbol)} ATM, lot ${r.opt.lot})</summary>${FnO.plansHtml(r.opt, null, true)}</details>` : ''}`}
        </div>`;
      }).join('') : '<p class="muted" style="padding:8px 0;">Add stocks to get buy and sell calls with entry, stop-loss and targets from demand and supply zones.</p>'}
      <p class="citation">BUY = buy now; BUY ON DIP = buy only if price falls to the demand zone; SELL = sell / book profit if you hold it; WAIT = no trade. Entry and stop come from the nearest demand zone, targets from the supply zones above. Calls combine the 24 strategies with trend, RSI, moving-average and MACD checks. Not a recommendation.</p>`;
    wire(container);
  }

  function wire(container) {
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
    await resultsDates();
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

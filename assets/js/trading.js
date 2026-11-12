// ============================================================
// MarketMind AI — one-tap trading (admin only)
//
// While MarketMind is open during market hours, the scanner checks the trading watchlist
// every minute and proposes orders:
//   Delivery (CNC)  daily verdict "Buy" / "Buy on dip"  -> limit buy, stop and target from the verdict
//   Intraday (MIS)  15-minute verdict "Buy" before 2:45 pm -> limit buy; squared off from 3:10 pm
//   Options         daily verdict bullish -> buy ATM call; bearish -> buy ATM put (expiry 5+ days out)
// and exits for open positions (target reached, intraday square-off, options on expiry day).
// Nothing is sent until you tap Approve; the server re-checks every limit first.
// Without the VPS order relay, approved orders are simulated (TEST mode).
// ============================================================
(function (root) {
  'use strict';

  const API = 'api/trade.php';
  const SCAN_MS = 60e3;
  let st = null;              // last server state
  let timer = null, scanning = false, lastScan = null, scanNote = '';
  let foMeta = null;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = (v, d = 2) => (v == null || !isFinite(v) ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const n0 = v => Math.round(v).toLocaleString('en-IN');
  const istMins = () => { const d = new Date(Date.now() + 5.5 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const marketOpen = () => { const d = new Date(Date.now() + 5.5 * 3600e3); const m = istMins(); return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && m >= 555 && m <= 930; };
  const toast = (m, t) => root.app && root.app.ui && root.app.ui._toast(m, t || 'info');

  async function call(action, body) {
    const opts = { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-Requested-With'] = 'MarketMind';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${API}?action=${action}`, opts);
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }
  async function breeze(params) {
    const r = await fetch('api/breeze.php?' + new URLSearchParams(params), { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }

  // ---------- prices ----------
  async function stockLtp(symbol) { const q = await MarketData.getQuote(symbol); return q && q.ltp; }
  async function optionRow(isec, expiry, right, strike) {
    const c = await breeze({ action: 'option_chain', isec, expiry, right });
    return c.rows.find(r => Number(r.strike) === Number(strike)) || null;
  }
  async function futRow(isec, expiry) { return breeze({ action: 'futures', isec, expiry }); }
  async function priceOf(o) {
    if (o.product === 'option') { const r = await optionRow(o.opt_isec, o.opt_expiry, o.opt_right, o.opt_strike); return r && r.ltp; }
    if (o.product === 'future') { const f = await futRow(o.opt_isec, o.opt_expiry); return f && f.ltp; }
    return stockLtp(o.symbol);
  }

  // ---------- sizing ----------
  function stockQty(S, entry, stop) {
    if (!(entry > stop)) return 0;
    const byRisk = Math.floor(S.account * S.riskPct / 100 / (entry - stop));
    const byCap = Math.floor(S.maxPerTrade / entry);
    return Math.max(0, Math.min(byRisk, byCap));
  }

  // ---------- proposals ----------
  const regimeUp = () => { const m = root.Tiers && Tiers.market(); return !m || m.above200 !== false; };
  const provenLong = c => c && c.tone === 'long' && c.backing === 'proven' && regimeUp();
  const daysTo = d => (Date.parse(d + 'T10:00:00Z') - Date.now()) / 864e5;
  async function stockIdea(w, product) {
    const tf = product === 'mis' ? '15m' : '1d';
    const res = await root.app.analysis.analyzeStock(w.symbol, '__all', tf, null, {});
    const md = res.marketData, c = res.consensus && res.consensus.conclusion;
    if (!md.live || !c || c.tone !== 'long') return null;
    if (product === 'mis' && c.verdict !== 'Buy') return null;              // intraday: only when price is in the zone now
    // Live rules (12 Nov 2026): only ideas backed by a Proven strategy, gain at least 1.5× the risk,
    // and new buys only while NIFTY is above its 200-day average (market regime filter)
    if (!provenLong(c) || !(c.rr >= 1.5)) return null;
    if (product === 'cnc' && res.ks001 && res.ks001.trends.htf.trend === 'Bearish') return null;  // no delivery buys against a falling monthly trend
    const entry = c.verdict === 'Buy' ? Math.min(md.price, c.buyHigh || md.price) : c.buyHigh;
    if (!(entry > 0) || c.stop == null || c.sell1 == null) return null;
    const qty = stockQty(st.settings, entry, c.stop);
    if (qty < 1) return null;
    const why = c.verdict === 'Buy'
      ? `Buy backed by ${c.supporting.join(', ')} and price ₹${md.price.toFixed(2)} is in the buy zone.`
      : `Buy backed by ${c.supporting.join(', ')}; this limit order waits for a dip to ₹${entry.toFixed(2)}.`;
    return {
      purpose: 'entry', product, symbol: w.symbol, name: w.name || md.name, qty, lot: 1, limit: +entry.toFixed(2),
      stop: c.stop, target: c.sell1, timeframe: tf, verdict: c.verdict,
      reason: `${product === 'mis' ? 'Intraday (15-minute chart)' : 'Delivery (daily chart)'}: ${why} Stop-loss ₹${c.stop.toFixed(2)}, target ₹${c.sell1.toFixed(2)} (gain ${c.rr ? c.rr.toFixed(1) : '?'}× the risk). Risk if stopped: ${rs((entry - c.stop) * qty, 0)}.`,
    };
  }

  async function optionIdea(w) {
    if (!foMeta) foMeta = (await breeze({ action: 'fo_meta' })).underlyings;
    const u = foMeta.find(x => x.symbol === w.symbol || x.isec === w.symbol);
    if (!u) return null;
    const res = await root.app.analysis.analyzeStock(w.symbol, '__all', '1d', null, {});
    const c = res.consensus && res.consensus.conclusion;
    if (!res.marketData.live || !c || (c.tone !== 'long' && c.tone !== 'short') || (c.tone === 'long' && c.verdict !== 'Buy')) return null;
    // Calls: Proven buy signal in a rising market. Puts: a counted short signal (shorts count only when NIFTY is below its 200-day)
    if (c.tone === 'long' ? !provenLong(c) : !(Tiers.isStrong({ score: c.scoreShort }))) return null;
    const right = c.tone === 'long' ? 'call' : 'put';
    const expiry = u.options.find(d => daysTo(d) >= 15);   // 15+ days left, so time decay is slow
    if (!expiry) return null;
    const chain = await breeze({ action: 'option_chain', isec: u.isec, expiry, right });
    const spot = (chain.rows.find(r => r.spot > 0) || {}).spot || res.marketData.price;
    const atm = chain.rows.reduce((b, r) => (b == null || Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b), null);
    if (!atm || !(atm.ltp > 0)) return null;
    const S = st.settings, lot = u.lot || 1;
    const prem = atm.ask > 0 ? atm.ask : atm.ltp;
    const stop = prem * (1 - S.optionStopPct / 100), target = prem * (1 + S.optionTargetPct / 100);
    // Option buying may risk up to optionRiskPct of capital per trade (premium × stop %), within the per-trade value cap
    const lots = Math.min(Math.floor(S.account * (S.optionRiskPct || 5) / 100 / ((prem - stop) * lot)), Math.floor(S.maxPerTrade / (prem * lot)));
    if (lots < 1) { scanNote = `${w.symbol} option: one lot (${rs(prem * lot, 0)}) needs more than your option risk limit of ${S.optionRiskPct || 5}% of capital, so it was skipped.`; return null; }
    return {
      purpose: 'entry', product: 'option', symbol: w.symbol, name: `${w.symbol} ${atm.strike} ${right === 'call' ? 'CE' : 'PE'} ${expiry}`,
      qty: lots * lot, lot, limit: +prem.toFixed(2), stop: +stop.toFixed(2), target: +target.toFixed(2), timeframe: '1d', verdict: c.verdict,
      option: { isec: u.isec, expiry, strike: atm.strike, right },
      reason: `Options: ${w.symbol}'s daily verdict is "${c.verdict}", so buy the at-the-money ${right} (${atm.strike} ${right === 'call' ? 'CE' : 'PE'}, expiry ${expiry}) at about ${rs(prem)}. ` +
        `${lots} lot${lots > 1 ? 's' : ''} × ${lot} = ${rs(prem * lots * lot, 0)} premium, the most you can lose. Stop if the premium falls to ${rs(stop)} (−${S.optionStopPct}%), target ${rs(target)} (+${S.optionTargetPct}%).`,
    };
  }

  // Futures: long only, on a Proven buy signal. Paper (simulated) until futures are switched on with enough margin.
  async function futureIdea(w) {
    if (!foMeta) foMeta = (await breeze({ action: 'fo_meta' })).underlyings;
    const u = foMeta.find(x => x.symbol === w.symbol || x.isec === w.symbol);
    if (!u || !u.futures || !u.futures.length) return null;
    const res = await root.app.analysis.analyzeStock(w.symbol, '__all', '1d', null, {});
    const md = res.marketData, c = res.consensus && res.consensus.conclusion;
    if (!md.live || !c || c.verdict !== 'Buy' || !provenLong(c) || !(c.rr >= 1.5) || c.stop == null || c.sell1 == null) return null;
    const expiry = u.futures.find(d => daysTo(d) >= 7) || u.futures[u.futures.length - 1];
    const f = await futRow(u.isec, expiry);
    const fp = f.ask > 0 ? f.ask : f.ltp;
    if (!(fp > 0)) return null;
    // Futures trade at a premium to spot: keep the same distances to stop and target
    const spot = f.spot || md.price, stop = fp - (spot - c.stop), target = fp + (c.sell1 - spot);
    if (!(stop < fp && target > fp)) return null;
    const S = st.settings, lot = u.lot || f.lot || 1;
    const perLot = (fp - stop) * lot, cap = S.account * (S.futuresRiskPct || 2) / 100;
    const lots = Math.max(1, Math.floor(cap / perLot));
    const fits = perLot <= cap;
    return {
      purpose: 'entry', product: 'future', symbol: w.symbol, name: `${w.symbol} FUT ${expiry}`, qty: lots * lot, lot, limit: +fp.toFixed(2),
      stop: +stop.toFixed(2), target: +target.toFixed(2), timeframe: '1d', verdict: c.verdict, option: { isec: u.isec, expiry },
      reason: `Futures${S.futuresLive ? '' : ' (paper trade, simulated)'}: buy backed by ${c.supporting.join(', ')}. ${lots} lot × ${lot} at about ${rs(fp)} (exposure ${rs(fp * lot * lots, 0)}). ` +
        `Stop ${rs(stop)}, target ${rs(target)}. Risk at the stop ${rs(perLot * lots, 0)}${fits ? '' : ` — more than your futures limit of ${S.futuresRiskPct || 2}% (${rs(cap, 0)}); live futures need capital of about ${rs(perLot / ((S.futuresRiskPct || 2) / 100), 0)}`}.`,
    };
  }

  // Exits for filled positions, plus simulated fills in test mode
  async function exitsAndFills(fills, proposals) {
    const now = istMins();
    for (const o of st.orders) {
      if (o.status === 'open' && o.mode === 'test') {
        const p = await priceOf(o).catch(() => null);
        if (!p) continue;
        const lim = Number(o.limit_price), trig = Number(o.trigger_price);
        if (o.order_type === 'stoploss' ? p <= trig : o.side === 'buy' ? p <= lim : p >= lim) fills.push({ id: o.id, price: o.order_type === 'stoploss' ? p : lim });
      }
      if (o.status !== 'filled' || o.purpose !== 'entry') continue;
      const p = await priceOf(o).catch(() => null);
      if (!p) continue;
      const base = { parentId: o.id, product: o.product, symbol: o.symbol, name: o.name, qty: Number(o.qty), lot: Number(o.lot), timeframe: o.timeframe,
        option: ['option', 'future'].includes(o.product) ? { isec: o.opt_isec, expiry: o.opt_expiry, strike: o.opt_strike, right: o.opt_right } : undefined };
      const expiryDay = ['option', 'future'].includes(o.product) && o.opt_expiry === istToday();
      if ((o.product === 'mis' && now >= 15 * 60 + 10) || (expiryDay && now >= 14 * 60 + 30)) {
        proposals.push({ ...base, purpose: 'squareoff', limit: +(p * 0.998).toFixed(2), reason: `${o.product === 'mis' ? 'Intraday positions must be closed before 3:20 pm' : `The ${o.product === 'future' ? 'futures contract' : 'option'} expires today`}: sell at about ${rs(p)}.` });
      } else if (o.target != null && p >= Number(o.target)) {
        proposals.push({ ...base, purpose: 'target', limit: +p.toFixed(2), reason: `Target ${rs(Number(o.target))} reached (now ${rs(p)}): book the profit, about ${rs((p - Number(o.fill_price)) * Number(o.qty), 0)}.` });
      }
    }
  }

  async function scan(container) {
    if (scanning || !st) return;
    scanning = true;
    try {
      if (!marketOpen()) { scanNote = 'Market closed: the scanner runs 9:15 am – 3:30 pm IST, Mon–Fri.'; return; }
      if (!st.icici) { scanNote = 'ICICI is not logged in today: log in to ICICI so the scanner can read live prices.'; return; }
      const fills = [], proposals = [];
      await exitsAndFills(fills, proposals);
      st = await call('sync', { fills });
      if (st.settings.enabled && !st.settings.killed) {
        const later = istMins() > 14 * 60 + 45;
        for (const w of st.watchlist) {
          const tries = [];
          if (Number(w.delivery)) tries.push(() => stockIdea(w, 'cnc'));
          if (Number(w.intraday) && !later) tries.push(() => stockIdea(w, 'mis'));
          if (Number(w.options)) tries.push(() => optionIdea(w));
          if (Number(w.futures)) tries.push(() => futureIdea(w));
          for (const t of tries) {
            try { const idea = await t(); if (idea) proposals.push(idea); } catch (e) { console.warn('Scanner:', w.symbol, e.message); }
          }
        }
      }
      if (proposals.length) {
        const before = st.orders.filter(o => o.status === 'pending' && o.purpose === 'entry').length;
        st = await call('propose', { orders: proposals });
        const added = st.orders.filter(o => o.status === 'pending' && o.purpose === 'entry').length - before;
        if (added > 0) toast(`MarketMind has ${added} new trade idea${added > 1 ? 's' : ''} waiting for your approval (Trade page).`, 'success');
      }
      // Semi-automatic: stop-loss, target, square-off and exit orders are approved without waiting for you
      if (st.settings.automation === 'semi') {
        for (const o of st.orders.filter(x => x.status === 'pending' && x.purpose !== 'entry')) {
          try { st = await call('approve', { id: Number(o.id) }); toast(`Done automatically: ${PURPOSE[o.purpose] || o.purpose} ${o.product === 'option' || o.product === 'future' ? o.name : o.symbol}.`, 'info'); }
          catch (e) { console.warn('Auto-approve:', e.message); }
        }
      }
      scanNote = '';
    } catch (e) {
      scanNote = 'Last scan failed: ' + e.message;
    } finally {
      lastScan = Date.now();
      scanning = false;
      badge();
      if (container && document.getElementById('page-trading').classList.contains('active')) render(container);
    }
  }

  function badge() {
    const a = document.querySelector('#nav-links a[data-page="trading"]');
    if (!a || !st) return;
    const n = st.orders.filter(o => o.status === 'pending').length;
    let b = a.querySelector('.nav-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'nav-badge'; a.appendChild(b); }
    b.textContent = n;
  }

  // ---------- rendering ----------
  const PRODUCT = { cnc: 'Delivery', mis: 'Intraday', option: 'Option', future: 'Futures' };
  const PURPOSE = { entry: 'Buy', stoploss: 'Stop-loss', target: 'Sell at target', squareoff: 'Square off', exit: 'Exit' };
  const STATUS = { pending: 'Waiting for you', open: 'Sent, not filled', filled: 'Filled', closed: 'Closed', rejected: 'Rejected', expired: 'Expired', cancelled: 'Cancelled', failed: 'Failed' };

  // Stop — entry — target as a bar, with the current price marked when known
  function rrBar(entry, stop, target, now) {
    if (!(entry > 0 && stop > 0 && target > 0) || target === stop) return '';
    const lo = Math.min(stop, target), hi = Math.max(stop, target), at = v => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
    const long = target > stop, e = at(entry);
    return `<div class="tr-rr"><div class="tr-rr-track"><i class="risk" style="left:${long ? 0 : e}%;width:${long ? e : 100 - e}%"></i><i class="reward" style="left:${long ? e : 0}%;width:${long ? 100 - e : e}%"></i>
      <b class="mk entry" style="left:${e}%"></b>${now ? `<b class="mk now" style="left:${at(now)}%" title="now ${rs(now)}"></b>` : ''}</div>
      <div class="tr-rr-lab"><span class="down">Stop ${rs(stop)}</span><span>Entry ${rs(entry)}</span><span class="up">Target ${rs(target)}</span></div></div>`;
  }

  const productHelp = { cnc: 'Delivery (CNC): shares go to your demat and can be held for days or weeks.', mis: 'Intraday (MIS): must be closed today; MarketMind squares off by 3:15 pm.', option: 'Option buy (NRML): you pay the premium; the most you can lose is what you pay.', future: 'Futures (NRML): one lot controls a large amount (₹5–20 lakh), so profit and loss move fast. Paper trades only until you switch futures on.' };

  function orderCard(o) {
    const value = Number(o.limit_price) * Number(o.qty);
    const left = Math.max(0, Math.round((Date.parse(o.expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 60e3));
    const entry = Number(o.limit_price), stop = o.stop != null ? Number(o.stop) : null, target = o.target != null ? Number(o.target) : null;
    const units = Number(o.qty);
    const risk = stop != null ? Math.abs(entry - stop) * units : null, reward = target != null ? Math.abs(target - entry) * units : null;
    const what = o.product === 'option' || o.product === 'future' ? `${n0(units)} × ${esc(o.name)}` : `${n0(units)} shares of ${esc(o.symbol)}`;
    const isEntry = o.purpose === 'entry';
    return `<div class="tr-card tr-idea ${o.side}">
      <div class="tr-card-head">
        <span class="chip ${o.side === 'buy' ? 'chip-long' : 'chip-short'}">${esc(PURPOSE[o.purpose] || o.purpose)}</span>
        <span class="tag" title="${esc(productHelp[o.product] || '')}">${esc(PRODUCT[o.product])}</span>
        <span class="muted tr-exp">${left} min left to decide</span>
      </div>
      <h4 class="tr-headline">${o.side === 'buy' ? 'Buy' : 'Sell'} ${what} at ${o.order_type === 'stoploss' ? `trigger ${rs(Number(o.trigger_price))}` : rs(entry)}</h4>
      <div class="tr-facts">
        <div><span>Money needed</span><b>${rs(value, 0)}</b></div>
        ${risk != null && isEntry ? `<div><span>You could lose</span><b class="down">${rs(risk, 0)}</b></div>` : ''}
        ${reward != null && isEntry ? `<div><span>You could make</span><b class="up">${rs(reward, 0)}</b></div>` : ''}
        ${risk && reward && isEntry ? `<div><span>Reward : risk</span><b>${(reward / risk).toFixed(1)} : 1</b></div>` : ''}
      </div>
      ${isEntry ? rrBar(entry, stop, target) : ''}
      <div class="tr-why"><b>Why:</b> ${esc(o.reason || '—')}</div>
      <p class="muted small">${esc(productHelp[o.product] || '')}</p>
      <div class="tr-actions">
        <button type="button" class="btn-primary" data-approve="${o.id}">${st.mode === 'live' ? 'Approve & send to ICICI' : st.mode === 'man' ? 'Approve' : 'Approve (test)'}</button>
        <button type="button" class="btn-secondary" data-reject="${o.id}">Skip</button>
      </div>
    </div>`;
  }

  // Open position with live price, P&L and where it sits between stop and target
  function positionCard(o) {
    const q = ['option', 'future'].includes(o.product) ? quotes['o' + o.id] : quotes[o.symbol];
    const now = q && q.ltp ? q.ltp : null, buy = Number(o.fill_price), qty = Number(o.qty);
    const pnl = now ? (now - buy) * qty : null, r = now && o.stop ? (now - buy) / Math.abs(buy - Number(o.stop)) : null;
    return `<div class="tr-card tr-pos">
      <div class="tr-card-head"><strong>${esc(o.product === 'option' || o.product === 'future' ? o.name : o.symbol)}</strong><span class="tag" title="${esc(productHelp[o.product] || '')}">${esc(PRODUCT[o.product])}</span><span class="muted">${o.mode === 'live' ? 'Live' : o.mode === 'man' ? 'Manual' : 'Test'} · ${n0(qty)} @ ${rs(buy)}</span></div>
      <div class="tr-facts">
        <div><span>Now</span><b>${now ? rs(now) : '—'}</b></div>
        <div><span>Profit / loss</span><b class="${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}">${pnl != null ? (pnl > 0 ? '+' : '') + rs(pnl, 0) : '—'}</b></div>
        <div><span>In R</span><b class="${r > 0 ? 'up' : r < 0 ? 'down' : ''}">${r != null ? (r > 0 ? '+' : '') + r.toFixed(2) + 'R' : '—'}</b></div>
      </div>
      ${rrBar(buy, Number(o.stop), Number(o.target), now)}
      <div class="tr-actions"><button type="button" class="btn-secondary btn-small" data-exit="${o.id}">Exit now…</button></div>
    </div>`;
  }

  // What to enter in the ICICI Direct app's order screen
  function ticket(o) {
    const fut = o.product === 'future';
    const opt = o.product === 'option' || fut;
    const right = o.opt_right === 'put' ? 'Put (PE)' : 'Call (CE)';
    const expiry = o.opt_expiry ? new Date(o.opt_expiry + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const rows = [
      ['Stock', opt ? `${esc(o.symbol)}${o.icici_code && o.icici_code !== o.symbol ? ` (ICICI code ${esc(o.icici_code)})` : ''}` : `${esc(o.symbol)}${o.icici_code && o.icici_code !== o.symbol ? ` (ICICI code ${esc(o.icici_code)})` : ''}`],
      ['Segment', opt ? 'Derivatives (F&amp;O) · NSE' : 'Equity · NSE'],
      ...(fut ? [['Contract', `Futures · expiry ${esc(expiry)}`]] : opt ? [['Contract', `Options · ${right} · strike ${esc(Number(o.opt_strike))} · expiry ${esc(expiry)}`]] : []),
      ['Product', fut ? 'Futures (NRML)' : opt ? 'Options (NRML)' : o.product === 'mis' ? 'Margin / Intraday' : 'Cash / Delivery (CNC)'],
      ['Action', o.side === 'buy' ? '<b class="text-green">BUY</b>' : '<b class="text-red">SELL</b>'],
      ['Order type', o.order_type === 'stoploss' ? '<b>Stop loss (SL)</b>' : 'Limit'],
      ['Quantity', `<b>${n0(Number(o.qty))}</b>${opt ? ` (${Number(o.qty) / Number(o.lot)} lot of ${n0(Number(o.lot))})` : ''}`],
      ...(o.order_type === 'stoploss' ? [['Trigger price', `<b>${rs(Number(o.trigger_price))}</b>`]] : []),
      ['Limit price', `<b>${rs(Number(o.limit_price))}</b>`],
      ['Validity', 'Day'],
    ];
    return `<div class="tr-card ${o.side} tr-ticket">
      <div class="tr-card-head"><span class="chip ${o.side === 'buy' ? 'chip-long' : 'chip-short'}">${esc(PURPOSE[o.purpose] || o.purpose)}</span><strong>${esc(opt ? o.name : o.symbol)}</strong><span class="muted">approved ${new Date(o.decided_at.replace(' ', 'T') + 'Z').toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span></div>
      <table class="tr-ticket-table">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
      <p class="tr-reason">${o.order_type === 'stoploss' ? 'This order waits at ICICI and only sells if price falls to the trigger. When it executes, record the fill here.' : 'Place this in the ICICI Direct app. When it executes, enter the price shown in the ICICI order book.'}</p>
      <div class="tr-actions">
        <input type="number" step="0.05" min="0" class="tr-fill" data-fill-for="${o.id}" placeholder="Filled at ₹" value="" />
        <button type="button" class="btn-primary" data-fill="${o.id}">It executed: save</button>
        <button type="button" class="btn-secondary" data-mcancel="${o.id}">I didn't place it / cancelled</button>
      </div>
    </div>`;
  }

  let tab = 'ideas';
  try { tab = localStorage.getItem('mm-tr-tab') || 'ideas'; } catch { /* default */ }
  const quotes = {};

  function render(container) {
    if (!st) return;
    const S = st.settings;
    const pending = st.orders.filter(o => o.status === 'pending');
    const positions = st.orders.filter(o => o.purpose === 'entry' && o.status === 'filled');
    const history = st.orders.filter(o => o.status !== 'pending').slice(0, 60);
    const closed = st.orders.filter(o => o.status === 'closed');
    const realised = closed.reduce((a, o) => a + Number(o.pnl || 0), 0);
    const wins = closed.filter(o => Number(o.pnl) > 0).length;
    const toPlace = st.orders.filter(o => o.status === 'open' && o.mode === 'man');
    const today = st.orders.filter(o => o.purpose === 'entry' && String(o.created_at).slice(0, 10) === istToday() && ['open', 'filled', 'closed'].includes(o.status)).length;
    const openPnl = positions.reduce((a, o) => { const q = ['option', 'future'].includes(o.product) ? quotes['o' + o.id] : quotes[o.symbol]; return a + (q && q.ltp ? (q.ltp - Number(o.fill_price)) * Number(o.qty) : 0); }, 0);
    const modeTxt = { test: 'Approved orders are simulated against live prices. No real money.', man: 'You place approved orders yourself in the ICICI Direct app (real money).', live: 'Approved orders go to your ICICI account through the order relay.' };
    const TABS = [['ideas', `To approve${pending.length ? ` (${pending.length})` : ''}`], ['open', `Open${positions.length ? ` (${positions.length})` : ''}`], ['history', 'History'], ['setup', 'Setup']];
    const total = realised + openPnl;

    container.innerHTML = `
      <div class="tr-dash">
        <div class="tr-stat"><span>Mode</span>${st.mode === 'live' ? '<b class="down">LIVE</b>' : `<div class="seg seg-sm"><button type="button" data-mode="test" class="${st.mode === 'test' ? 'active' : ''}">Test</button><button type="button" data-mode="man" class="${st.mode === 'man' ? 'active' : ''}">Manual</button></div>`}<small>${esc(modeTxt[st.mode])}</small></div>
        <div class="tr-stat"><span>Capital · risk a trade</span><b>${rs(Number(S.account), 0)}</b><small>${S.riskPct}% = ${rs(Number(S.account) * S.riskPct / 100, 0)} a trade</small></div>
        <div class="tr-stat"><span>Today</span><b>${today} / ${S.maxOrdersDay} trades</b><small>${positions.length} / ${S.maxOpen} positions open</small></div>
        <div class="tr-stat"><span>Profit / loss</span><b class="${total > 0 ? 'up' : total < 0 ? 'down' : ''}">${rs(total, 0)}</b><small>booked ${rs(realised, 0)} · open ${rs(openPnl, 0)}</small></div>
      </div>
      <div class="tr-top">
        <label class="tr-switch"><input type="checkbox" id="tr-enabled" ${S.enabled ? 'checked' : ''} ${S.killed ? 'disabled' : ''}/> <span>Find new trade ideas</span></label>
        ${S.killed ? '<button type="button" class="btn-secondary" id="tr-resume">Kill switch is ON · turn trading back on</button>' : '<button type="button" class="btn-danger" id="tr-kill">Stop everything</button>'}
        <span class="tr-chips">
          <span class="chip ${st.icici ? 'chip-long' : 'chip-short'}">${st.icici ? 'ICICI connected' : 'ICICI not logged in today'}</span>
          <span class="chip">${marketOpen() ? 'Market open' : 'Market closed'}</span>
          <span class="chip">${lastScan ? `Checked ${new Date(lastScan).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Checking…'}</span>
        </span>
      </div>
      ${scanNote ? `<div class="data-warning">${esc(scanNote)}</div>` : ''}
      ${toPlace.length ? `<div class="analysis-section tr-place"><h3>Place these in the ICICI Direct app (${toPlace.length})</h3>${toPlace.map(ticket).join('')}</div>` : ''}

      <div class="seg tr-tabs">${TABS.map(([k, l]) => `<button type="button" data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>

      ${tab === 'ideas' ? `<div class="tr-pane">
        ${pending.length ? pending.map(orderCard).join('') : `<div class="home-empty"><p><b>No trade ideas waiting.</b></p><p>Every minute MarketMind checks the stocks in Setup. A new idea appears here (and as a pop-up) only when a tested strategy backs it and the reward is at least 1.5× the risk.${S.enabled ? '' : ' <b>Finding new ideas is switched off</b> above.'}</p></div>`}
      </div>` : ''}

      ${tab === 'open' ? `<div class="tr-pane">
        ${positions.length ? positions.map(positionCard).join('') : '<p class="home-empty">No open positions.</p>'}
        <p class="citation">After each buy, MarketMind proposes a stop-loss order that waits at ICICI, so you are protected even when the app is closed.</p>
      </div>` : ''}

      ${tab === 'history' ? `<div class="tr-pane">
        <div class="tr-dash sm"><div class="tr-stat"><span>Closed trades</span><b>${closed.length}</b></div><div class="tr-stat"><span>Winners</span><b>${closed.length ? Math.round(wins / closed.length * 100) + '%' : '—'}</b></div><div class="tr-stat"><span>Booked P&amp;L</span><b class="${realised > 0 ? 'up' : realised < 0 ? 'down' : ''}">${rs(realised, 0)}</b></div></div>
        ${history.length ? `<div class="fno-tablewrap"><table class="screener-table fno-table"><thead><tr><th>When</th><th>Order</th><th>Qty</th><th>Price</th><th>Result</th><th>P&amp;L</th></tr></thead><tbody>
          ${history.map(o => `<tr><td>${new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td>${esc(PURPOSE[o.purpose])} ${esc(o.product === 'option' ? o.name : o.symbol)} <span class="muted">${esc(PRODUCT[o.product])} · ${o.mode === 'live' ? 'live' : o.mode === 'man' ? 'manual' : 'test'}</span></td>
            <td>${n0(Number(o.qty))}</td><td>${rs(Number(o.fill_price || o.limit_price))}</td>
            <td>${esc(STATUS[o.status] || o.status)}${o.error ? `<br><span class="text-red">${esc(o.error)}</span>` : ''}</td>
            <td class="${Number(o.pnl) > 0 ? 'text-green' : Number(o.pnl) < 0 ? 'text-red' : ''}">${o.pnl != null ? rs(Number(o.pnl), 0) : ''}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="home-empty">No orders in the last 7 days.</p>'}
      </div>` : ''}

      ${tab === 'setup' ? `<div class="tr-pane">
        <div class="analysis-section"><h3>Stocks to watch for trades</h3>
          <p class="muted small">MarketMind only proposes trades on these. Tick how each one may be traded.</p>
          <div class="fno-controls"><label>Add a stock<input type="text" id="tr-add-sym" placeholder="e.g. RELIANCE" autocomplete="off" /></label>
            <label class="ev-check" title="${esc(productHelp.cnc)}"><input type="checkbox" id="tr-add-cnc" checked/> Delivery</label>
            <label class="ev-check" title="${esc(productHelp.mis)}"><input type="checkbox" id="tr-add-mis"/> Intraday</label>
            <label class="ev-check" title="${esc(productHelp.option)}"><input type="checkbox" id="tr-add-opt"/> Option buying</label>
            <label class="ev-check" title="${esc(productHelp.future)}"><input type="checkbox" id="tr-add-fut"/> Futures</label>
            <button type="button" class="btn-primary" id="tr-add">Add</button></div>
          <p class="small">Quick add: ${['NIFTY', 'BANKNIFTY'].filter(x => !st.watchlist.some(w => w.symbol === x)).map(x => `<button type="button" class="link-btn" data-quick="${x}">${x === 'NIFTY' ? 'NIFTY 50' : 'Bank NIFTY'} (options + futures)</button>`).join(' · ') || '<span class="muted">NIFTY and Bank NIFTY are in your list.</span>'}</p>
          ${st.watchlist.length ? `<div class="fno-tablewrap"><table class="screener-table fno-table"><thead><tr><th>Stock / index</th><th>Delivery</th><th>Intraday</th><th>Options</th><th>Futures</th><th></th></tr></thead><tbody>
            ${st.watchlist.map(w => `<tr data-w="${w.id}"><td><b>${esc(w.symbol)}</b> <span class="muted">${esc(w.name)}</span></td>
              ${['delivery', 'intraday', 'options', 'futures'].map(k => `<td><input type="checkbox" data-wk="${k}" ${Number(w[k]) ? 'checked' : ''}/></td>`).join('')}
              <td><button type="button" class="link-btn" data-wrm="${w.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
            : '<p class="muted">Add the stocks MarketMind should watch. Options only work for F&amp;O stocks and indices.</p>'}
        </div>
        <div class="analysis-section"><h3>How automatic</h3>
          <div>
            <label class="tr-radio"><input type="radio" name="tr-auto" value="onetap" ${S.automation !== 'semi' ? 'checked' : ''}/><span><b>One-tap</b>: you approve every order, including stop-losses and exits.</span></label>
            <label class="tr-radio"><input type="radio" name="tr-auto" value="semi" ${S.automation === 'semi' ? 'checked' : ''}/><span><b>Semi-automatic</b>: you approve every new trade; stop-loss, target, square-off and exit orders go by themselves so a losing trade is always closed.</span></label>
          </div>
          <p class="citation">New trades always need your tap. Ideas come only from Proven strategies, with a reward at least 1.5× the risk, and new buys only while NIFTY is above its 200-day average.</p>
        </div>
        <div class="analysis-section"><h3>Limits</h3>
          <form id="tr-settings" class="tr-settings">
            <label>Capital for trading (₹)<input name="account" type="number" min="1000" step="1000" value="${S.account}"/></label>
            <label>Risk per trade (% of capital)<input name="riskPct" type="number" min="0.1" max="5" step="0.1" value="${S.riskPct}"/></label>
            <label>Max money in one trade (₹)<input name="maxPerTrade" type="number" min="500" step="500" value="${S.maxPerTrade}"/></label>
            <label>Max new trades a day<input name="maxOrdersDay" type="number" min="1" max="20" value="${S.maxOrdersDay}"/></label>
            <label>Max positions open at once<input name="maxOpen" type="number" min="1" max="20" value="${S.maxOpen}"/></label>
            <label>Option stop (% of premium)<input name="optionStopPct" type="number" min="10" max="90" value="${S.optionStopPct}"/></label>
            <label>Option target (% of premium)<input name="optionTargetPct" type="number" min="10" max="500" value="${S.optionTargetPct}"/></label>
            <label>Option risk per trade (% of capital)<input name="optionRiskPct" type="number" min="0.5" max="10" step="0.5" value="${S.optionRiskPct ?? 5}"/></label>
            <label>Futures risk per trade (% of capital)<input name="futuresRiskPct" type="number" min="0.5" max="10" step="0.5" value="${S.futuresRiskPct ?? 2}"/></label>
            <label class="ev-check"><input type="checkbox" name="futuresLive" value="1" ${S.futuresLive ? 'checked' : ''} disabled/> Real futures orders <span class="muted">(off: paper only until you add margin)</span></label>
            <div><button type="submit" class="btn-primary">Save limits</button></div>
          </form>
          <p class="citation">The server checks every approval against these: money per trade, trades per day, open positions, market hours, and no new intraday trades after 2:45 pm.</p>
        </div>
        <div class="analysis-section"><h3>Words used here</h3><ul class="tr-gloss">
          <li><b>Stop</b>: the price where the trade is closed to limit the loss. <b>Target</b>: the price where profit is booked.</li>
          <li><b>R</b>: the amount you risk on a trade. +2R = you made twice what you risked; −1R = the stop was hit.</li>
          <li><b>Reward : risk</b>: how much the target can make for each ₹1 the stop can lose. MarketMind wants at least 1.5 : 1.</li>
          <li>${esc(productHelp.cnc)}</li><li>${esc(productHelp.mis)}</li><li>${esc(productHelp.option)}</li><li>${esc(productHelp.future)}</li>
          <li><b>Lot</b>: F&amp;O trades in fixed lots (NIFTY 65 units, Bank NIFTY 30). MarketMind sizes in whole lots and skips a trade when one lot is more than your risk limit.</li>
          <li><b>Proven / Watch</b>: how well the strategy behind an idea did in the 5-year back-test (Learn → Back-test).</li>
        </ul></div>
      </div>` : ''}`;
    wire(container);
    if (tab === 'open') refreshQuotes(container, positions);
  }

  let quoting = false;
  async function refreshQuotes(container, positions) {
    if (quoting) return;
    const syms = [...new Set(positions.filter(o => !['option', 'future'].includes(o.product)).map(o => o.symbol))].filter(s => !quotes[s] || Date.now() - quotes[s].at > 30e3);
    const fo = positions.filter(o => ['option', 'future'].includes(o.product) && (!quotes['o' + o.id] || Date.now() - quotes['o' + o.id].at > 30e3));
    if (!syms.length && !fo.length) return;
    quoting = true;
    await Promise.all(fo.map(o => priceOf(o).then(p => { if (p) quotes['o' + o.id] = { ltp: p, at: Date.now() }; }).catch(() => {})));
    // ICICI live quote first, Yahoo (about 15 min delayed) when ICICI is not logged in
    const yahoo = async s => { const p = MarketData.parseYahooChart(await (await fetch(`api/chart.php?symbol=${encodeURIComponent(MarketData.toYahooSymbol(s))}&interval=1d&range=5d`)).json()); const c = p.candles.filter(x => x && isFinite(x.close)); return c.length ? { ltp: (p.meta && p.meta.regularMarketPrice) || c[c.length - 1].close, delayed: true } : null; };
    await Promise.all(syms.map(s => MarketData.getQuote(s).then(q => q && q.ltp ? q : yahoo(s)).catch(() => yahoo(s).catch(() => null)).then(q => { if (q) quotes[s] = { ...q, at: Date.now() }; })));
    quoting = false;
    if (container && container.isConnected) render(container);
  }

  function wire(container) {
    const act = async (fn, okMsg) => {
      try { const r = await fn(); if (r) st = r; if (r && r.message) toast(r.message, 'success'); else if (okMsg) toast(okMsg, 'success'); }
      catch (e) { toast(e.message, 'warning'); }
      badge(); render(container);
    };
    container.querySelectorAll('[data-approve]').forEach(b => { b.onclick = () => { b.disabled = true; act(() => call('approve', { id: Number(b.dataset.approve) })); }; });
    container.querySelectorAll('[data-reject]').forEach(b => { b.onclick = () => act(() => call('reject', { id: Number(b.dataset.reject) })); });
    container.querySelectorAll('[data-exit]').forEach(b => {
      b.onclick = async () => {
        const o = st.orders.find(x => Number(x.id) === Number(b.dataset.exit));
        const p = await priceOf(o).catch(() => null);
        if (!p) { toast('Could not read the live price', 'warning'); return; }
        act(() => call('propose', { orders: [{ parentId: o.id, purpose: 'exit', product: o.product, symbol: o.symbol, name: o.name, qty: Number(o.qty), lot: Number(o.lot), limit: +(p * 0.998).toFixed(2), timeframe: o.timeframe,
          option: o.product === 'option' ? { isec: o.opt_isec, expiry: o.opt_expiry, strike: o.opt_strike, right: o.opt_right } : undefined,
          reason: `You asked to exit at about ${rs(p)}.` }] }), 'Exit order prepared. Approve it in "To approve".');
      };
    });
    container.querySelectorAll('[data-mode]').forEach(b => {
      b.onclick = () => {
        const v = b.dataset.mode;
        if (v === st.mode) return;
        if (v === 'man' && !confirm('Manual mode: approved orders are real trades that you place yourself in the ICICI Direct app. MarketMind tracks them and tells you when to exit. Switch to Manual?')) return;
        act(() => call('settings', { manual: v === 'man' }), v === 'man' ? 'Manual mode on' : 'Test mode on');
      };
    });
    container.querySelectorAll('input[name="tr-auto"]').forEach(r => { r.onchange = () => act(() => call('settings', { automation: r.value }), r.value === 'semi' ? 'Semi-automatic: protective orders will go by themselves' : 'One-tap: you approve every order'); });
    container.querySelectorAll('[data-quick]').forEach(b => { b.onclick = () => act(() => call('watch_add', { symbol: b.dataset.quick, name: b.dataset.quick === 'NIFTY' ? 'NIFTY 50 index' : 'Bank NIFTY index', delivery: false, intraday: false, options: true, futures: true })); });
    container.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => { tab = b.dataset.tab; try { localStorage.setItem('mm-tr-tab', tab); } catch { /* ok */ } render(container); }; });
    container.querySelectorAll('[data-fill]').forEach(b => {
      b.onclick = () => {
        const id = Number(b.dataset.fill);
        const price = parseFloat(container.querySelector(`[data-fill-for="${id}"]`).value);
        if (!(price > 0)) { toast('Enter the price it executed at', 'warning'); return; }
        act(() => call('manual_fill', { id, price }));
      };
    });
    container.querySelectorAll('[data-mcancel]').forEach(b => { b.onclick = () => act(() => call('manual_cancel', { id: Number(b.dataset.mcancel) })); });
    const en = container.querySelector('#tr-enabled');
    if (en) en.onchange = () => act(() => call('settings', { enabled: en.checked }));
    const kill = container.querySelector('#tr-kill');
    if (kill) kill.onclick = () => { if (confirm('Stop everything? Pending proposals are rejected and unfilled buy orders are cancelled. Open positions and their stop-losses stay.')) act(() => call('kill', {})); };
    const resume = container.querySelector('#tr-resume');
    if (resume) resume.onclick = () => act(() => call('resume', {}));
    const form = container.querySelector('#tr-settings');
    if (form) form.onsubmit = e => { e.preventDefault(); act(() => call('settings', Object.fromEntries(new FormData(form).entries())), 'Limits saved'); };
    const sym = container.querySelector('#tr-add-sym');
    if (sym && root.StockPicker && !sym.dataset.picker) { sym.dataset.picker = '1'; root.StockPicker.attach(sym, { popular: [] }); }
    const addBtn = container.querySelector('#tr-add');
    if (addBtn) addBtn.onclick = () => {
      const s = (sym.value || '').trim().toUpperCase().split(/\s|—/)[0];
      if (!s) return;
      act(() => call('watch_add', { symbol: s, name: '', delivery: container.querySelector('#tr-add-cnc').checked, intraday: container.querySelector('#tr-add-mis').checked, options: container.querySelector('#tr-add-opt').checked, futures: container.querySelector('#tr-add-fut').checked }));
    };
    container.querySelectorAll('tr[data-w]').forEach(tr => {
      tr.querySelectorAll('[data-wk]').forEach(cb => {
        cb.onchange = () => { const v = k => tr.querySelector(`[data-wk="${k}"]`).checked; act(() => call('watch_update', { id: Number(tr.dataset.w), delivery: v('delivery'), intraday: v('intraday'), options: v('options'), futures: v('futures') })); };
      });
    });
    container.querySelectorAll('[data-wrm]').forEach(b => { b.onclick = () => act(() => call('watch_remove', { id: Number(b.dataset.wrm) })); });
  }

  // ---------- start ----------
  async function renderPage(container) {
    if (!container) return;
    if (!root.Account || !root.Account.isAdmin) { container.innerHTML = '<div class="data-warning">Trading is available to the admin only.</div>'; return; }
    try { st = await call('state'); } catch (e) { container.innerHTML = `<div class="data-warning">Couldn't load trading: ${esc(e.message)}</div>`; return; }
    render(container);
    start(container);
  }

  function start(container) {
    if (timer) return;
    const tick = async () => { try { if (!st) st = await call('state'); await scan(container || document.getElementById('trading-container')); } catch { /* retried next minute */ } };
    tick();
    timer = setInterval(tick, SCAN_MS);
  }

  // Begin scanning as soon as the admin has signed in, whichever page is open
  function autoStart() {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (root.Account && root.Account.user && root.app && root.app.analysis) {
        clearInterval(iv);
        document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !root.Account.isAdmin));
        if (root.Account.isAdmin) start(document.getElementById('trading-container'));
      } else if (tries > 120) clearInterval(iv);
    }, 1000);
  }
  if (typeof document !== 'undefined') autoStart();

  root.Trading = { renderPage };
})(typeof window !== 'undefined' ? window : globalThis);

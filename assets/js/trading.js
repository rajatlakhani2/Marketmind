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
  async function priceOf(o) {
    if (o.product === 'option') { const r = await optionRow(o.opt_isec, o.opt_expiry, o.opt_right, o.opt_strike); return r && r.ltp; }
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
  async function stockIdea(w, product) {
    const tf = product === 'mis' ? '15m' : '1d';
    const res = await root.app.analysis.analyzeStock(w.symbol, '__all', tf, null, {});
    const md = res.marketData, c = res.consensus && res.consensus.conclusion;
    if (!md.live || !c || c.tone !== 'long') return null;
    if (product === 'mis' && c.verdict !== 'Buy') return null;              // intraday: only when price is in the zone now
    const entry = c.verdict === 'Buy' ? Math.min(md.price, c.buyHigh || md.price) : c.buyHigh;
    if (!(entry > 0) || c.stop == null || c.sell1 == null) return null;
    const qty = stockQty(st.settings, entry, c.stop);
    if (qty < 1) return null;
    const why = c.verdict === 'Buy'
      ? `${c.agree} of ${c.of} strategies give a buy and price ₹${md.price.toFixed(2)} is in the buy zone.`
      : `${c.agree} of ${c.of} strategies give a buy; this limit order waits for a dip to ₹${entry.toFixed(2)}.`;
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
    const right = c.tone === 'long' ? 'call' : 'put';
    const expiry = u.options.find(d => (Date.parse(d + 'T10:00:00Z') - Date.now()) / 864e5 >= 5);
    if (!expiry) return null;
    const chain = await breeze({ action: 'option_chain', isec: u.isec, expiry, right });
    const spot = (chain.rows.find(r => r.spot > 0) || {}).spot || res.marketData.price;
    const atm = chain.rows.reduce((b, r) => (b == null || Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b), null);
    if (!atm || !(atm.ltp > 0)) return null;
    const S = st.settings, lot = u.lot || 1;
    const prem = atm.ask > 0 ? atm.ask : atm.ltp;
    const stop = prem * (1 - S.optionStopPct / 100), target = prem * (1 + S.optionTargetPct / 100);
    const lots = Math.min(Math.floor(S.account * S.riskPct / 100 / ((prem - stop) * lot)), Math.floor(S.maxPerTrade / (prem * lot)));
    if (lots < 1) return null;
    return {
      purpose: 'entry', product: 'option', symbol: w.symbol, name: `${w.symbol} ${atm.strike} ${right === 'call' ? 'CE' : 'PE'} ${expiry}`,
      qty: lots * lot, lot, limit: +prem.toFixed(2), stop: +stop.toFixed(2), target: +target.toFixed(2), timeframe: '1d', verdict: c.verdict,
      option: { isec: u.isec, expiry, strike: atm.strike, right },
      reason: `Options: ${w.symbol}'s daily verdict is "${c.verdict}", so buy the at-the-money ${right} (${atm.strike} ${right === 'call' ? 'CE' : 'PE'}, expiry ${expiry}) at about ${rs(prem)}. ` +
        `${lots} lot${lots > 1 ? 's' : ''} × ${lot} = ${rs(prem * lots * lot, 0)} premium, the most you can lose. Stop if the premium falls to ${rs(stop)} (−${S.optionStopPct}%), target ${rs(target)} (+${S.optionTargetPct}%).`,
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
        option: o.product === 'option' ? { isec: o.opt_isec, expiry: o.opt_expiry, strike: o.opt_strike, right: o.opt_right } : undefined };
      const expiryDay = o.product === 'option' && o.opt_expiry === istToday();
      if ((o.product === 'mis' && now >= 15 * 60 + 10) || (expiryDay && now >= 14 * 60 + 30)) {
        proposals.push({ ...base, purpose: 'squareoff', limit: +(p * 0.998).toFixed(2), reason: `${o.product === 'mis' ? 'Intraday positions must be closed before 3:20 pm' : 'The option expires today'}: sell at about ${rs(p)}.` });
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
          for (const t of tries) {
            try { const idea = await t(); if (idea) proposals.push(idea); } catch (e) { console.warn('Scanner:', w.symbol, e.message); }
          }
        }
      }
      if (proposals.length) {
        const before = st.orders.filter(o => o.status === 'pending').length;
        st = await call('propose', { orders: proposals });
        const added = st.orders.filter(o => o.status === 'pending').length - before;
        if (added > 0) toast(`MarketMind has ${added} new order${added > 1 ? 's' : ''} waiting for your approval (Trading page).`, 'success');
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
  const PRODUCT = { cnc: 'Delivery', mis: 'Intraday', option: 'Option' };
  const PURPOSE = { entry: 'Buy', stoploss: 'Stop-loss', target: 'Sell at target', squareoff: 'Square off', exit: 'Exit' };
  const STATUS = { pending: 'Waiting for you', open: 'Sent, not filled', filled: 'Filled', closed: 'Closed', rejected: 'Rejected', expired: 'Expired', cancelled: 'Cancelled', failed: 'Failed' };

  function orderCard(o) {
    const value = Number(o.limit_price) * Number(o.qty);
    const left = Math.max(0, Math.round((Date.parse(o.expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 60e3));
    return `<div class="tr-card ${o.side}">
      <div class="tr-card-head">
        <span class="chip ${o.side === 'buy' ? 'chip-long' : 'chip-short'}">${esc(PURPOSE[o.purpose] || o.purpose)}</span>
        <strong>${esc(o.product === 'option' ? o.name : o.symbol)}</strong>
        <span class="tag">${esc(PRODUCT[o.product])}</span>
        <span class="muted">expires in ${left} min</span>
      </div>
      <div class="tr-card-grid">
        <div><span class="label">${o.order_type === 'stoploss' ? 'Trigger / limit' : 'Limit price'}</span><b>${o.order_type === 'stoploss' ? `${rs(Number(o.trigger_price))} / ${rs(Number(o.limit_price))}` : rs(Number(o.limit_price))}</b></div>
        <div><span class="label">Quantity</span><b>${n0(Number(o.qty))}${o.product === 'option' ? ` (${Number(o.qty) / Number(o.lot)} lot)` : ''}</b></div>
        <div><span class="label">Value</span><b>${rs(value, 0)}</b></div>
        ${o.stop != null ? `<div><span class="label">Stop / target</span><b>${rs(Number(o.stop))} / ${rs(Number(o.target))}</b></div>` : ''}
      </div>
      <p class="tr-reason">${esc(o.reason || '')}</p>
      <div class="tr-actions">
        <button type="button" class="btn-primary" data-approve="${o.id}">${st.mode === 'live' ? 'Approve & send to ICICI' : st.mode === 'man' ? 'Approve' : 'Approve (test)'}</button>
        <button type="button" class="btn-secondary" data-reject="${o.id}">Reject</button>
      </div>
    </div>`;
  }

  // What to enter in the ICICI Direct app's order screen
  function ticket(o) {
    const opt = o.product === 'option';
    const right = o.opt_right === 'put' ? 'Put (PE)' : 'Call (CE)';
    const expiry = o.opt_expiry ? new Date(o.opt_expiry + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const rows = [
      ['Stock', opt ? `${esc(o.symbol)}${o.icici_code && o.icici_code !== o.symbol ? ` (ICICI code ${esc(o.icici_code)})` : ''}` : `${esc(o.symbol)}${o.icici_code && o.icici_code !== o.symbol ? ` (ICICI code ${esc(o.icici_code)})` : ''}`],
      ['Segment', opt ? 'Derivatives (F&amp;O) · NSE' : 'Equity · NSE'],
      ...(opt ? [['Contract', `Options · ${right} · strike ${esc(Number(o.opt_strike))} · expiry ${esc(expiry)}`]] : []),
      ['Product', opt ? 'Options (NRML)' : o.product === 'mis' ? 'Margin / Intraday' : 'Cash / Delivery (CNC)'],
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

  function render(container) {
    if (!st) return;
    const S = st.settings;
    const pending = st.orders.filter(o => o.status === 'pending');
    const positions = st.orders.filter(o => o.purpose === 'entry' && o.status === 'filled');
    const history = st.orders.filter(o => o.status !== 'pending').slice(0, 60);
    const realised = st.orders.filter(o => o.status === 'closed').reduce((a, o) => a + Number(o.pnl || 0), 0);
    const toPlace = st.orders.filter(o => o.status === 'open' && o.mode === 'man');
    const modeBanner = st.mode === 'live'
      ? '<div class="tr-mode live"><b>LIVE</b> · approved orders go to your ICICI account through the order relay.</div>'
      : `<div class="tr-mode ${st.mode === 'man' ? 'live' : 'test'}">
          <div class="tr-modes">
            <label><input type="radio" name="tr-mode" value="test" ${st.mode === 'test' ? 'checked' : ''}/> <b>Test</b>: approved orders are simulated against live prices</label>
            <label><input type="radio" name="tr-mode" value="man" ${st.mode === 'man' ? 'checked' : ''}/> <b>Manual</b>: you place approved orders in the ICICI Direct app yourself (real money)</label>
          </div></div>`;
    const status = [
      st.icici ? '<span class="text-green">ICICI logged in</span>' : '<span class="text-red">ICICI not logged in today</span>',
      marketOpen() ? '<span class="text-green">market open</span>' : 'market closed',
      lastScan ? `last scan ${new Date(lastScan).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'scanner starting',
    ].join(' · ');

    container.innerHTML = `
      ${modeBanner}
      <div class="tr-top">
        <label class="tr-switch"><input type="checkbox" id="tr-enabled" ${S.enabled ? 'checked' : ''} ${S.killed ? 'disabled' : ''}/> <span>Propose new trades</span></label>
        ${S.killed ? '<button type="button" class="btn-secondary" id="tr-resume">Kill switch is ON · turn trading back on</button>' : '<button type="button" class="btn-danger" id="tr-kill">Kill switch: stop everything</button>'}
        <span class="muted tr-status">${status}</span>
      </div>
      ${scanNote ? `<div class="data-warning">${esc(scanNote)}</div>` : ''}
      <p class="muted" style="margin:-4px 0 12px;">MarketMind scans while this app is open (any page). The stop-loss order it proposes after each buy rests at ICICI, so it protects you even when the app is closed.</p>

      ${toPlace.length ? `<div class="analysis-section tr-place"><h3>Place these in the ICICI Direct app (${toPlace.length})</h3>${toPlace.map(ticket).join('')}</div>` : ''}

      <div class="analysis-section"><h3>Waiting for your approval (${pending.length})</h3>
        ${pending.length ? pending.map(orderCard).join('') : '<p class="muted">Nothing right now. New proposals appear here and as a pop-up.</p>'}
      </div>

      <div class="analysis-section"><h3>Open positions (${positions.length}) · booked P&amp;L ${rs(realised, 0)}</h3>
        ${positions.length ? `<div class="fno-tablewrap"><table class="screener-table fno-table">
          <thead><tr><th>Position</th><th>Qty</th><th>Bought at</th><th>Stop</th><th>Target</th><th>Mode</th><th></th></tr></thead>
          <tbody>${positions.map(o => `<tr><td>${esc(o.product === 'option' ? o.name : o.symbol)} <span class="muted">${esc(PRODUCT[o.product])}</span></td><td>${n0(Number(o.qty))}</td><td>${rs(Number(o.fill_price))}</td><td>${rs(Number(o.stop))}</td><td>${rs(Number(o.target))}</td><td>${o.mode === 'live' ? 'Live' : o.mode === 'man' ? 'Manual' : 'Test'}</td>
            <td><button type="button" class="btn-secondary btn-small" data-exit="${o.id}">Exit now…</button></td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">No open positions.</p>'}
      </div>

      <div class="analysis-section"><h3>Watchlist</h3>
        <div class="fno-controls"><label>Add a stock<input type="text" id="tr-add-sym" placeholder="e.g. RELIANCE" autocomplete="off" /></label>
          <label class="ev-check"><input type="checkbox" id="tr-add-cnc" checked/> Delivery</label>
          <label class="ev-check"><input type="checkbox" id="tr-add-mis"/> Intraday</label>
          <label class="ev-check"><input type="checkbox" id="tr-add-opt"/> Options</label>
          <button type="button" class="btn-primary" id="tr-add">Add</button></div>
        ${st.watchlist.length ? `<div class="fno-tablewrap"><table class="screener-table fno-table"><thead><tr><th>Stock</th><th>Delivery</th><th>Intraday</th><th>Options</th><th></th></tr></thead><tbody>
          ${st.watchlist.map(w => `<tr data-w="${w.id}"><td><b>${esc(w.symbol)}</b> <span class="muted">${esc(w.name)}</span></td>
            ${['delivery', 'intraday', 'options'].map(k => `<td><input type="checkbox" data-wk="${k}" ${Number(w[k]) ? 'checked' : ''}/></td>`).join('')}
            <td><button type="button" class="link-btn" data-wrm="${w.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">Add the stocks MarketMind should watch. Options only work for F&amp;O stocks and indices.</p>'}
      </div>

      <div class="analysis-section"><h3>Limits</h3>
        <form id="tr-settings" class="tr-settings">
          <label>Capital for trading (₹)<input name="account" type="number" min="1000" step="1000" value="${S.account}"/></label>
          <label>Risk per trade (% of capital)<input name="riskPct" type="number" min="0.1" max="5" step="0.1" value="${S.riskPct}"/></label>
          <label>Max value per trade (₹)<input name="maxPerTrade" type="number" min="500" step="500" value="${S.maxPerTrade}"/></label>
          <label>Max new trades per day<input name="maxOrdersDay" type="number" min="1" max="20" value="${S.maxOrdersDay}"/></label>
          <label>Max open positions<input name="maxOpen" type="number" min="1" max="20" value="${S.maxOpen}"/></label>
          <label>Options stop (% premium loss)<input name="optionStopPct" type="number" min="10" max="90" value="${S.optionStopPct}"/></label>
          <label>Options target (% premium gain)<input name="optionTargetPct" type="number" min="10" max="500" value="${S.optionTargetPct}"/></label>
          <div><button type="submit" class="btn-primary">Save limits</button></div>
        </form>
        <p class="citation">Every approval is checked against these on the server: value per trade, trades per day, open positions, market hours, and no new intraday trades after 2:45 pm.</p>
      </div>

      <div class="analysis-section"><h3>Order history (last 7 days)</h3>
        ${history.length ? `<div class="fno-tablewrap"><table class="screener-table fno-table"><thead><tr><th>Time</th><th>Order</th><th>Qty</th><th>Price</th><th>Status</th><th>P&amp;L</th></tr></thead><tbody>
          ${history.map(o => `<tr><td>${new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td>${esc(PURPOSE[o.purpose])} ${esc(o.product === 'option' ? o.name : o.symbol)} <span class="muted">${esc(PRODUCT[o.product])} · ${o.mode === 'live' ? 'live' : o.mode === 'man' ? 'manual' : 'test'}</span></td>
            <td>${n0(Number(o.qty))}</td><td>${rs(Number(o.fill_price || o.limit_price))}</td>
            <td>${esc(STATUS[o.status] || o.status)}${o.error ? `<br><span class="text-red">${esc(o.error)}</span>` : ''}</td>
            <td class="${Number(o.pnl) > 0 ? 'text-green' : Number(o.pnl) < 0 ? 'text-red' : ''}">${o.pnl != null ? rs(Number(o.pnl), 0) : ''}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">No orders yet.</p>'}
      </div>`;
    wire(container);
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
          reason: `You asked to exit at about ${rs(p)}.` }] }), 'Exit order prepared. Approve it above.');
      };
    });
    container.querySelectorAll('input[name="tr-mode"]').forEach(r => {
      r.onchange = () => {
        if (r.value === 'man' && !confirm('Manual mode: approved orders are real trades that you place yourself in the ICICI Direct app. MarketMind tracks them and tells you when to exit. Switch to Manual?')) { render(container); return; }
        act(() => call('settings', { manual: r.value === 'man' }), r.value === 'man' ? 'Manual mode on' : 'Test mode on');
      };
    });
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
    form.onsubmit = e => { e.preventDefault(); act(() => call('settings', Object.fromEntries(new FormData(form).entries())), 'Limits saved'); };
    const sym = container.querySelector('#tr-add-sym');
    if (root.StockPicker && !sym.dataset.picker) { sym.dataset.picker = '1'; root.StockPicker.attach(sym, { popular: [] }); }
    container.querySelector('#tr-add').onclick = () => {
      const s = (sym.value || '').trim().toUpperCase().split(/\s|—/)[0];
      if (!s) return;
      act(() => call('watch_add', { symbol: s, name: '', delivery: container.querySelector('#tr-add-cnc').checked, intraday: container.querySelector('#tr-add-mis').checked, options: container.querySelector('#tr-add-opt').checked }));
    };
    container.querySelectorAll('tr[data-w]').forEach(tr => {
      tr.querySelectorAll('[data-wk]').forEach(cb => {
        cb.onchange = () => { const v = k => tr.querySelector(`[data-wk="${k}"]`).checked; act(() => call('watch_update', { id: Number(tr.dataset.w), delivery: v('delivery'), intraday: v('intraday'), options: v('options') })); };
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

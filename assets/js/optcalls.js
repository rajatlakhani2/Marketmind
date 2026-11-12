// MarketMind AI — Option calls on live data (Markets → Option calls).
// Scans NIFTY, Bank NIFTY and F&O stocks (your Watchlist + today's strong buys) with ICICI's live option chain
// and gives BUY CALL / BUY PUT / WAIT with the exact contract, live premium, stop, target and the reason.
//
// Rules (same as the Trade tab):
//   BUY CALL  · Proven strategy buy signal on the daily chart, and NIFTY above its 200-day average  → "Proven"
//             · a Watch strategy only → "Watch" (half weight; smaller size or skip)
//             · price in a demand zone with the monthly trend not down → "Zone only · not proven"
//   BUY PUT   · a counted sell signal (these only count while NIFTY is below its 200-day average)
//             · price in a supply zone with the monthly trend down → "Zone only · not proven"
//   WAIT      · otherwise, with the levels where a call or put would start
// Contract: at-the-money strike; Swing = first expiry with 15+ days left, Short-term = first with 2+ days.
// Premium stop / target = the option's Black-Scholes price (its own implied volatility) when the stock or index
// reaches its stop / target. Option selling is never suggested.
(function (root) {
  'use strict';

  const API = 'api/breeze.php', RATE = 0.065;
  const INDEX_CHART = { NIFTY: '^NSEI', CNXBAN: '^NSEBANK', BANKNIFTY: '^NSEBANK' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const rs = (v, d = 2) => (v == null || !isFinite(v) ? '—' : '₹' + num(v, d));
  const r05 = v => (v == null || !isFinite(v) ? null : Math.max(0.05, Math.round(v * 20) / 20));
  const daysTo = d => (Date.parse(d + 'T10:00:00Z') - Date.now()) / 864e5;
  const yearsTo = d => Math.max(0, daysTo(d) / 365);
  const marketOpen = () => { const d = new Date(Date.now() + 5.5 * 3600e3), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && m >= 555 && m <= 930; };

  function ncdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2); const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; }
  function bs(S, K, T, v, call) {
    if (T <= 0 || v <= 0) return Math.max(0, call ? S - K : K - S);
    const d1 = (Math.log(S / K) + (RATE + v * v / 2) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
    return call ? S * ncdf(d1) - K * Math.exp(-RATE * T) * ncdf(d2) : K * Math.exp(-RATE * T) * ncdf(-d2) - S * ncdf(-d1);
  }
  function iv(price, S, K, T, call) {
    if (!(price > 0 && S > 0 && T > 0)) return null;
    let lo = 0.01, hi = 3;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (bs(S, K, T, m, call) > price) hi = m; else lo = m; }
    const v = (lo + hi) / 2; return v > 2.9 ? null : v;
  }

  async function get(params) {
    const r = await fetch(`${API}?` + new URLSearchParams(params), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw Object.assign(new Error((j && j.error) || `HTTP ${r.status}`), { needsLogin: !!(j && j.needsLogin) });
    return j;
  }

  const S = { style: 'swing', rows: {}, list: [], meta: null, busy: false, at: null, err: null, timer: null, settings: null, open: null };
  try { S.style = localStorage.getItem('mm-oc-style') || 'swing'; } catch { /* default */ }

  async function universe() {
    if (!S.meta) S.meta = (await get({ action: 'fo_meta' })).underlyings;
    const fo = new Map(S.meta.map(u => [u.symbol, u]));
    const pick = new Set(['NIFTY', 'BANKNIFTY']);
    try { for (const i of (await (await fetch('api/watchlist.php?action=list')).json()).items || []) if (fo.has(i.symbol)) pick.add(i.symbol); } catch { /* none */ }
    try {
      const scan = (await (await fetch('api/scan.php?action=latest')).json()).rows || [];
      scan.filter(r => r.verdict === 'Buy' && root.Tiers && Tiers.isStrong(r) && fo.has(r.symbol)).slice(0, 8).forEach(r => pick.add(r.symbol));
    } catch { /* none */ }
    return [...pick].map(s => fo.get(s) || S.meta.find(u => u.isec === (s === 'BANKNIFTY' ? 'CNXBAN' : s))).filter(Boolean);
  }

  async function analyse(u) {
    const expiries = (u.options || []).filter(d => daysTo(d) >= (S.style === 'swing' ? 15 : 2));
    const expiry = expiries[0];
    if (!expiry) throw new Error('no expiry far enough away');
    const sym = u.kind === 'index' ? (INDEX_CHART[u.isec] || INDEX_CHART[u.symbol]) : u.symbol;
    const res = await root.app.analysis.analyzeStock(sym, '__all', '1d', null, {});
    const c = res.consensus && res.consensus.conclusion, ks = res.ks001;
    const [calls, puts] = await Promise.all([get({ action: 'option_chain', isec: u.isec, expiry, right: 'call' }), get({ action: 'option_chain', isec: u.isec, expiry, right: 'put' })]);
    const spot = [...calls.rows, ...puts.rows].map(r => r.spot).find(v => v > 0) || res.marketData.price;
    const lot = u.lot || calls.lot || 1;
    const strikes = [...new Set(calls.rows.map(r => r.strike))].sort((a, b) => a - b);
    const atm = strikes.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), strikes[0]);
    const T = yearsTo(expiry);

    // Direction
    const up200 = (() => { const m = root.Tiers && Tiers.market(); return !m || m.above200 !== false; })();
    const D = ks && ks.nearestDemand && ks.nearestDemand[0], Z = ks && ks.nearestSupply && ks.nearestSupply[0];
    const htf = ks && ks.trends && ks.trends.htf ? ks.trends.htf.trend : null;
    const inD = D && spot <= D.proximal * 1.003 && spot >= D.distal, inS = Z && spot >= Z.proximal * 0.997 && spot <= Z.distal;
    let side = null, tag = null, why = [], stopU = null, targetU = null;
    if (c && c.tone === 'long' && c.verdict === 'Buy' && (c.score || 0) >= 0.4) {
      side = 'call'; tag = c.backing === 'proven' && up200 ? 'proven' : 'watch';
      why.push(`Buy signal backed by ${c.supporting.join(', ')}.`);
      if (!up200) why.push('NIFTY is below its 200-day average, so new buys are riskier.');
      stopU = c.stop; targetU = c.sell1;
    } else if (c && c.tone === 'short' && (c.scoreShort || 0) >= 0.4) {
      side = 'put'; tag = 'watch'; why.push(`Sell signal: ${c.against && c.against.length ? c.against.join(', ') : 'tested strategies'} (NIFTY is below its 200-day average).`);
      stopU = c.stop; targetU = c.coverAt;
    } else if (inD && htf !== 'Bearish' && Z) {
      side = 'call'; tag = 'zone'; why.push(`${u.symbol} is in a demand zone (${num(D.distal, 0)}–${num(D.proximal, 0)}) and the monthly trend is ${String(htf || '').toLowerCase()}.`);
      stopU = D.stop; targetU = Z.proximal;
    } else if (inS && htf === 'Bearish' && D) {
      side = 'put'; tag = 'zone'; why.push(`${u.symbol} is in a supply zone (${num(Z.proximal, 0)}–${num(Z.distal, 0)}) and the monthly trend is down.`);
      stopU = Z.stop; targetU = D.proximal;
    }
    const row = { u, expiry, days: Math.ceil(daysTo(expiry)), spot, lot, atm, verdict: c ? c.verdict : '—', side, tag, why, D, Z, live: !!res.marketData.live, at: Date.now() };
    if (!side) {
      const away = v => { const p = (v / spot - 1) * 100; return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`; };
      row.wait = [D ? `Calls become interesting near ${rs(D.proximal, 0)} (demand zone, ${away(D.proximal)})` : null,
        Z ? (Z.proximal >= spot ? `puts near ${rs(Z.proximal, 0)} (supply zone, ${away(Z.proximal)})` : `price is above the supply zone at ${rs(Z.proximal, 0)}`) : null].filter(Boolean).join('; ') || 'No nearby zones.';
      return row;
    }
    // Contract and premiums
    const isCall = side === 'call';
    // At-the-money, or the nearest strike that is actually trading
    const traded = (isCall ? calls.rows : puts.rows).filter(r => r.ltp > 0).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    const chainRow = traded[0];
    if (!chainRow || Math.abs(chainRow.strike - spot) / spot > 0.05) { row.side = null; row.wait = `No traded ${isCall ? 'call' : 'put'} near ${num(atm, 0)} right now.`; return row; }
    row.atm = chainRow.strike;
    const entry = chainRow.ask > 0 ? chainRow.ask : chainRow.ltp;
    const K = chainRow.strike;
    const vol = iv(chainRow.ltp, spot, K, T, isCall) || 0.2;
    let stop = stopU ? bs(stopU, K, Math.max(T - 3 / 365, 1 / 365), vol, isCall) : entry * 0.6;
    let target = targetU ? bs(targetU, K, Math.max(T - 10 / 365, 1 / 365), vol, isCall) : entry * 1.8;
    // Premium stop between 50% and 80% of what you pay: tighter gets hit by normal noise, wider risks too much
    if (!(stop < entry)) stop = entry * 0.6;
    stop = Math.min(Math.max(stop, entry * 0.5), entry * 0.8);
    // Target at least +30% and at most 3× the premium (the far zone may take longer than the option lasts)
    if (!(target > entry * 1.3)) target = entry * 1.8;
    target = Math.min(target, entry * 3);
    Object.assign(row, {
      name: `${u.symbol} ${num(K, 0)} ${isCall ? 'CE' : 'PE'} ${expiry}`, strike: K, right: isCall ? 'call' : 'put',
      entry: r05(entry), stop: r05(stop), target: r05(target), ltp: chainRow.ltp, oi: chainRow.oi, ivPct: vol * 100,
      stopU, targetU, costLot: entry * lot, riskLot: (entry - stop) * lot, rewardLot: (target - entry) * lot,
    });
    return row;
  }

  async function refresh(container) {
    if (S.busy) return;
    S.busy = true; S.err = null; draw(container);
    try {
      if (root.Tiers) await Tiers.ready().catch(() => {});
      if (!S.settings) { try { S.settings = (await (await fetch('api/trade.php?action=state')).json()).settings || null; } catch { S.settings = null; } }
      S.list = await universe();
      draw(container);
      let i = 0;
      const worker = async () => { while (i < S.list.length) { const u = S.list[i++]; try { S.rows[u.isec] = await analyse(u); } catch (e) { S.rows[u.isec] = { u, error: e.message, needsLogin: e.needsLogin }; } draw(container); } };
      await Promise.all([worker(), worker()]);
      S.at = Date.now();
    } catch (e) { S.err = e.needsLogin ? 'login' : e.message; }
    S.busy = false; draw(container);
  }

  const TAG = { proven: '<span class="tier tier-proven">Proven</span>', watch: '<span class="tier tier-watch">Watch</span>', zone: '<span class="tier tier-unproven">Zone only · not proven</span>' };

  function card(r) {
    const name = r.u.kind === 'index' ? (r.u.isec === 'NIFTY' ? 'NIFTY 50' : r.u.name || r.u.symbol) : r.u.symbol;
    if (r.error) return `<div class="oc-card"><div class="oc-head"><b>${esc(name)}</b><span class="muted small">${r.needsLogin ? 'needs ICICI login' : esc(r.error)}</span></div></div>`;
    const capPct = (S.settings && S.settings.optionRiskPct) || 5, cap = ((S.settings && S.settings.account) || 100000) * capPct / 100;
    if (!r.side) return `<div class="oc-card wait"><div class="oc-head"><b>${esc(name)}</b><span class="wl-call wait">WAIT</span><span class="muted small">${r.u.kind === 'index' ? 'index' : 'stock'} ${rs(r.spot, 0)} · verdict ${esc(r.verdict)}</span></div><p class="small muted">${esc(r.wait)}</p></div>`;
    const isCall = r.side === 'call', fits = r.riskLot <= cap;
    return `<div class="oc-card ${isCall ? 'call' : 'put'}">
      <div class="oc-head"><b>${esc(name)}</b><span class="wl-call ${isCall ? 'buy' : 'sell'}">BUY ${isCall ? 'CALL' : 'PUT'}</span>${TAG[r.tag] || ''}<span class="muted small">${r.u.kind === 'index' ? 'index' : 'stock'} ${rs(r.spot, 0)}</span></div>
      <h4 class="tr-headline">Buy ${esc(num(r.strike, 0))} ${isCall ? 'CE' : 'PE'} · expiry ${esc(r.expiry)} <span class="muted small">(${r.days} days)</span></h4>
      <div class="tr-facts">
        <div><span>Buy premium at</span><b>${rs(r.entry)}</b></div>
        <div><span>Stop (premium)</span><b class="down">${rs(r.stop)}</b></div>
        <div><span>Target (premium)</span><b class="up">${rs(r.target)}</b></div>
        <div><span>1 lot (${r.lot})</span><b>${rs(r.costLot, 0)}</b></div>
        <div><span>Could lose / make</span><b><span class="down">${rs(r.riskLot, 0)}</span> / <span class="up">${rs(r.rewardLot, 0)}</span></b></div>
      </div>
      <div class="tr-why"><b>Why:</b> ${esc(r.why.join(' '))} Stop if ${esc(r.u.symbol)} ${isCall ? 'falls to' : 'rises to'} ${rs(r.stopU, 0)}; target when it reaches ${rs(r.targetU, 0)}.</div>
      <p class="small muted">IV ${r.ivPct ? r.ivPct.toFixed(1) + '%' : '—'} · open interest ${num(r.oi, 0)} · ${fits ? `fits your option limit (${capPct}% = ${rs(cap, 0)})` : `<span class="down">one lot risks more than your option limit (${capPct}% = ${rs(cap, 0)})</span>`}${r.days < 7 ? ' · close to expiry: time decay is fast' : ''}</p>
      ${root.Account && Account.isAdmin ? `<div class="tr-actions"><button type="button" class="btn-primary btn-small" data-send="${esc(r.u.isec)}">Send to Trade for approval</button></div>` : ''}
    </div>`;
  }

  function draw(container) {
    if (!container) return;
    const rows = S.list.map(u => S.rows[u.isec] || { u, loading: true });
    const order = r => r.loading ? 3 : r.error ? 4 : !r.side ? 2 : r.tag === 'proven' ? 0 : r.tag === 'watch' ? 0.5 : 1;
    rows.sort((a, b) => order(a) - order(b));
    const n = rows.filter(r => r.side).length;
    container.innerHTML = `
      <div class="live-top">
        <div class="seg"><button type="button" data-style="swing" class="${S.style === 'swing' ? 'active' : ''}">Swing (15+ days)</button><button type="button" data-style="short" class="${S.style === 'short' ? 'active' : ''}">Short-term (2+ days)</button></div>
        <div class="live-status"><span class="mkt-pill ${marketOpen() ? 'open' : ''}"><i></i>${marketOpen() ? 'Live · every 2 min' : 'Market closed'}</span>
        <button type="button" class="btn-secondary" id="oc-refresh" ${S.busy ? 'disabled' : ''}>${S.busy ? `Checking ${Object.keys(S.rows).length}/${S.list.length || '…'}…` : 'Refresh'}</button></div>
      </div>
      ${S.err === 'login' ? '<div class="data-warning">Option prices come only from ICICI. <a href="api/breeze.php?action=login">Log in to ICICI</a> for today, then come back.</div>' : S.err ? `<p class="auth-error">${esc(S.err)}</p>` : ''}
      ${S.list.length ? `<p class="muted small">${n} call${n === 1 ? '' : 's'} out of ${S.list.length} checked: NIFTY, Bank NIFTY, F&amp;O stocks on your Watchlist and today's strong buys.${S.at ? ` Updated ${new Date(S.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.` : ''}</p>` : ''}
      <div class="oc-grid">${rows.map(r => r.loading ? `<div class="oc-card"><div class="oc-head"><b>${esc(r.u.symbol)}</b><span class="muted small">checking…</span></div></div>` : card(r)).join('')}</div>
      <div class="card live-help"><h4>How these calls are made</h4><ul>
        <li><b>Proven</b>: a strategy that held up in the 5-year back-test gives a buy signal, and NIFTY is above its 200-day average. <b>Watch</b>: only a half-weight strategy agrees. <b>Zone only</b>: price is at a demand or supply zone, which is not proven on its own.</li>
        <li>Puts are only called when sell signals count (NIFTY below its 200-day average) or price is at a supply zone in a downtrend.</li>
        <li>Stop and target are the premiums the option should be worth when the ${'stock or index'} reaches its own stop or target, worked out from the option's live implied volatility. The premium stop never risks more than half of what you pay.</li>
        <li>Option buying only; MarketMind never suggests selling options. Not investment advice: you decide and approve every trade.</li>
      </ul></div>`;
    container.querySelectorAll('[data-style]').forEach(b => { b.onclick = () => { S.style = b.dataset.style; try { localStorage.setItem('mm-oc-style', S.style); } catch { /* ok */ } S.rows = {}; refresh(container); }; });
    const rf = container.querySelector('#oc-refresh'); if (rf) rf.onclick = () => { S.rows = {}; refresh(container); };
    container.querySelectorAll('[data-send]').forEach(b => { b.onclick = () => send(b, S.rows[b.dataset.send]); });
  }

  async function send(btn, r) {
    if (!r || !r.side) return;
    btn.disabled = true;
    try {
      const qty = r.lot;
      const res = await fetch('api/trade.php?action=propose', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MarketMind', Accept: 'application/json' },
        body: JSON.stringify({ orders: [{ purpose: 'entry', product: 'option', symbol: r.u.symbol, name: r.name, qty, lot: r.lot, limit: r.entry, stop: r.stop, target: r.target, timeframe: '1d', verdict: r.verdict,
          option: { isec: r.u.isec, expiry: r.expiry, strike: r.strike, right: r.right },
          reason: `Option call (${r.tag === 'proven' ? 'Proven' : r.tag === 'watch' ? 'Watch' : 'zone only, not proven'}): ${r.why.join(' ')} Stop if ${r.u.symbol} reaches ${num(r.stopU, 0)}, target ${num(r.targetU, 0)}.` }] }) });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j) throw new Error((j && j.error) || `HTTP ${res.status}`);
      btn.textContent = j.added ? 'Sent · approve it in Trade → To approve' : 'Not added (trading is switched off, a limit is reached, or it is already waiting)';
    } catch (e) { btn.textContent = 'Not sent: ' + e.message; }
  }

  async function renderPage(container) {
    clearInterval(S.timer);
    draw(container);
    await refresh(container);
    S.timer = setInterval(() => {
      const page = document.getElementById('page-optcalls');
      if (!page || !page.classList.contains('active')) { clearInterval(S.timer); return; }
      if (!document.hidden && marketOpen()) { S.rows = {}; refresh(container); }
    }, 120e3);
  }

  root.OptCalls = { renderPage, _analyse: analyse };
})(window);

// ============================================================
// MarketMind AI — Futures & Options page
// Live ICICI Breeze data for every NSE F&O underlying (indices + stocks):
//   - Summary: spot, futures premium, PCR, max pain, OI support/resistance, ATM IV,
//     the underlying's All-Strategy verdict and an options idea that follows it
//   - Calls / Puts tabs: option chain around the money (LTP, change, OI, OI change,
//     volume, IV, bid/ask), ITM shading, OI bars
//   - Futures tab: every futures expiry with premium over spot and contract value
// IV is worked out here with Black-Scholes (ICICI's chain has no IV column).
// Not trading advice: every idea is labelled as such.
// ============================================================
(function (root) {
  'use strict';

  const API = 'api/breeze.php';
  const RATE = 0.065;             // risk-free rate for IV (approx. Indian T-bill yield)
  const REFRESH_MS = 30e3;        // live refresh during market hours
  const AROUND = 12;              // strikes shown each side of ATM unless "show all"
  // Index cash charts for the verdict (Yahoo symbols); other indices get no verdict
  const INDEX_CHART = { NIFTY: '^NSEI', CNXBAN: '^NSEBANK' };

  let meta = null;
  const state = { isec: 'NIFTY', expiry: null, tab: 'summary', showAll: false };
  let timer = null, busy = false, data = null;
  const verdictCache = new Map();  // isec -> { at, result }

  // ---------- small helpers ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const rs = (v, d = 2) => (v == null || !isFinite(v) ? '—' : '₹' + num(v, d));
  const int = v => (v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString('en-IN'));
  const big = v => {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v), s = v < 0 ? '−' : '';
    if (a >= 1e7) return s + (a / 1e7).toFixed(2) + ' Cr';
    if (a >= 1e5) return s + (a / 1e5).toFixed(2) + ' L';
    return s + Math.round(a).toLocaleString('en-IN');
  };
  const pct = v => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
  const cls = v => (v > 0 ? 'text-green' : v < 0 ? 'text-red' : '');
  const chg = (ltp, prev) => (ltp != null && prev ? (ltp - prev) / prev * 100 : null);
  const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  function marketOpen() {
    const ist = new Date(Date.now() + 5.5 * 3600e3);
    const day = ist.getUTCDay(), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
  }

  async function get(action, params = {}) {
    const r = await fetch(`${API}?` + new URLSearchParams({ action, ...params }), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || !j) throw Object.assign(new Error((j && j.error) || `HTTP ${r.status}`), { needsLogin: !!(j && j.needsLogin), status: r.status });
    return j;
  }

  // ---------- option maths ----------
  function ncdf(x) { // standard normal CDF (Abramowitz–Stegun 26.2.17)
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
  }
  function bsPrice(S, K, T, v, call) {
    if (T <= 0 || v <= 0) return Math.max(0, call ? S - K : K - S);
    const d1 = (Math.log(S / K) + (RATE + v * v / 2) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
    return call ? S * ncdf(d1) - K * Math.exp(-RATE * T) * ncdf(d2) : K * Math.exp(-RATE * T) * ncdf(-d2) - S * ncdf(-d1);
  }
  function impliedVol(price, S, K, T, call) {
    if (!(price > 0) || !(S > 0) || !(T > 0)) return null;
    const intrinsic = Math.max(0, call ? S - K * Math.exp(-RATE * T) : K * Math.exp(-RATE * T) - S);
    if (price <= intrinsic + 0.01) return null;     // no time value left to read an IV from
    let lo = 0.005, hi = 4;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (bsPrice(S, K, T, mid, call) > price) hi = mid; else lo = mid;
    }
    const v = (lo + hi) / 2;
    return v > 3.9 ? null : v * 100;
  }
  // Years to expiry; contracts expire at 3:30 pm IST (10:00 UTC)
  const yearsTo = expiry => Math.max(0, (Date.parse(expiry + 'T10:00:00Z') - Date.now()) / (365 * 864e5));
  const daysTo = expiry => Math.max(0, (Date.parse(expiry + 'T10:00:00Z') - Date.now()) / 864e5);

  // ---------- chain analysis ----------
  function analyse(calls, puts, spot) {
    const strikes = [...new Set([...calls, ...puts].map(r => r.strike))].sort((a, b) => a - b);
    const atm = strikes.length && spot ? strikes.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), strikes[0]) : null;
    const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const callOI = sum(calls, 'oi'), putOI = sum(puts, 'oi');
    const maxBy = (rows, k) => rows.reduce((b, r) => ((r[k] || 0) > ((b && b[k]) || 0) ? r : b), null);
    // Max pain: the expiry price at which option holders together lose the most
    let maxPain = null, least = Infinity;
    for (const K of strikes) {
      let pain = 0;
      for (const c of calls) pain += (c.oi || 0) * Math.max(0, K - c.strike);
      for (const p of puts) pain += (p.oi || 0) * Math.max(0, p.strike - K);
      if (pain < least) { least = pain; maxPain = K; }
    }
    const res = maxBy(calls.filter(r => !spot || r.strike >= spot), 'oi');
    const sup = maxBy(puts.filter(r => !spot || r.strike <= spot), 'oi');
    return {
      atm, maxPain,
      pcr: callOI ? putOI / callOI : null,
      pcrChange: (() => { const c = sum(calls, 'oiChange'), p = sum(puts, 'oiChange'); return { calls: c, puts: p }; })(),
      resistance: res ? res.strike : null, resistanceOI: res ? res.oi : null,
      support: sup ? sup.strike : null, supportOI: sup ? sup.oi : null,
      callWriting: maxBy(calls, 'oiChange'), putWriting: maxBy(puts, 'oiChange'),
    };
  }

  // ---------- the underlying's verdict (daily, all strategies) ----------
  async function verdictFor(u) {
    const hit = verdictCache.get(u.isec);
    if (hit && Date.now() - hit.at < 5 * 60e3) return hit.result;
    const sym = u.kind === 'index' ? INDEX_CHART[u.isec] : u.symbol;
    if (!sym || !root.app || !root.app.analysis) return null;
    try {
      const result = await root.app.analysis.analyzeStock(sym, '__all', '1d', null, {});
      verdictCache.set(u.isec, { at: Date.now(), result });
      return result;
    } catch (e) {
      console.warn('F&O verdict failed:', e.message);
      return null;
    }
  }

  // An options idea that follows the verdict. Educational; always labelled.
  function idea(result, calls, puts, A, spot, u, expiry) {
    const days = daysTo(expiry);
    const decay = days < 3 ? ` Expiry is ${days < 1 ? 'today' : 'in ' + Math.ceil(days) + ' days'}, so time decay is very fast; a later expiry is safer for buyers.` : '';
    const lot = u.lot || 1;
    const at = (rows, k) => rows.find(r => r.strike === k);
    const nearest = (rows, target) => rows.reduce((b, r) => (b == null || Math.abs(r.strike - target) < Math.abs(b.strike - target) ? r : b), null);
    if (!result || !result.consensus) {
      return { tone: 'neutral', head: 'No verdict available for this underlying', body: `MarketMind can't chart ${esc(u.name)} for a verdict, so there is no directional idea. Use the OI range below: support near ${rs(A.support, 0)}, resistance near ${rs(A.resistance, 0)}.` };
    }
    const c = result.consensus.conclusion;
    if (c.tone === 'long') {
      const buy = at(calls, A.atm);
      const sell = c.sell1 ? nearest(calls.filter(r => r.strike > A.atm), c.sell1) : null;
      if (!buy || !(buy.ltp > 0)) return { tone: 'long', head: `Verdict: ${c.verdict}`, body: 'No traded at-the-money call to price an idea from.' };
      let body = `<b>Buy the ${int(A.atm)} call</b> at about ${rs(buy.ltp)}: costs ${rs(buy.ltp * lot, 0)} per lot of ${int(lot)}, that is also the most you can lose. Breakeven at expiry: ${rs(A.atm + buy.ltp, 0)}.`;
      if (sell && sell.ltp > 0 && sell.ltp < buy.ltp) {
        const cost = buy.ltp - sell.ltp, width = sell.strike - A.atm;
        body += ` <br>Cheaper option, a <b>bull call spread</b>: buy ${int(A.atm)} call and sell ${int(sell.strike)} call (near the stock's selling level ${rs(c.sell1, 0)}). Net cost ${rs(cost * lot, 0)} per lot; best case ${rs((width - cost) * lot, 0)} if it closes above ${int(sell.strike)}.`;
      }
      return { tone: 'long', head: `Verdict: ${c.verdict}, so a bullish idea`, body: body + decay };
    }
    if (c.tone === 'short') {
      const buy = at(puts, A.atm);
      const sell = c.coverAt ? nearest(puts.filter(r => r.strike < A.atm), c.coverAt) : null;
      if (!buy || !(buy.ltp > 0)) return { tone: 'short', head: `Verdict: ${c.verdict}`, body: 'No traded at-the-money put to price an idea from.' };
      let body = `<b>Buy the ${int(A.atm)} put</b> at about ${rs(buy.ltp)}: costs ${rs(buy.ltp * lot, 0)} per lot of ${int(lot)}, that is also the most you can lose. Breakeven at expiry: ${rs(A.atm - buy.ltp, 0)}.`;
      if (sell && sell.ltp > 0 && sell.ltp < buy.ltp) {
        const cost = buy.ltp - sell.ltp, width = A.atm - sell.strike;
        body += ` <br>Cheaper option, a <b>bear put spread</b>: buy ${int(A.atm)} put and sell ${int(sell.strike)} put (near the downside target ${rs(c.coverAt, 0)}). Net cost ${rs(cost * lot, 0)} per lot; best case ${rs((width - cost) * lot, 0)} if it closes below ${int(sell.strike)}.`;
      }
      return { tone: 'short', head: `Verdict: ${c.verdict}, so a bearish idea`, body: body + decay };
    }
    return {
      tone: 'neutral', head: `Verdict: ${c.verdict}, so no directional options trade`,
      body: `With no clear direction, option buyers usually lose to time decay. Option open interest puts the range at <b>${rs(A.support, 0)}</b> (most put OI, support) to <b>${rs(A.resistance, 0)}</b> (most call OI, resistance)${spot ? `, with ${u.kind === 'index' ? 'the index' : 'the stock'} at ${rs(spot, 0)}` : ''}. Wait for the verdict to turn, or for price to break out of that range.`,
    };
  }

  // ---------- option buy / sell points from the underlying's demand and supply zones ----------
  // Each option is priced at the underlying's zone levels with Black-Scholes, using that strike's
  // own implied volatility (from its live price). Estimates: time decay lowers premiums every day.
  const firstExpiry = u => u.options.find(d => daysTo(d) >= 5) || u.options[0];

  function optionPlans({ u, expiry, calls, puts, spot, call }) {
    if (!call || call.error || !spot) return null;
    const T = yearsTo(expiry), lot = u.lot || 1;
    const D = call.demand, S = call.supply;
    const strikes = [...new Set([...calls, ...puts].map(r => r.strike))].sort((a, b) => a - b);
    if (!strikes.length) return null;
    const nearest = x => strikes.reduce((b, k) => (Math.abs(k - x) < Math.abs(b - x) ? k : b), strikes[0]);
    const row = (rows, k) => rows.find(r => r.strike === k);
    const ivOf = (r, isCall, K) => (r && impliedVol(r.ltp, spot, K, T, isCall)) || null;
    const atmIV = (() => { const k = nearest(spot); const a = [ivOf(row(calls, k), true, k), ivOf(row(puts, k), false, k)].filter(Boolean); return a.length ? a.reduce((x, y) => x + y) / a.length : 20; })();
    const price = (K, isCall, at) => { const r = row(isCall ? calls : puts, K); const iv = ivOf(r, isCall, K) || atmIV; return bsPrice(at, K, T, iv / 100, isCall); };
    const live = (K, isCall, side) => { const r = row(isCall ? calls : puts, K); if (!r) return null; return side === 'buy' ? (r.ask > 0 ? r.ask : r.ltp) : (r.bid > 0 ? r.bid : r.ltp); };
    const r2 = v => (v == null || !isFinite(v) ? null : Math.max(0.05, Math.round(v * 20) / 20));   // NSE tick 0.05
    const plans = [];
    const bullish = call.action === 'BUY' || call.action === 'BUY ON DIP';
    const bearish = call.action === 'SELL';
    const name = (K, isCall) => `${int(K)} ${isCall ? 'CE' : 'PE'}`;

    // BUY CALL: at the demand zone (or now on a BUY call); stop if the zone fails; target the supply zone
    if (D && S && S.proximal > D.proximal) {
      const now = call.action === 'BUY';
      const at = now ? spot : D.proximal;
      const K = nearest(at);
      const entry = now ? live(K, true, 'buy') : price(K, true, at);
      const stop = price(K, true, D.stop), target = price(K, true, S.proximal);
      if (entry > 0) plans.push({ kind: 'buy', isCall: true, strike: K, label: `Buy ${name(K, true)}`, favoured: bullish,
        when: now ? `Now (${u.kind === 'index' ? 'index' : 'stock'} ${rs(spot, 0)} is at the demand zone)` : `When ${u.symbol} falls to ${rs(D.proximal)} (demand zone)`,
        entry: r2(entry), stop: r2(stop), target: r2(target),
        stopWhy: `${u.symbol} closes below ${rs(D.stop)}`, targetWhy: `${u.symbol} reaches ${rs(S.proximal)} (supply)` });
    }
    // BUY PUT: at the supply zone (or now on a SELL call); stop if the zone breaks; target the demand zone
    if (S && D && S.proximal > D.proximal) {
      const now = call.action === 'SELL';
      const at = now ? spot : S.proximal;
      const K = nearest(at);
      const entry = now ? live(K, false, 'buy') : price(K, false, at);
      const stop = price(K, false, S.stop), target = price(K, false, D.proximal);
      if (entry > 0) plans.push({ kind: 'buy', isCall: false, strike: K, label: `Buy ${name(K, false)}`, favoured: bearish,
        when: now ? `Now (${u.kind === 'index' ? 'index' : 'stock'} ${rs(spot, 0)} is at the supply zone)` : `When ${u.symbol} rises to ${rs(S.proximal)} (supply zone)`,
        entry: r2(entry), stop: r2(stop), target: r2(target),
        stopWhy: `${u.symbol} closes above ${rs(S.stop)}`, targetWhy: `${u.symbol} falls to ${rs(D.proximal)} (demand)` });
    }
    // SELL PUT (writing): strike below the demand zone; sellers keep the premium if price stays above the zone
    if (D) {
      const K = [...strikes].reverse().find(k => k <= D.distal);
      const prem = K != null ? live(K, false, 'sell') : null;
      if (prem > 0) plans.push({ kind: 'write', isCall: false, strike: K, label: `Sell ${name(K, false)}`, favoured: !bearish,
        when: `Now, while ${u.symbol} stays above the demand zone ${rs(D.distal)} – ${rs(D.proximal)}`,
        entry: r2(prem), stop: r2(Math.max(prem * 1.2, Math.min(price(K, false, D.stop), prem * 2))), target: r2(prem * 0.2),
        stopWhy: `buy back if the premium doubles or ${u.symbol} closes below ${rs(D.stop)}, whichever comes first`, targetWhy: 'buy back after about 80% of the premium has decayed' });
    }
    // SELL CALL (writing): strike above the supply zone; sellers keep the premium if price stays below it
    if (S) {
      const K = strikes.find(k => k >= S.distal);
      const prem = K != null ? live(K, true, 'sell') : null;
      if (prem > 0) plans.push({ kind: 'write', isCall: true, strike: K, label: `Sell ${name(K, true)}`, favoured: !bullish,
        when: `Now, while ${u.symbol} stays below the supply zone ${rs(S.proximal)} – ${rs(S.distal)}`,
        entry: r2(prem), stop: r2(Math.max(prem * 1.2, Math.min(price(K, true, S.stop), prem * 2))), target: r2(prem * 0.2),
        stopWhy: `buy back if the premium doubles or ${u.symbol} closes above ${rs(S.stop)}, whichever comes first`, targetWhy: 'buy back after about 80% of the premium has decayed' });
    }
    for (const p of plans) {
      const buy = p.kind === 'buy';
      p.risk = p.stop != null ? (buy ? p.entry - p.stop : p.stop - p.entry) * lot : null;
      p.reward = p.target != null ? (buy ? p.target - p.entry : p.entry - p.target) * lot : null;
      p.cost = buy ? p.entry * lot : null;
      if (buy && p.risk != null && p.risk <= 0) p.risk = p.entry * lot;   // stop at or above entry: worst case is the premium
    }
    return { expiry, days: Math.ceil(daysTo(expiry)), lot, spot, contract: spot * lot, plans, symbol: u.symbol, kind: u.kind };
  }

  function plansHtml(P, only, compact) {
    if (!P) return '<p class="muted">Option levels need the underlying\'s demand and supply zones; none are available right now.</p>';
    const list = P.plans.filter(p => !only || (only === 'calls' ? p.isCall : !p.isCall));
    if (!list.length) return '<p class="muted">No demand or supply zone close enough to plan an option trade from.</p>';
    const margin = `${rs(P.contract * 0.12, 0)} – ${rs(P.contract * 0.2, 0)}`;
    return `<div class="fno-tablewrap"><table class="screener-table fno-table op-table">
      <thead><tr><th>Trade</th><th>When</th><th>Entry premium</th><th>Stop-loss</th><th>Target</th><th>Per lot (${int(P.lot)})</th></tr></thead>
      <tbody>${list.map(p => `<tr class="${p.favoured ? 'op-fav' : ''} ${p.kind === 'write' ? 'op-write' : ''}">
        <td><b class="${p.kind === 'write' ? 'text-red' : p.isCall ? 'text-green' : 'text-red'}">${p.favoured ? '★ ' : ''}${esc(p.label)}</b><br><span class="muted">${p.kind === 'write' ? 'option selling' : 'option buying'}</span></td>
        <td>${esc(p.when)}</td>
        <td><b>${rs(p.entry)}</b><br><span class="muted">${p.kind === 'write' ? 'sell at' : 'buy at'}</span></td>
        <td class="text-red">${rs(p.stop)}<br><span class="muted">${esc(p.stopWhy)}</span></td>
        <td class="text-green">${rs(p.target)}<br><span class="muted">${esc(p.targetWhy)}</span></td>
        <td>${p.kind === 'buy' ? `cost ${rs(p.cost, 0)}<br>` : `margin ~${margin}<br>`}risk ${rs(p.risk, 0)} · gain ${rs(p.reward, 0)}</td>
      </tr>`).join('')}</tbody></table></div>
      ${compact ? `<p class="citation">Expiry ${fmtDate(P.expiry)} (${P.days} days) · ★ matches the positional call · premiums at future levels are estimates · option selling needs margin and has unlimited risk.</p>` : `<p class="citation">Expiry ${fmtDate(P.expiry)} (${P.days} days). ★ = matches the current call. Premiums at future price levels are estimates (Black-Scholes with each strike's live implied volatility) and fall a little every day from time decay; check the live premium before placing. Option buying risks the premium paid. <b>Option selling needs margin (roughly 12–20% of the contract value, check in the ICICI app) and its loss is not limited</b>, so always use the stop-loss.</p>`}`;
  }

  // ---------- loading ----------
  async function load(container, { quiet } = {}) {
    if (busy) return;
    busy = true;
    const body = container.querySelector('#fno-body');
    if (!quiet && body) body.innerHTML = '<p class="muted" style="padding:16px;">Loading live F&amp;O data from ICICI…</p>';
    try {
      const u = meta.find(x => x.isec === state.isec) || meta[0];
      if (!state.expiry || !u.options.includes(state.expiry)) state.expiry = firstExpiry(u) || u.futures[0];
      const [calls, puts] = await Promise.all([
        get('option_chain', { isec: u.isec, expiry: state.expiry, right: 'call' }),
        get('option_chain', { isec: u.isec, expiry: state.expiry, right: 'put' }),
      ]);
      const futures = await Promise.all(u.futures.map(e => get('futures', { isec: u.isec, expiry: e }).catch(err => ({ expiry: e, error: err.message }))));
      const spot = [...calls.rows, ...puts.rows].map(r => r.spot).find(v => v > 0) || futures.map(f => f.spot).find(v => v > 0) || null;
      const T = yearsTo(state.expiry);
      const withIV = (rows, call) => rows.map(r => ({ ...r, change: chg(r.ltp, r.prevClose), iv: spot ? impliedVol(r.ltp, spot, r.strike, T, call) : null }));
      const C = withIV(calls.rows, true), P = withIV(puts.rows, false);
      const A = analyse(C, P, spot);
      const atmIV = (() => { const a = [C.find(r => r.strike === A.atm), P.find(r => r.strike === A.atm)].map(r => r && r.iv).filter(v => v); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; })();
      const same = data && data.u.isec === u.isec;
      data = { u, calls: C, puts: P, futures, spot, A, atmIV, at: Date.now(), verdict: same ? data.verdict : null, verdictDone: same ? data.verdictDone : false };
      render(container);
      // The verdict takes a few seconds (three charts); fill it in when ready
      verdictFor(u).then(result => { if (data && data.u.isec === u.isec) { data.verdict = result; data.verdictDone = true; render(container); } });
    } catch (e) {
      if (body) body.innerHTML = e.needsLogin
        ? `<div class="data-warning">ICICI isn't connected today, and F&amp;O data comes only from ICICI. <a href="api/breeze.php?action=login">Log in to ICICI</a>, then come back to this page.</div>`
        : `<div class="data-warning">Couldn't load F&amp;O data: ${esc(e.message)}</div>`;
    } finally {
      busy = false;
    }
  }

  // ---------- rendering ----------
  function render(container) {
    const body = container.querySelector('#fno-body');
    if (!body || !data) return;
    const { u, spot, A } = data;
    const fut = data.futures.find(f => !f.error && f.ltp);
    const premium = fut && spot ? fut.ltp - spot : null;
    const time = new Date(data.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const live = marketOpen()
      ? `<span class="live-dot"></span><span><strong>Live</strong> · refreshes every 30 seconds · last update ${time}</span>`
      : `<span class="tag tag-yellow">Market closed</span><span>Showing the last traded prices (updated ${time}).</span>`;

    const tiles = `
      <div class="fno-tiles">
        ${tile(u.kind === 'index' ? 'Index (spot)' : 'Stock price (spot)', rs(spot))}
        ${tile('Futures (' + (fut ? fmtDate(fut.expiry).replace(/ \d{4}$/, '') : '—') + ')', fut ? rs(fut.ltp) : '—', premium != null ? `${premium >= 0 ? 'premium' : 'discount'} ${rs(Math.abs(premium))}` : '')}
        ${tile('Put-call ratio (OI)', A.pcr != null ? A.pcr.toFixed(2) : '—', A.pcr == null ? '' : A.pcr > 1.2 ? 'more puts: traders hedging or expecting support' : A.pcr < 0.8 ? 'more calls: traders capping the upside' : 'balanced')}
        ${tile('Max pain', rs(A.maxPain, 0), 'where option buyers lose most at expiry')}
        ${tile('OI support', rs(A.support, 0), A.supportOI ? big(A.supportOI) + ' put OI' : '')}
        ${tile('OI resistance', rs(A.resistance, 0), A.resistanceOI ? big(A.resistanceOI) + ' call OI' : '')}
        ${tile('ATM strike / IV', `${int(A.atm)} · ${data.atmIV ? data.atmIV.toFixed(1) + '%' : '—'}`, 'implied volatility')}
        ${tile('Lot size', int(u.lot), `expiry ${fmtDate(state.expiry)} · ${Math.ceil(daysTo(state.expiry))} day${Math.ceil(daysTo(state.expiry)) === 1 ? '' : 's'} left`)}
      </div>`;

    const I = data.verdictDone
      ? idea(data.verdict, data.calls, data.puts, A, spot, u, state.expiry)
      : { tone: 'neutral', head: 'Working out the verdict…', body: `Running all 24 strategies on ${esc(u.name)}'s daily chart. This takes a few seconds.` };
    const verdictHtml = `
      <div class="plain-summary ps-${I.tone}">
        <div class="ps-label">Options idea from the verdict</div>
        <p class="ps-headline">${esc(I.head)}</p>
        <p style="font-size:0.9rem;line-height:1.6;">${I.body}</p>
        <p class="ps-foot">Educational idea, not a recommendation. Options can lose 100% of the premium. Check liquidity (bid/ask gap) before trading.</p>
      </div>`;

    const tabs = ['summary', 'calls', 'puts', 'futures'].map(t => `<button type="button" class="fno-tab${state.tab === t ? ' active' : ''}" data-tab="${t}">${{ summary: 'Summary', calls: 'Calls (CE)', puts: 'Puts (PE)', futures: 'Futures' }[t]}</button>`).join('');

    let panel = '';
    let P = null;
    if (data.verdictDone && data.verdict && root.Watchlist) {
      const v = data.verdict;
      try { P = optionPlans({ u, expiry: state.expiry, calls: data.calls, puts: data.puts, spot, call: root.Watchlist._makeCall({ md: v.marketData, ks: v.ks001, cs: v.consensus }, 'pos') }); } catch (e) { console.warn('Option plans:', e.message); }
    }
    const plansBox = only => `<div class="analysis-section" style="margin-top:0;"><h3>Option buy &amp; sell points <span class="muted" style="font-weight:400;font-size:0.8rem;">from ${esc(u.symbol)}'s demand and supply zones (daily chart)</span></h3>${data.verdictDone ? plansHtml(P, only) : '<p class="muted">Working out the zones…</p>'}</div>`;
    if (state.tab === 'summary') panel = verdictHtml + plansBox() + tiles + oiNotes(A);
    if (state.tab === 'calls') panel = plansBox('calls') + chainTable(data.calls, true, A, spot);
    if (state.tab === 'puts') panel = plansBox('puts') + chainTable(data.puts, false, A, spot);
    if (state.tab === 'futures') panel = futuresTable(data.futures, spot, u);

    body.innerHTML = `
      <div class="live-bar">${live}</div>
      <div class="fno-tabs" role="tablist">${tabs}</div>
      <div class="fno-panel">${panel}</div>`;
    body.querySelectorAll('.fno-tab').forEach(b => { b.onclick = () => { state.tab = b.dataset.tab; render(container); }; });
    const all = body.querySelector('#fno-showall');
    if (all) all.onclick = () => { state.showAll = !state.showAll; render(container); };
  }

  const tile = (label, value, sub) => `<div class="v-tile"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

  function oiNotes(A) {
    const lines = [];
    if (A.callWriting && A.callWriting.oiChange > 0) lines.push(`Most new <b>call</b> positions today at ${int(A.callWriting.strike)} (+${big(A.callWriting.oiChange)} OI): sellers expect price to stay below it.`);
    if (A.putWriting && A.putWriting.oiChange > 0) lines.push(`Most new <b>put</b> positions today at ${int(A.putWriting.strike)} (+${big(A.putWriting.oiChange)} OI): sellers expect price to stay above it.`);
    lines.push(`Total OI change today: calls ${A.pcrChange.calls >= 0 ? '+' : ''}${big(A.pcrChange.calls)}, puts ${A.pcrChange.puts >= 0 ? '+' : ''}${big(A.pcrChange.puts)}.`);
    return `<div class="analysis-section" style="margin-top:14px;"><h3>What the open interest says</h3><ul class="fno-notes">${lines.map(l => `<li>${l}</li>`).join('')}</ul>
      <p class="citation">OI = open contracts. Heavy call OI above price often acts as resistance and heavy put OI below as support, because option sellers defend those strikes.</p></div>`;
  }

  function chainTable(rows, call, A, spot) {
    if (!rows.length) return '<p class="muted">No contracts returned for this expiry.</p>';
    let list = rows;
    if (!state.showAll && A.atm != null) {
      const i = rows.findIndex(r => r.strike === A.atm);
      if (i >= 0) list = rows.slice(Math.max(0, i - AROUND), i + AROUND + 1);
    }
    const maxOI = Math.max(...rows.map(r => r.oi || 0), 1);
    const body = list.map(r => {
      const itm = spot ? (call ? r.strike < spot : r.strike > spot) : false;
      const w = Math.round((r.oi || 0) / maxOI * 100);
      return `<tr class="${itm ? 'fno-itm' : ''}${r.strike === A.atm ? ' fno-atm' : ''}">
        <td class="fno-strike">${int(r.strike)}${r.strike === A.atm ? ' <span class="tag">ATM</span>' : ''}</td>
        <td>${num(r.ltp)}</td>
        <td class="${cls(r.change)}">${pct(r.change)}</td>
        <td class="fno-oi"><span class="fno-oibar ${call ? 'call' : 'put'}" style="width:${w}%"></span><span>${big(r.oi)}</span></td>
        <td class="${cls(r.oiChange)}">${r.oiChange > 0 ? '+' : ''}${big(r.oiChange)}</td>
        <td>${big(r.volume)}</td>
        <td>${r.iv ? r.iv.toFixed(1) + '%' : '—'}</td>
        <td class="fno-ba">${num(r.bid)} / ${num(r.ask)}</td>
      </tr>`;
    }).join('');
    return `
      <div class="fno-tablewrap"><table class="screener-table fno-table">
        <thead><tr><th>Strike</th><th>LTP</th><th>Change</th><th>OI</th><th>OI change</th><th>Volume</th><th>IV</th><th>Bid / Ask</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <p class="citation">${call ? 'Calls' : 'Puts'}, expiry ${fmtDate(state.expiry)}. Shaded rows are in the money. Change is against the previous close; IV is worked out from the last price (Black-Scholes, ${(RATE * 100).toFixed(1)}% rate).
        <button type="button" id="fno-showall" class="link-btn">${state.showAll ? `Show ${AROUND} strikes each side of ATM` : `Show all ${rows.length} strikes`}</button></p>`;
  }

  function futuresTable(list, spot, u) {
    const rows = list.map(f => {
      if (f.error) return `<tr><td>${fmtDate(f.expiry)}</td><td colspan="6" class="text-red">${esc(f.error)}</td></tr>`;
      const prem = spot && f.ltp ? f.ltp - spot : null;
      const days = daysTo(f.expiry);
      const annual = prem != null && days > 0 ? prem / spot * 365 / days * 100 : null;
      return `<tr>
        <td>${fmtDate(f.expiry)}</td>
        <td>${rs(f.ltp)}</td>
        <td class="${cls(chg(f.ltp, f.prevClose))}">${pct(chg(f.ltp, f.prevClose))}</td>
        <td class="${cls(prem)}">${prem == null ? '—' : (prem >= 0 ? '+' : '') + num(prem)}${annual != null ? `<br><span class="muted">${annual.toFixed(1)}% a year</span>` : ''}</td>
        <td>${rs(f.low)} – ${rs(f.high)}</td>
        <td>${big(f.volume)}</td>
        <td>${rs(f.ltp * (u.lot || 0), 0)}</td>
      </tr>`;
    }).join('');
    return `
      <div class="fno-tablewrap"><table class="screener-table fno-table">
        <thead><tr><th>Expiry</th><th>Price</th><th>Change</th><th>Premium over spot</th><th>Day range</th><th>Volume</th><th>Contract value (1 lot)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="citation">Lot size ${int(u.lot)}. A futures position needs margin (roughly 12–20% of contract value), not the full value. A premium over spot is normal (cost of carry); a discount can mean bearish positioning or an upcoming dividend.</p>`;
  }

  // ---------- page ----------
  async function renderPage(container) {
    if (!container) return;
    if (!container.dataset.ready) {
      container.dataset.ready = '1';
      container.innerHTML = `
        <div class="fno-controls">
          <label>Underlying<select id="fno-under"><option>Loading…</option></select></label>
          <label>Expiry<select id="fno-expiry"></select></label>
          <button type="button" class="btn-secondary" id="fno-refresh">Refresh</button>
        </div>
        <div id="fno-body"><p class="muted" style="padding:16px;">Loading the F&amp;O list…</p></div>`;
      container.querySelector('#fno-refresh').onclick = () => load(container);
    }
    try {
      if (!meta) meta = (await get('fo_meta')).underlyings;
    } catch (e) {
      container.querySelector('#fno-body').innerHTML = e.needsLogin
        ? `<div class="data-warning">ICICI isn't connected today, and F&amp;O data comes only from ICICI. <a href="api/breeze.php?action=login">Log in to ICICI</a>, then come back to this page.</div>`
        : `<div class="data-warning">Couldn't load the F&amp;O list: ${esc(e.message)}</div>`;
      return;
    }
    const sel = container.querySelector('#fno-under'), exp = container.querySelector('#fno-expiry');
    if (!sel.dataset.ready) {
      sel.dataset.ready = '1';
      const opt = u => `<option value="${esc(u.isec)}">${esc(u.kind === 'index' ? u.name : `${u.symbol} — ${u.name}`)}</option>`;
      sel.innerHTML = `<optgroup label="Indices">${meta.filter(u => u.kind === 'index').map(opt).join('')}</optgroup><optgroup label="Stocks">${meta.filter(u => u.kind === 'stock').map(opt).join('')}</optgroup>`;
      sel.value = state.isec;
      const fillExpiries = () => {
        const u = meta.find(x => x.isec === sel.value);
        exp.innerHTML = u.options.map(d => `<option value="${d}">${fmtDate(d)}</option>`).join('');
        if (u.options.includes(state.expiry)) exp.value = state.expiry; else { state.expiry = firstExpiry(u); exp.value = state.expiry; }
      };
      fillExpiries();
      sel.onchange = () => { state.isec = sel.value; state.expiry = null; state.showAll = false; fillExpiries(); data = null; load(container); };
      exp.onchange = () => { state.expiry = exp.value; load(container); };
    }
    await load(container);
    clearInterval(timer);
    timer = setInterval(() => {
      const page = document.getElementById('page-fno');
      if (!page || !page.classList.contains('active') || document.hidden || !marketOpen()) return;
      load(container, { quiet: true });
    }, REFRESH_MS);
  }

  // Open the page for a given NSE symbol (used from the Analyze page)
  function openFor(symbol) {
    const s = String(symbol || '').toUpperCase();
    const u = meta && meta.find(x => x.symbol === s || x.isec === s);
    if (u) { state.isec = u.isec; state.expiry = null; const sel = document.getElementById('fno-under'); if (sel) { sel.value = u.isec; sel.onchange && sel.onchange(); } }
  }

  root.FnO = { renderPage, openFor, optionPlans, plansHtml, firstExpiry, _impliedVol: impliedVol, _analyse: analyse };
})(typeof window !== 'undefined' ? window : globalThis);

// MarketMind AI — Option strategy builder (F&O page, "Strategy builder" tab)
// Builds spreads, straddles, strangles, iron condors and iron butterflies on the live chain:
// payoff at expiry and on a chosen day, max profit / loss, breakevens, chance of profit,
// net Greeks and a margin estimate.
(function (root) {
  'use strict';

  const RATE = 0.065;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const rs = (v, d = 0) => (v == null || !isFinite(v) ? '—' : (v < 0 ? '−₹' : '₹') + num(Math.abs(v), d));
  const int = v => (v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString('en-IN'));
  const r05 = v => Math.max(0.05, Math.round(v * 20) / 20);

  function ncdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  function bs(S, K, T, v, call) {
    if (T <= 0 || v <= 0) return Math.max(0, call ? S - K : K - S);
    const d1 = (Math.log(S / K) + (RATE + v * v / 2) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
    return call ? S * ncdf(d1) - K * Math.exp(-RATE * T) * ncdf(d2) : K * Math.exp(-RATE * T) * ncdf(-d2) - S * ncdf(-d1);
  }

  // ---------- templates ----------
  // i0 = ATM strike index; d = distance from ATM, w = wing width (both in strikes)
  const TEMPLATES = {
    bull_call:   { name: 'Bull call spread', view: 'up', params: ['w'], legs: (i0, d, w) => [['buy', 'CE', i0], ['sell', 'CE', i0 + w]],
      about: 'Buy a call, sell a higher call. Cheaper than a plain call; profit capped at the higher strike.' },
    bull_put:    { name: 'Bull put spread', view: 'up', params: ['d', 'w'], legs: (i0, d, w) => [['sell', 'PE', i0 - d], ['buy', 'PE', i0 - d - w]],
      about: 'Sell a put below price, buy a lower put as protection. You collect premium; profit if price stays above the sold strike.' },
    bear_put:    { name: 'Bear put spread', view: 'down', params: ['w'], legs: (i0, d, w) => [['buy', 'PE', i0], ['sell', 'PE', i0 - w]],
      about: 'Buy a put, sell a lower put. Cheaper than a plain put; profit capped at the lower strike.' },
    bear_call:   { name: 'Bear call spread', view: 'down', params: ['d', 'w'], legs: (i0, d, w) => [['sell', 'CE', i0 + d], ['buy', 'CE', i0 + d + w]],
      about: 'Sell a call above price, buy a higher call as protection. You collect premium; profit if price stays below the sold strike.' },
    long_straddle:  { name: 'Long straddle', view: 'move', params: [], legs: i0 => [['buy', 'CE', i0], ['buy', 'PE', i0]],
      about: 'Buy the ATM call and put. Profits from a big move either way (results, events); loses if price sits still.' },
    short_straddle: { name: 'Short straddle', view: 'flat', params: [], legs: i0 => [['sell', 'CE', i0], ['sell', 'PE', i0]],
      about: 'Sell the ATM call and put. Profits if price stays near the strike; loss is unlimited on a big move.' },
    long_strangle:  { name: 'Long strangle', view: 'move', params: ['d'], legs: (i0, d) => [['buy', 'CE', i0 + d], ['buy', 'PE', i0 - d]],
      about: 'Buy an OTM call and an OTM put. Cheaper than a straddle; needs a bigger move.' },
    short_strangle: { name: 'Short strangle', view: 'flat', params: ['d'], legs: (i0, d) => [['sell', 'CE', i0 + d], ['sell', 'PE', i0 - d]],
      about: 'Sell an OTM call and an OTM put. Profits if price stays between them; loss is unlimited outside.' },
    iron_condor:    { name: 'Iron condor', view: 'flat', params: ['d', 'w'], legs: (i0, d, w) => [['buy', 'PE', i0 - d - w], ['sell', 'PE', i0 - d], ['sell', 'CE', i0 + d], ['buy', 'CE', i0 + d + w]],
      about: 'A bull put spread plus a bear call spread. Profits if price stays between the sold strikes; loss is capped by the wings.' },
    iron_fly:       { name: 'Iron butterfly', view: 'flat', params: ['w'], legs: (i0, d, w) => [['buy', 'PE', i0 - w], ['sell', 'PE', i0], ['sell', 'CE', i0], ['buy', 'CE', i0 + w]],
      about: 'A short straddle with protective wings. More premium than a condor, narrower profit zone, capped loss.' },
    custom:         { name: 'Custom', view: '', params: [], legs: null, about: 'Add and edit legs yourself.' },
  };
  const VIEW_WORD = { up: 'rising', down: 'falling', flat: 'range-bound', move: 'big move' };

  const B = { key: null, tpl: 'iron_condor', d: 2, w: 2, lots: 1, legs: [], day: 0 };

  // ---------- chain helpers ----------
  function chainCtx(ctx) {
    const strikes = [...new Set([...ctx.calls, ...ctx.puts].map(r => r.strike))].sort((a, b) => a - b);
    const i0 = strikes.reduce((b, k, i) => (Math.abs(k - ctx.spot) < Math.abs(strikes[b] - ctx.spot) ? i : b), 0);
    return { strikes, i0 };
  }
  const rowOf = (ctx, right, K) => (right === 'CE' ? ctx.calls : ctx.puts).find(r => r.strike === K);
  function livePrem(ctx, side, right, K) {
    const r = rowOf(ctx, right, K);
    if (!r) return null;
    const v = side === 'buy' ? (r.ask > 0 ? r.ask : r.ltp) : (r.bid > 0 ? r.bid : r.ltp);
    return v > 0 ? v : null;
  }
  function ivOf(ctx, right, K) {
    const r = rowOf(ctx, right, K);
    return (r && r.iv) || ctx.atmIV || 20;
  }

  function buildLegs(ctx) {
    const t = TEMPLATES[B.tpl];
    if (!t.legs) return;
    const { strikes, i0 } = chainCtx(ctx);
    const clamp = i => Math.max(0, Math.min(strikes.length - 1, i));
    B.legs = t.legs(i0, B.d, B.w).map(([side, right, i]) => ({ side, right, strike: strikes[clamp(i)], lots: B.lots, prem: null, custom: false }));
  }
  function refreshPremiums(ctx) {
    for (const l of B.legs) if (!l.custom) l.prem = livePrem(ctx, l.side, l.right, l.strike);
  }

  // ---------- maths ----------
  function evaluate(ctx) {
    const lot = ctx.lot, T = ctx.T, S0 = ctx.spot;
    const legs = B.legs.filter(l => l.prem > 0 && l.lots > 0 && l.strike > 0)
      .map(l => ({ ...l, q: (l.side === 'buy' ? 1 : -1) * l.lots * lot, iv: ivOf(ctx, l.right, l.strike) / 100 }));
    if (!legs.length) return null;
    const atExpiry = S => legs.reduce((a, l) => a + l.q * (Math.max(0, l.right === 'CE' ? S - l.strike : l.strike - S) - l.prem), 0);
    const onDay = (S, t) => legs.reduce((a, l) => a + l.q * (bs(S, l.strike, Math.max(0, t), l.iv, l.right === 'CE') - l.prem), 0);
    const net = legs.reduce((a, l) => a - l.q * l.prem, 0);   // + = credit received

    // Kinks and slopes
    const ks = [...new Set(legs.map(l => l.strike))].sort((a, b) => a - b);
    const rightSlope = legs.filter(l => l.right === 'CE').reduce((a, l) => a + l.q, 0);
    const pts = [0, ...ks, ks[ks.length - 1] * 3];
    const vals = pts.map(atExpiry);
    let maxP = Math.max(...vals), maxL = Math.min(...vals);
    const unlimitedProfit = rightSlope > 1e-9, unlimitedLoss = rightSlope < -1e-9;
    if (unlimitedProfit) maxP = Infinity;
    if (unlimitedLoss) maxL = -Infinity;

    // Breakevens: roots of the piecewise-linear payoff
    const be = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], va = vals[i], vb = vals[i + 1];
      if (va === 0 && i > 0) be.push(a);
      else if ((va < 0 && vb > 0) || (va > 0 && vb < 0)) be.push(a + (b - a) * (-va) / (vb - va));
    }
    const breakevens = [...new Set(be.map(x => Math.round(x * 100) / 100))].filter(x => x > 0);

    // Chance of profit at expiry (lognormal, ATM implied volatility)
    const sig = (ctx.atmIV || 20) / 100, sT = sig * Math.sqrt(Math.max(T, 1e-6));
    const cdf = x => (x <= 0 ? 0 : !isFinite(x) ? 1 : ncdf((Math.log(x / S0) - (RATE - sig * sig / 2) * T) / sT));
    const edges = [0, ...breakevens, Infinity];
    let pop = 0;
    for (let i = 0; i < edges.length - 1; i++) {
      const a = edges[i], b = edges[i + 1];
      const mid = !isFinite(b) ? a * 1.5 + 1 : (a + b) / 2;
      if (atExpiry(mid) > 0) pop += cdf(b) - cdf(a);
    }

    // Net Greeks now (numerical)
    const h = S0 * 0.001, t = T;
    const delta = (onDay(S0 + h, t) - onDay(S0 - h, t)) / (2 * h);
    const theta = onDay(S0, t - 1 / 365) - onDay(S0, t);
    const vega = legs.reduce((a, l) => a + l.q * (bs(S0, l.strike, t, l.iv + 0.01, l.right === 'CE') - bs(S0, l.strike, t, l.iv, l.right === 'CE')), 0);

    // Margin estimate
    const allBuy = legs.every(l => l.q > 0);
    const shortLots = right => Math.max(0, -legs.filter(l => l.right === right).reduce((a, l) => a + l.q, 0) / lot);
    const contract = S0 * lot;
    let margin;
    if (allBuy) margin = { lo: -net, hi: -net, note: 'premium paid; no margin for option buying' };
    else if (shortLots('CE') < 1e-9 && shortLots('PE') < 1e-9) {
      const m = Math.max(-maxL, 0);
      margin = net < 0 ? { lo: m, hi: m, note: 'hedged debit trade: the premium paid is the most you can lose' }
        : { lo: m, hi: m * 1.3, note: 'hedged: brokers block about the maximum loss' };
    } else {
      const n = Math.max(shortLots('CE'), shortLots('PE'));
      margin = { lo: contract * 0.12 * n, hi: contract * 0.2 * n, note: 'unhedged selling: roughly 12–20% of contract value per lot' };
    }
    return { legs, atExpiry, onDay, net, maxP, maxL, breakevens, pop, delta, theta, vega, margin, ks, sig };
  }

  // ---------- chart ----------
  function chart(ctx, R) {
    const narrow = typeof innerWidth === "number" && innerWidth < 640;
    const W = narrow ? 400 : 680, H = narrow ? 300 : 280, L = narrow ? 44 : 62, Rr = 14, Tp = 16, Bt = 34;
    const S0 = ctx.spot, em = S0 * R.sig * Math.sqrt(Math.max(ctx.T, 2 / 365));
    let lo = Math.min(R.ks[0], S0 - 2.5 * em), hi = Math.max(R.ks[R.ks.length - 1], S0 + 2.5 * em);
    lo = Math.min(lo, S0 * 0.95); hi = Math.max(hi, S0 * 1.05);
    const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    const tDay = ctx.T * (1 - B.day / Math.max(1, ctx.days));
    const N = 160, xs = Array.from({ length: N + 1 }, (_, i) => lo + (hi - lo) * i / N);
    const ex = xs.map(R.atExpiry), td = xs.map(x => R.onDay(x, tDay));
    let yMin = Math.min(...ex, ...td, 0), yMax = Math.max(...ex, ...td, 0);
    const yp = (yMax - yMin) * 0.08 || 1; yMin -= yp; yMax += yp;
    const X = v => L + (v - lo) / (hi - lo) * (W - L - Rr), Y = v => Tp + (yMax - v) / (yMax - yMin) * (H - Tp - Bt);
    const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`).join('');
    const y0 = Y(0);
    // Profit / loss fill under the expiry line, clipped above / below zero
    const area = `M${X(xs[0]).toFixed(1)},${y0.toFixed(1)}${ex.map((v, i) => `L${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`).join('')}L${X(xs[N]).toFixed(1)},${y0.toFixed(1)}Z`;
    const nice = (a, b, n) => {   // round tick values (1, 2, 5 × 10^k)
      const raw = (b - a) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
      const st = (m >= 5 ? 10 : m >= 2 ? 5 : m >= 1 ? 2 : 1) * p, out = [];
      for (let v = Math.ceil(a / st) * st; v <= b + 1e-9; v += st) out.push(Math.abs(v) < st / 1e6 ? 0 : v);
      return out;
    };
    const yt = nice(yMin, yMax, 5), xt = nice(lo, hi, 5);
    const short = v => { const a = Math.abs(v); return (v < 0 ? '−' : '') + (a >= 1e5 ? (a / 1e5).toFixed(1) + 'L' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : Math.round(a)); };
    const dayLabel = B.day === 0 ? 'today' : `in ${B.day} day${B.day === 1 ? '' : 's'}`;
    return { svg: `<svg class="ob-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Payoff chart: profit or loss against ${esc(ctx.symbol)} price">
      <defs>
        <clipPath id="ob-up"><rect x="0" y="0" width="${W}" height="${y0}"/></clipPath>
        <clipPath id="ob-dn"><rect x="0" y="${y0}" width="${W}" height="${H - y0}"/></clipPath>
      </defs>
      ${yt.map(v => `<line x1="${L}" x2="${W - Rr}" y1="${Y(v)}" y2="${Y(v)}" class="ob-grid"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="ob-tick">${short(v)}</text>`).join('')}
      ${xt.map(v => `<line x1="${X(v)}" x2="${X(v)}" y1="${H - Bt}" y2="${H - Bt + 4}" class="ob-zero"/><text x="${X(v)}" y="${H - Bt + 16}" text-anchor="${X(v) > W - Rr - 24 ? 'end' : 'middle'}" class="ob-tick">${int(v)}</text>`).join('')}
      <path d="${area}" class="ob-fill-up" clip-path="url(#ob-up)"/>
      <path d="${area}" class="ob-fill-dn" clip-path="url(#ob-dn)"/>
      <line x1="${L}" x2="${W - Rr}" y1="${y0}" y2="${y0}" class="ob-zero"/>
      <line x1="${X(S0)}" x2="${X(S0)}" y1="${Tp}" y2="${H - Bt}" class="ob-spot"/>
      <text x="${X(S0)}" y="${Tp - 4}" text-anchor="middle" class="ob-tick ob-spot-l">spot ${int(S0)}</text>
      ${R.breakevens.filter(b => b > lo && b < hi).map(b => `<circle cx="${X(b)}" cy="${y0}" r="4" class="ob-be"/>`).join('')}
      <path d="${path(td)}" class="ob-today"/>
      <path d="${path(ex)}" class="ob-expiry"/>
      <text x="${W / 2}" y="${H - 4}" text-anchor="middle" class="ob-axis">${esc(ctx.symbol)} price</text>
      <g class="ob-hover" style="display:none"><line class="ob-cross" y1="${Tp}" y2="${H - Bt}"/><circle r="4" class="ob-dot-ex"/><circle r="4" class="ob-dot-td"/></g>
      <rect x="${L}" y="${Tp}" width="${W - L - Rr}" height="${H - Tp - Bt}" fill="transparent" class="ob-hit"/>
    </svg>`, geo: { W, L, Rr, lo, hi, tDay, X, Y, dayLabel } };
  }

  // ---------- html ----------
  function html(ctx) {
    if (!ctx.spot || !ctx.calls.length) return '<p class="muted">The builder needs the live option chain.</p>';
    const key = `${ctx.isec}|${ctx.expiry}`;
    if (B.key !== key) {
      // New underlying or expiry: size distance and wings from the expected move to expiry
      B.key = key; B.day = 0; if (B.tpl === 'custom') B.tpl = 'iron_condor';
      const { strikes, i0 } = chainCtx(ctx);
      const step = strikes[i0 + 1] && strikes[i0] ? strikes[i0 + 1] - strikes[i0] : ctx.spot * 0.01;
      const em = ctx.spot * ((ctx.atmIV || 20) / 100) * Math.sqrt(Math.max(ctx.T, 2 / 365));
      B.d = Math.max(1, Math.min(20, Math.round(em * 0.8 / step)));
      B.w = Math.max(1, Math.min(20, Math.round(B.d / 2)));
      buildLegs(ctx);
    }
    if (B.day > ctx.days) B.day = 0;
    refreshPremiums(ctx);
    const { strikes } = chainCtx(ctx);
    const t = TEMPLATES[B.tpl];
    const fit = ctx.tone === 'long' ? 'up' : ctx.tone === 'short' ? 'down' : ctx.tone ? 'flat' : null;
    const tplBtns = Object.entries(TEMPLATES).map(([id, x]) => `<button type="button" class="ob-tpl${B.tpl === id ? ' active' : ''}" data-tpl="${id}">${fit && x.view === fit ? '★ ' : ''}${esc(x.name)}</button>`).join('');
    const param = (p, label) => t.params.includes(p) ? `<label>${label}<select data-param="${p}">${[...new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, B[p]])].sort((a, b) => a - b).map(n => `<option value="${n}"${B[p] === n ? ' selected' : ''}>${n} strike${n > 1 ? 's' : ''}</option>`).join('')}</select></label>` : '';
    const R = evaluate(ctx);
    const legRows = B.legs.map((l, i) => {
      const r = rowOf(ctx, l.right, l.strike);
      return `<tr>
        <td><select data-leg="${i}" data-f="side"><option value="buy"${l.side === 'buy' ? ' selected' : ''}>Buy</option><option value="sell"${l.side === 'sell' ? ' selected' : ''}>Sell</option></select></td>
        <td><select data-leg="${i}" data-f="right"><option${l.right === 'CE' ? ' selected' : ''}>CE</option><option${l.right === 'PE' ? ' selected' : ''}>PE</option></select></td>
        <td><select data-leg="${i}" data-f="strike">${strikes.map(k => `<option value="${k}"${k === l.strike ? ' selected' : ''}>${int(k)}</option>`).join('')}</select></td>
        <td><input type="number" min="1" step="1" value="${l.lots}" data-leg="${i}" data-f="lots" class="ob-num"></td>
        <td><input type="number" min="0.05" step="0.05" value="${l.prem != null ? l.prem : ''}" placeholder="no price" data-leg="${i}" data-f="prem" class="ob-num${l.custom ? ' ob-custom' : ''}">
          <br><span class="muted small">${r ? `bid ${num(r.bid)} / ask ${num(r.ask)}` : 'not traded'}${l.custom ? ' · <button type="button" class="link-btn" data-live="' + i + '">use live</button>' : ''}</span></td>
        <td class="muted">${r && r.iv ? r.iv.toFixed(1) + '%' : '—'}</td>
        <td><button type="button" class="ob-del" data-del="${i}" aria-label="Remove leg">×</button></td>
      </tr>`;
    }).join('');

    let result = '<p class="muted">Add at least one leg with a price.</p>', svg = '', geo = null;
    if (R) {
      const c = chart(ctx, R); svg = c.svg; geo = c.geo;
      const credit = R.net >= 0;
      const ratio = isFinite(R.maxP) && isFinite(R.maxL) && R.maxL < 0 ? R.maxP / -R.maxL : null;
      const tile = (label, value, sub, cls) => `<div class="v-tile"><div class="label">${label}</div><div class="value ${cls || ''}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
      result = `<div class="fno-tiles ob-tiles">
        ${tile(credit ? 'Net credit (you receive)' : 'Net debit (you pay)', rs(Math.abs(R.net)), `${num(Math.abs(R.net) / ctx.lot / Math.max(1, B.lots))} per share`)}
        ${tile('Max profit', isFinite(R.maxP) ? rs(R.maxP) : 'Unlimited', isFinite(R.maxP) ? 'at expiry' : 'if price keeps rising', 'text-green')}
        ${tile('Max loss', isFinite(R.maxL) ? rs(R.maxL) : 'Unlimited', isFinite(R.maxL) ? (ratio != null ? `reward : risk ${ratio.toFixed(2)} : 1` : 'at expiry') : 'if price keeps rising', 'text-red')}
        ${tile('Breakeven' + (R.breakevens.length > 1 ? 's' : ''), R.breakevens.length ? R.breakevens.map(b => int(b)).join(' / ') : '—', R.breakevens.length ? R.breakevens.map(b => `${((b / ctx.spot - 1) * 100).toFixed(1)}%`).join(' / ') + ' from spot' : 'never crosses zero')}
        ${tile('Chance of profit', (R.pop * 100).toFixed(0) + '%', `at expiry, from ${(R.sig * 100).toFixed(1)}% ATM IV`)}
        ${tile('Margin (estimate)', R.margin.lo === R.margin.hi ? rs(R.margin.lo) : `${rs(R.margin.lo)} – ${rs(R.margin.hi)}`, esc(R.margin.note))}
        ${tile('Net delta', num(R.delta, 1), `≈ ${rs(R.delta * ctx.spot * 0.01)} per 1% move up`)}
        ${tile('Theta / Vega', `${rs(R.theta)} / ${rs(R.vega)}`, 'per day passing / per 1% IV rise')}
      </div>`;
    }

    return `<div class="ob">
      <div class="ob-tpls">${tplBtns}</div>
      <p class="muted ob-about">${esc(t.about)}${t.view ? ` <b>View: ${VIEW_WORD[t.view]}.</b>` : ''}${fit ? ` ★ = fits the current verdict on ${esc(ctx.symbol)}.` : ''}</p>
      <div class="ob-params">
        ${param('d', 'Distance from ATM')}${param('w', 'Width / wing')}
        ${t.legs ? `<label>Lots<input type="number" min="1" step="1" value="${B.lots}" data-param="lots" class="ob-num"></label>` : ''}
        <button type="button" class="btn-secondary" id="ob-add">+ Add leg</button>
      </div>
      <div class="fno-tablewrap"><table class="screener-table fno-table ob-legs">
        <thead><tr><th>Side</th><th>Type</th><th>Strike</th><th>Lots</th><th>Premium</th><th>IV</th><th></th></tr></thead>
        <tbody>${legRows || '<tr><td colspan="7" class="muted">No legs yet.</td></tr>'}</tbody>
      </table></div>
      ${result}
      ${R ? `<div class="analysis-section ob-chartbox">
        <div class="ob-chart-head">
          <h3>Payoff</h3>
          <div class="ob-legend"><span><i class="ob-sw-ex"></i>At expiry</span><span><i class="ob-sw-td"></i>P/L <span id="ob-daylabel">${geo.dayLabel}</span></span></div>
        </div>
        <div class="ob-wrap">${svg}<div class="ob-tip" style="display:none"></div></div>
        ${ctx.days > 0 ? `<label class="ob-day">Show P/L on day <input type="range" min="0" max="${ctx.days}" value="${B.day}" id="ob-dayr"> <span>${B.day} of ${ctx.days}</span></label>` : ''}
      </div>` : ''}
      <p class="citation">Premiums: buy legs at the ask, sell legs at the bid (last price if there is no quote); type your own price to override. The dashed line values each leg with Black-Scholes at its live IV. Chance of profit assumes prices move randomly at the ATM implied volatility. Margin is an estimate; ICICI's SPAN + exposure margin can differ, so check before placing. Brokerage, STT and other charges are not included.</p>
    </div>`;
  }

  // ---------- events ----------
  function wire(el, ctx, rerender) {
    const ob = el.querySelector('.ob');
    if (!ob) return;
    ob.querySelectorAll('.ob-tpl').forEach(b => { b.onclick = () => { B.tpl = b.dataset.tpl; buildLegs(ctx); rerender(); }; });
    ob.querySelectorAll('[data-param]').forEach(s => { s.onchange = () => { const v = Math.max(1, parseInt(s.value, 10) || 1); B[s.dataset.param] = v; buildLegs(ctx); rerender(); }; });
    ob.querySelectorAll('[data-leg]').forEach(s => {
      s.onchange = () => {
        const l = B.legs[+s.dataset.leg], f = s.dataset.f;
        if (f === 'strike') l.strike = Number(s.value);
        else if (f === 'lots') l.lots = Math.max(1, parseInt(s.value, 10) || 1);
        else if (f === 'prem') { const v = parseFloat(s.value); l.prem = v > 0 ? r05(v) : null; l.custom = v > 0; }
        else l[f] = s.value;
        if (f !== 'prem' && f !== 'lots') l.custom = false;
        B.tpl = 'custom'; rerender();
      };
    });
    ob.querySelectorAll('[data-del]').forEach(b => { b.onclick = () => { B.legs.splice(+b.dataset.del, 1); B.tpl = 'custom'; rerender(); }; });
    ob.querySelectorAll('[data-live]').forEach(b => { b.onclick = () => { B.legs[+b.dataset.live].custom = false; rerender(); }; });
    const add = ob.querySelector('#ob-add');
    if (add) add.onclick = () => { const { strikes, i0 } = chainCtx(ctx); B.legs.push({ side: 'buy', right: 'CE', strike: strikes[i0], lots: B.lots, prem: null, custom: false }); B.tpl = 'custom'; rerender(); };
    const dr = ob.querySelector('#ob-dayr');
    if (dr) dr.oninput = () => { B.day = +dr.value; rerender(); };

    // Hover crosshair + tooltip
    const svg = ob.querySelector('.ob-chart'), hit = ob.querySelector('.ob-hit'), tip = ob.querySelector('.ob-tip');
    if (!svg || !hit) return;
    const R = evaluate(ctx); if (!R) return;
    const g = chart(ctx, R).geo;
    const hov = svg.querySelector('.ob-hover'), cross = hov.querySelector('.ob-cross'), dEx = hov.querySelector('.ob-dot-ex'), dTd = hov.querySelector('.ob-dot-td');
    const move = e => {
      const box = svg.getBoundingClientRect();
      const px = (e.clientX - box.left) / box.width * g.W;
      const S = g.lo + (px - g.L) / (g.W - g.L - g.Rr) * (g.hi - g.lo);
      if (S < g.lo || S > g.hi) return;
      const a = R.atExpiry(S), b = R.onDay(S, g.tDay), x = g.X(S);
      hov.style.display = '';
      cross.setAttribute('x1', x); cross.setAttribute('x2', x);
      dEx.setAttribute('cx', x); dEx.setAttribute('cy', g.Y(a)); dTd.setAttribute('cx', x); dTd.setAttribute('cy', g.Y(b));
      tip.style.display = '';
      tip.innerHTML = `<b>${esc(ctx.symbol)} ${int(S)}</b> <span class="muted">(${((S / ctx.spot - 1) * 100).toFixed(1)}%)</span><br>At expiry: <b class="${a >= 0 ? 'text-green' : 'text-red'}">${rs(a)}</b><br>${g.dayLabel[0].toUpperCase() + g.dayLabel.slice(1)}: <b class="${b >= 0 ? 'text-green' : 'text-red'}">${rs(b)}</b>`;
      const left = x / g.W * box.width;
      tip.style.left = Math.min(box.width - 170, Math.max(0, left + 12)) + 'px';
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { hov.style.display = 'none'; tip.style.display = 'none'; });
  }

  root.OptBuilder = { html, wire, _evaluate: evaluate, _B: B, _bs: bs };
})(window);

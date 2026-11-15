// MarketMind AI — Today's plan: one card that says what to do today and how much.
// Buys come from the evening swing scan (sized by your capital and risk per trade, with a cap per sector);
// hold / tighten / exit calls on your holdings come from simple trend rules on the same scan's figures.
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = (v, d = 0) => (v == null || !isFinite(v) ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }));
  const KEY = 'marketmind_plan', DEF = { capital: 100000, riskPct: 1, maxPos: 5, perSector: 2 };
  function settings() { let s = {}; try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* default */ } return { ...DEF, ...s }; }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } }
  async function j(url) { const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }); const x = await r.json().catch(() => null); if (!r.ok || !x) throw new Error((x && x.error) || `HTTP ${r.status}`); return x; }

  // shares to buy: lose no more than risk% of capital if the stop is hit, and put no more than capital ÷ max positions in one stock
  function size(entry, stop, S = settings()) {
    if (!(entry > 0) || !(stop > 0) || stop >= entry) return null;
    const riskAmt = S.capital * S.riskPct / 100, qty = Math.max(0, Math.min(Math.floor(riskAmt / (entry - stop)), Math.floor(S.capital / S.maxPos / entry)));
    return { qty, risk: qty * (entry - stop), value: qty * entry, riskAmt };
  }

  // hold / tighten / exit for something you own, from the evening scan's figures (m) and the latest price
  function holdAction(m, ltp, avg) {
    const p = ltp || (m && m.price);
    if (!m || !p) return { kind: 'none', label: '—', why: 'Not in the NIFTY 500 evening scan' };
    const below = v => v && v < p;
    const stop = below(m.lo10) ? m.lo10 : below(m.sma50) ? m.sma50 : below(m.sma200) ? m.sma200 : null;
    const loss = avg && p < avg * 0.85 ? ' Down more than 15% from your buy price.' : '';
    if (m.sma200 && p < m.sma200) return { kind: 'exit', label: 'EXIT', why: `Below its 200-day average (${rs(m.sma200)}): the long-term uptrend is broken.${loss}`, stop: null };
    if (m.sma50 && p < m.sma50) return { kind: 'tighten', label: 'TIGHTEN', why: `Below its 50-day average (${rs(m.sma50)}): weak, keep a close stop.${loss}`, stop: stop };
    return { kind: 'hold', label: 'HOLD', why: (m.trendTemplate ? 'Strong uptrend.' : 'Uptrend intact.') + loss, stop };
  }

  let MET = null, SW = null;
  const signal = sym => (SW && SW.signals ? SW.signals.find(x => x.sym === sym) : null) || null; // today's scan row for a stock, if it is a buy
  async function preload() { if (!MET && root.Kundli && Kundli.todayMetrics) MET = await Kundli.todayMetrics(); return MET; }
  const actionFor = (sym, ltp, avg) => holdAction(MET && MET.map[sym], ltp, avg);

  const row = (tag, cls, sym, text, right, sub) => `<li class="plan-row" data-plan-sym="${esc(sym)}"><span class="plan-tag ${cls}">${tag}</span><div class="plan-main"><b>${esc(sym)}</b><small>${text}</small></div><div class="q-num"><b>${right || ''}</b><small>${sub || ''}</small></div></li>`;

  async function render(ctx) {
    const el = document.querySelector('#home-plan .home-card-body'); if (!el) return;
    const S = settings(), holdings = (ctx && ctx.holdings) || [];
    const pill = document.getElementById('src-pill');
    if (pill && ctx) { pill.hidden = false; pill.className = 'mkt-pill src ' + (ctx.live ? 'open' : ''); pill.innerHTML = `<i></i>${ctx.live ? 'Live prices · ICICI' : 'Delayed prices · Yahoo'}`; }
    const [sw, met] = await Promise.all([j('api/swing.php?action=latest').catch(() => null), preload().catch(() => null)]);
    SW = sw;
    const held = new Set(holdings.map(h => h.sym));
    const acts = holdings.map(h => ({ ...h, a: holdAction(met && met.map[h.sym], h.ltp, h.avg) }));
    const exits = acts.filter(x => x.a.kind === 'exit'), tight = acts.filter(x => x.a.kind === 'tighten'), ok = acts.filter(x => x.a.kind === 'hold');
    const up = sw && sw.market && sw.market.up, buys = [], perInd = {};
    for (const h of holdings) { const m = met && met.map[h.sym]; if (m && m.ind) perInd[m.ind] = (perInd[m.ind] || 0) + 1; }
    if (up) for (const x of sw.signals || []) {
      if (buys.length >= S.maxPos) break;
      if (held.has(x.sym) || (perInd[x.ind] || 0) >= S.perSector) continue;
      const z = size(x.close, x.stop, S); if (!z || !z.qty) continue;
      perInd[x.ind] = (perInd[x.ind] || 0) + 1; buys.push({ ...x, z });
    }
    const near = up && sw.near ? sw.near.filter(x => !held.has(x.sym)).slice(0, 3) : [];
    const rows = [
      ...exits.map(x => row('EXIT', 'red', x.sym, esc(x.a.why), `${x.qty} sh`, rs(x.ltp, 2))),
      ...tight.map(x => row('TIGHTEN', 'amber', x.sym, esc(x.a.why), x.a.stop ? 'stop ' + rs(x.a.stop, 2) : '', `${x.qty} sh`)),
      ...buys.map(x => row('BUY', 'green', x.sym, `${esc(x.ind || '')} · above ${rs(x.close, 2)} · stop ${rs(x.stop, 2)} (${x.riskPct}%)`, `${x.z.qty} sh`, `${rs(x.z.value)} · risk ${rs(x.z.risk)}`)),
      ...near.map(x => row('WATCH', 'grey', x.sym, `Breaks out above ${rs(x.trigger, 2)} (${x.gap}% away)`, rs(x.close, 2), '')),
    ];
    const mkt = !sw || !sw.market ? '' : up ? `<span class="up">Uptrend</span>` : `<span class="down">Downtrend: no new buys</span>`;
    // strategy health: the last 20 closed paper trades of the scan
    const rc = (sw && sw.recentClosed) || [], l20 = rc.slice(0, 20), hAvg = l20.length ? l20.reduce((a, t) => a + t.r, 0) / l20.length : null;
    const health = !sw || !sw.date ? '' : l20.length < 20 ? `<p class="plan-health"><i class="dot grey"></i><b>Strategy health: too early.</b> Only ${l20.length} paper trades closed so far; 20 are needed to judge.</p>`
      : `<p class="plan-health"><i class="dot ${hAvg > 0 ? 'green' : 'red'}"></i><b>Strategy health: ${hAvg > 0.1 ? 'working' : hAvg > 0 ? 'barely working' : 'not working lately'}.</b> The last 20 paper trades averaged ${hAvg > 0 ? '+' : ''}${hAvg.toFixed(2)}R${hAvg <= 0 ? '. Breakouts are failing in this market: consider half size until this turns up' : ''}.</p>`;
    doctor(holdings, met);
    el.innerHTML = `
      <div class="plan-stats"><div><span>Capital</span><b>${rs(S.capital)}</b></div><div><span>Risk a trade</span><b>${rs(S.capital * S.riskPct / 100)}</b><small>${S.riskPct}%</small></div>
        <div><span>Market</span><b>${mkt || '—'}</b></div><div><span>Holdings</span><b>${holdings.length ? `${ok.length} fine · ${tight.length + exits.length} need a look` : ctx && ctx.connected ? 'none' : 'not connected'}</b></div></div>
      ${rows.length ? `<ul class="q-list plan-list">${rows.join('')}</ul>` : `<p class="plan-none"><b>No action needed today.</b> ${sw && sw.date ? (up ? 'No breakout in the last scan and your holdings are fine.' : 'The market is below its 200-day average, so the plan is to wait.') : 'The evening scan has not run yet.'} Doing nothing is a valid plan.</p>`}
      ${health}
      <div id="plan-form" hidden></div>
      <p class="citation">${sw && sw.date ? `Scan of ${esc(sw.date)}. ` : ''}Buys: trend-template breakouts, at most ${S.maxPos} at a time and ${S.perSector} per sector; size = the smaller of ${S.riskPct}% risk to the stop and ${rs(S.capital / S.maxPos)} a stock. Holdings: exit below the 200-day average, tighten below the 50-day. Rules, not advice; you place every order.</p>`;
    el.querySelectorAll('[data-plan-sym]').forEach(li => (li.onclick = () => root.Stock && Stock.open(li.dataset.planSym)));
    const btn = document.querySelector('[data-plan-set]');
    if (btn) btn.onclick = () => {
      const f = el.querySelector('#plan-form'); if (!f.hidden) { f.hidden = true; return; }
      f.hidden = false;
      f.innerHTML = `<form class="plan-form"><label>Capital for swing trades ₹<input name="capital" type="number" min="1000" step="1000" value="${S.capital}"></label>
        <label>Risk a trade %<input name="riskPct" type="number" min="0.1" max="5" step="0.1" value="${S.riskPct}"></label>
        <label>Most trades open<input name="maxPos" type="number" min="1" max="20" value="${S.maxPos}"></label>
        <label>Most per sector<input name="perSector" type="number" min="1" max="10" value="${S.perSector}"></label>
        <button class="btn-primary btn-small" type="submit">Save</button></form>`;
      f.querySelector('form').onsubmit = e => { e.preventDefault(); const d = new FormData(e.target), n = {}; for (const k of Object.keys(DEF)) { const v = parseFloat(d.get(k)); n[k] = v > 0 ? v : DEF[k]; } save(n); render(ctx); };
    };
  }

  // ---------- portfolio doctor: concentration, weak holdings and a NIFTY -10% stress test ----------
  function doctor(holdings, met) {
    const el = document.querySelector('#home-doctor .home-card-body'); if (!el) return;
    if (!holdings.length) { el.innerHTML = '<p class="home-empty">Shows once a broker account is connected today.</p>'; return; }
    const rowsH = holdings.map(h => ({ ...h, val: (h.ltp || 0) * h.qty, m: met && met.map[h.sym] })).filter(h => h.val > 0), total = rowsH.reduce((a, h) => a + h.val, 0);
    if (!total) { el.innerHTML = '<p class="home-empty">No prices for your holdings yet.</p>'; return; }
    const big = [...rowsH].sort((a, b) => b.val - a.val)[0], sec = {};
    rowsH.forEach(h => { const k = (h.m && h.m.ind) || 'Other / not in scan'; sec[k] = (sec[k] || 0) + h.val; });
    const [topSec, topVal] = Object.entries(sec).sort((a, b) => b[1] - a[1])[0];
    const weak = rowsH.filter(h => h.m && h.m.sma200 && h.ltp < h.m.sma200), noData = rowsH.filter(h => !h.m);
    const drop = rowsH.reduce((a, h) => a + h.val * 0.10 * (h.m && h.m.beta != null ? h.m.beta : 1), 0), haveBeta = rowsH.some(h => h.m && h.m.beta != null);
    const hits = rowsH.filter(h => { const st = h.m && (h.m.lo10 < h.ltp ? h.m.lo10 : h.m.sma200); return st && h.ltp * (1 - 0.10 * (h.m.beta != null ? h.m.beta : 1)) < st; });
    const pc = v => Math.round(v / total * 100);
    const line = (ok, t, d) => `<li class="doc-row"><span class="doc-ic ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '!'}</span><div><b>${t}</b><small>${d}</small></div></li>`;
    const items = [
      line(pc(big.val) <= 25, `Biggest holding: ${esc(big.sym)} ${pc(big.val)}%`, pc(big.val) <= 25 ? 'No single stock dominates.' : 'More than a quarter of your money is in one stock.'),
      line(pc(topVal) <= 40, `Biggest sector: ${esc(topSec)} ${pc(topVal)}%`, pc(topVal) <= 40 ? 'Sector spread is reasonable.' : 'Over 40% in one sector: one bad sector result hurts everything.'),
      line(!weak.length, weak.length ? `${weak.length} holding${weak.length > 1 ? 's' : ''} below the 200-day average` : 'No holding below its 200-day average', weak.length ? esc(weak.map(h => h.sym).join(', ')) + ': long-term trend broken.' : 'Every tracked holding is in a long-term uptrend.'),
      line(drop / total < 0.12, `If NIFTY falls 10%: about −${rs(drop)} (${(drop / total * 100).toFixed(1)}%)`, `${haveBeta ? 'Uses each stock\'s one-year sensitivity to NIFTY (beta)' : 'Assumes every stock falls with NIFTY (betas arrive with the next evening scan)'}.${hits.length ? ` ${hits.length} would break their stop: ${esc(hits.map(h => h.sym).join(', '))}.` : ''}`),
    ];
    const lossH = rowsH.filter(h => h.avg && h.ltp < h.avg), lossSum = lossH.reduce((a, h) => a + (h.avg - h.ltp) * h.qty, 0), expo = rowsH.reduce((a, h) => a + h.val * (h.m && h.m.beta != null ? h.m.beta : 1), 0);
    const info = (t, d) => `<li class="doc-row"><span class="doc-ic info">i</span><div><b>${t}</b><small>${d}</small></div></li>`;
    if (lossH.length) items.push(info(`Unrealised losses: ${rs(lossSum)} in ${lossH.length} holding${lossH.length > 1 ? 's' : ''}`, `${esc(lossH.map(h => h.sym).slice(0, 5).join(', '))}. A loss booked before 31 March can be set off against capital gains of the year (a long-term loss only against long-term gains). Check holding periods in your own records.`));
    items.push(info(`Hedge size: your shares move like ${rs(expo)} of NIFTY`, 'That is the amount a NIFTY put or short future would need to cover for a full hedge. See the cost on the F&amp;O page; a hedge costs money every month.'));
    const bad = items.filter(x => x.includes('doc-ic bad')).length;
    el.innerHTML = `<p class="doc-grade ${bad ? (bad > 1 ? 'red' : 'amber') : 'green'}">${bad ? `${bad} thing${bad > 1 ? 's' : ''} to look at` : 'Healthy'} <small>· ${rowsH.length} holdings worth ${rs(total)}</small></p>
      <ul class="doc-list">${items.join('')}</ul>
      <p class="citation">${noData.length ? `${noData.length} holding${noData.length > 1 ? 's are' : ' is'} outside the NIFTY 500 scan (${esc(noData.map(h => h.sym).slice(0, 4).join(', '))}) and only counted for size. ` : ''}A rough estimate, not a forecast.</p>`;
  }

  // ---------- goal planner: monthly SIP needed to reach a target ----------
  function planner(el) {
    if (!el) return;
    let g = { target: 10000000, years: 10, have: 0, ret: 12 }; try { g = { ...g, ...(JSON.parse(localStorage.getItem('marketmind_goalplan')) || {}) }; } catch { /* default */ }
    const calc = () => { const n = g.years * 12, i = g.ret / 100 / 12, grown = g.have * Math.pow(1 + i, n), need = Math.max(0, g.target - grown), sip = i ? need * i / (Math.pow(1 + i, n) - 1) : need / n; return { grown, sip, low: (() => { const j2 = (g.ret - 3) / 100 / 12, gr = g.have * Math.pow(1 + j2, n); return j2 ? Math.max(0, g.target - gr) * j2 / (Math.pow(1 + j2, n) - 1) : 0; })() }; };
    const draw = () => { const c = calc();
      el.innerHTML = `<section class="home-card" style="margin-top:16px"><div class="home-card-head"><h3>Goal planner</h3></div><div class="home-card-body">
        <form class="plan-form"><label>Target ₹<input name="target" type="number" min="10000" step="10000" value="${g.target}"></label><label>Years<input name="years" type="number" min="1" max="40" value="${g.years}"></label>
        <label>Already invested ₹<input name="have" type="number" min="0" step="10000" value="${g.have}"></label><label>Expected return % a year<input name="ret" type="number" min="1" max="25" step="0.5" value="${g.ret}"></label><button class="btn-primary btn-small" type="submit">Work out</button></form>
        <div class="plan-stats"><div><span>Monthly SIP needed</span><b>${rs(c.sip)}</b></div><div><span>If returns are ${g.ret - 3}%</span><b>${rs(c.low)}</b></div><div><span>Today's money grows to</span><b>${rs(c.grown)}</b></div><div><span>Target</span><b>${rs(g.target)}</b></div></div>
        <p class="citation">Simple compounding at a steady yearly return; real returns vary every year and inflation is not included. The second figure shows the SIP needed if returns come in 3 points lower.</p></div></section>`;
      el.querySelector('form').onsubmit = e => { e.preventDefault(); const d = new FormData(e.target); for (const k of Object.keys(g)) { const v = parseFloat(d.get(k)); if (v >= 0) g[k] = v; } if (!(g.years > 0)) g.years = 10; if (!(g.ret > 0)) g.ret = 12; try { localStorage.setItem('marketmind_goalplan', JSON.stringify(g)); } catch { /* ignore */ } draw(); }; };
    draw();
  }

  root.Plan = { planner, signal, render, settings, size, holdAction, actionFor, preload };
})(typeof window !== 'undefined' ? window : globalThis);

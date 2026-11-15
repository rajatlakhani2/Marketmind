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

  let MET = null;
  async function preload() { if (!MET && root.Kundli && Kundli.todayMetrics) MET = await Kundli.todayMetrics(); return MET; }
  const actionFor = (sym, ltp, avg) => holdAction(MET && MET.map[sym], ltp, avg);

  const row = (tag, cls, sym, text, right, sub) => `<li class="plan-row" data-plan-sym="${esc(sym)}"><span class="plan-tag ${cls}">${tag}</span><div class="plan-main"><b>${esc(sym)}</b><small>${text}</small></div><div class="q-num"><b>${right || ''}</b><small>${sub || ''}</small></div></li>`;

  async function render(ctx) {
    const el = document.querySelector('#home-plan .home-card-body'); if (!el) return;
    const S = settings(), holdings = (ctx && ctx.holdings) || [];
    const pill = document.getElementById('src-pill');
    if (pill && ctx) { pill.hidden = false; pill.className = 'mkt-pill src ' + (ctx.live ? 'open' : ''); pill.innerHTML = `<i></i>${ctx.live ? 'Live prices · ICICI' : 'Delayed prices · Yahoo'}`; }
    const [sw, met] = await Promise.all([j('api/swing.php?action=latest').catch(() => null), preload().catch(() => null)]);
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
    el.innerHTML = `
      <div class="plan-stats"><div><span>Capital</span><b>${rs(S.capital)}</b></div><div><span>Risk a trade</span><b>${rs(S.capital * S.riskPct / 100)}</b><small>${S.riskPct}%</small></div>
        <div><span>Market</span><b>${mkt || '—'}</b></div><div><span>Holdings</span><b>${holdings.length ? `${ok.length} fine · ${tight.length + exits.length} need a look` : ctx && ctx.connected ? 'none' : 'not connected'}</b></div></div>
      ${rows.length ? `<ul class="q-list plan-list">${rows.join('')}</ul>` : `<p class="plan-none"><b>No action needed today.</b> ${sw && sw.date ? (up ? 'No breakout in the last scan and your holdings are fine.' : 'The market is below its 200-day average, so the plan is to wait.') : 'The evening scan has not run yet.'} Doing nothing is a valid plan.</p>`}
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

  root.Plan = { render, settings, size, holdAction, actionFor, preload };
})(typeof window !== 'undefined' ? window : globalThis);

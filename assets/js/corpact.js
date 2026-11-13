// MarketMind AI — Markets → Corporate actions (dividend, bonus, split, rights, buyback) and Markets → Results.
// Data: NSE corporate-actions and board-meeting feeds, NSE quarterly results, Yahoo prices (~15 min delayed),
// Google News. Calls are MarketMind's own reading of past behaviour + the stock's current chart; not advice.
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const rs = (v, d = 2) => (v == null || !isFinite(v) ? '—' : '₹' + num(v, d));
  const pct = (v, d = 1) => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
  const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const fmtDate = d => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const daysTo = d => Math.round((Date.parse(d + 'T00:00:00+05:30') - Date.now()) / 864e5);
  const crore = v => (v == null ? '—' : v >= 1e5 ? `₹${num(v / 100, 0)} Cr` : `₹${num(v / 100, 1)} Cr`);   // API gives ₹ lakh

  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }

  // ---------- shared: news and the chart call ----------
  const POS = /\b(surge|surges|soar|rally|jump|jumps|gain|gains|rise|rises|record|upgrade|outperform|beats|strong|robust|growth|boost|order|wins|expansion|bullish|rebound|approval)\b/i;
  const NEG = /\b(fall|falls|slump|plunge|crash|tumble|drop|drops|decline|slide|downgrade|underperform|misses|weak|loss|losses|concern|pressure|selloff|bearish|probe|penalty|ban|slowdown|default|fraud|raid|resigns|warning|errors?)\b/i;
  async function newsHtml(sym) {
    try {
      const j = await getJSON(`api/events.php?action=news&symbol=${encodeURIComponent(sym)}`);
      const items = (j.items || []).slice(0, 6);
      if (!items.length) return '<p class="muted small">No news in the last 14 days.</p>';
      return `<ul class="ov-news">${items.map(n => { const p = POS.test(n.title), q = NEG.test(n.title), s = p && !q ? 1 : q && !p ? -1 : 0;
        return `<li><span class="${s > 0 ? 'up' : s < 0 ? 'down' : 'muted'}">${s > 0 ? '▲' : s < 0 ? '▼' : '•'}</span> <a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a> <small class="muted">${esc(n.source || '')}</small></li>`; }).join('')}</ul>`;
    } catch (e) { return `<p class="muted small">News not available: ${esc(e.message)}</p>`; }
  }
  async function chartCall(sym) {
    try {
      const res = await root.app.analysis.analyzeStock(sym, '__all', '1d', null, {});
      const c = res.consensus && res.consensus.conclusion;
      if (!c) return null;
      return { verdict: c.verdict, tone: c.tone, backing: c.backing, supporting: c.supporting || [], price: res.marketData.price };
    } catch { return null; }
  }
  const chartLine = c => !c ? '' : `<p class="small"><b>Chart call today:</b> <span class="wl-call ${c.tone === 'long' ? 'buy' : c.tone === 'short' ? 'sell' : 'wait'}">${esc(c.verdict.toUpperCase())}</span>${c.tone === 'long' && c.backing ? ` <span class="tier ${c.backing === 'proven' ? 'tier-proven' : 'tier-watch'}">${c.backing === 'proven' ? 'Proven' : 'Watch'}</span>` : ''} ${c.supporting.length ? `<span class="muted">${esc(c.supporting.join(', '))}</span>` : ''}</p>`;

  // =====================================================================================
  // Corporate actions
  // =====================================================================================
  const KINDS = [['Dividend', 'Dividend'], ['Bonus', 'Bonus'], ['Split', 'Split'], ['Rights', 'Rights'], ['Buyback', 'Buyback'], ['all', 'All']];
  const CA = { kind: 'Dividend', data: null, open: null, q: '', detail: {} };

  // MarketMind's call for one action, from past behaviour around ex-dates and today's chart
  function actionCall(a, d, chart) {
    const st = d && d.stats ? d.stats[a.kind] : null;
    const days = daysTo(a.exDate);
    const why = [];
    let call = 'NEUTRAL', tone = 'wait';
    const chartBad = chart && (chart.tone === 'short' || /sell|avoid/i.test(chart.verdict));
    if (a.kind === 'Dividend') {
      if (a.yield != null) why.push(`The dividend is ${a.yield.toFixed(2)}% of today's price. On the ex-date the price usually drops by about that much, so the dividend alone is not a profit.`);
      if (st && st.n >= 3) {
        why.push(`Past ${st.n} dividends: buying 5 trading days before the ex-date and selling 5 days after (dividend included) averaged ${pct(st.avg)}, positive ${st.pos} of ${st.n} times.`);
        if (st.avg >= 0.5 && st.pos / st.n >= 0.6 && !chartBad) { call = days >= 2 ? 'BUY BEFORE EX-DATE' : 'TOO LATE: HOLD'; tone = days >= 2 ? 'buy' : 'wait'; }
        else if (st.avg < 0 || st.pos / st.n < 0.5) { call = 'AVOID FOR DIVIDEND'; tone = 'sell'; why.push('The price has usually fallen by more than the dividend.'); }
      } else why.push('Too few past dividends to judge how the share behaves around the ex-date.');
      if (a.recordDate) why.push(`You must own the share before the ex-date (${fmtDate(a.exDate)}) to get it; record date ${fmtDate(a.recordDate)}.`);
      why.push('Dividends are added to your income and taxed at your slab rate.');
    } else if (a.kind === 'Bonus' || a.kind === 'Split') {
      why.push(`${a.kind === 'Bonus' ? 'A bonus' : 'A split'} only changes the number of shares; the value of your holding stays the same.`);
      if (st && st.n >= 2) why.push(`Past ${a.kind.toLowerCase()}s: 5 days before to 5 days after the ex-date averaged ${pct(st.avg)} (positive ${st.pos} of ${st.n}).`);
      call = 'NO VALUE CHANGE';
    } else if (a.kind === 'Buyback') {
      const m = /(?:rs|re)\.?\s*([\d.]+)/i.exec(a.subject || '');
      if (m && a.price) { const prem = (m[1] / a.price - 1) * 100; why.push(`Buyback price about ₹${m[1]}, ${pct(prem)} vs today's price. Only part of the shares you tender are usually accepted.`); if (prem > 8 && !chartBad) { call = 'CONSIDER TENDERING'; tone = 'buy'; } }
    } else if (a.kind === 'Rights') {
      why.push('A rights issue lets existing holders buy new shares, usually below the market price. Check the issue price against the price on the ex-date before applying.');
    }
    if (chart) why.push(chartBad ? 'The chart call today is negative, so MarketMind does not suggest buying now.' : chart.tone === 'long' ? 'The chart call today is positive.' : 'The chart gives no clear direction today.');
    return { call, tone, why };
  }

  async function renderActions(container) {
    container.innerHTML = '<div class="skeleton"></div><div class="skeleton short"></div>';
    try { CA.data = await getJSON('api/events.php?action=actions_board'); }
    catch (e) { container.innerHTML = `<div class="data-warning">Corporate actions not available: ${esc(e.message)}</div>`; return; }
    drawActions(container);
  }

  function drawActions(container) {
    const all = CA.data.actions || [];
    const q = CA.q.trim().toUpperCase();
    const list = all.filter(a => (CA.kind === 'all' || a.kind === CA.kind) && (!q || a.symbol.includes(q) || (a.company || '').toUpperCase().includes(q)));
    const count = k => all.filter(a => k === 'all' || a.kind === k).length;
    container.innerHTML = `
      <div class="seg tr-tabs">${KINDS.map(([k, l]) => `<button type="button" data-k="${k}" class="${CA.kind === k ? 'active' : ''}">${l} (${count(k)})</button>`).join('')}</div>
      <div class="ov-ctrl"><input type="search" id="ca-q" placeholder="Filter by company" value="${esc(CA.q)}" autocomplete="off"/></div>
      <p class="muted small">${list.length} upcoming · prices from Yahoo, about 15 min delayed · tap a company for its history, MarketMind's call and news.</p>
      ${list.length ? `<div class="tbl-wrap"><table class="ov-table ca-table"><thead><tr><th>Company</th><th>Ex-date</th><th>${CA.kind === 'Dividend' ? 'Dividend' : 'Details'}</th><th>Price</th>${CA.kind === 'Dividend' || CA.kind === 'all' ? '<th>Yield</th>' : ''}</tr></thead><tbody>
        ${list.map((a, i) => { const id = a.symbol + '|' + a.exDate + '|' + i; const d = daysTo(a.exDate);
          return `<tr data-ca="${esc(id)}" class="${CA.open === id ? 'sel' : ''}"><td><b>${esc(a.symbol)}</b><br><small class="muted">${esc((a.company || '').slice(0, 34))}</small></td>
          <td>${fmtDate(a.exDate)}<br><small class="muted">${d <= 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`}</small></td>
          <td>${esc(a.label || a.subject)}${CA.kind === 'all' ? `<br><small class="muted">${esc(a.kind)}</small>` : ''}</td>
          <td>${rs(a.price)}<br><small class="${cls(a.chg)}">${pct(a.chg, 2)}</small></td>
          ${CA.kind === 'Dividend' || CA.kind === 'all' ? `<td>${a.yield != null ? a.yield.toFixed(2) + '%' : '—'}</td>` : ''}</tr>
          ${CA.open === id ? `<tr class="ov-detail"><td colspan="5"><div id="ca-detail">${CA.detail[id] || '<div class="skeleton"></div>'}</div></td></tr>` : ''}`; }).join('')}
      </tbody></table></div>` : '<p class="home-empty">No upcoming actions of this kind.</p>'}
      <p class="citation">Source: NSE corporate actions. A call is MarketMind's reading of how the share behaved around past ex-dates plus today's chart. Not investment advice.</p>`;
    container.querySelectorAll('[data-k]').forEach(b => { b.onclick = () => { CA.kind = b.dataset.k; CA.open = null; drawActions(container); }; });
    const qi = container.querySelector('#ca-q'); if (qi) qi.oninput = () => { CA.q = qi.value; const pos = qi.selectionStart; drawActions(container); const n = container.querySelector('#ca-q'); n.focus(); n.setSelectionRange(pos, pos); };
    container.querySelectorAll('tr[data-ca]').forEach(tr => {
      tr.onclick = () => { const id = tr.dataset.ca; CA.open = CA.open === id ? null : id; drawActions(container); if (CA.open && !CA.detail[id]) loadActionDetail(container, id, list[+id.split('|')[2]]); };
    });
  }

  async function loadActionDetail(container, id, a) {
    let d = null, err = null;
    const [detail, chart, news] = await Promise.all([getJSON(`api/events.php?action=action_detail&symbol=${encodeURIComponent(a.symbol)}`).catch(e => { err = e.message; return null; }), chartCall(a.symbol), newsHtml(a.symbol)]);
    d = detail;
    const c = actionCall(a, d, chart);
    const hist = d ? d.history.filter(h => h.exDate < new Date().toISOString().slice(0, 10)).slice(0, 15) : [];
    const fy = d ? Object.entries(d.dividendsByFy || {}).slice(0, 8) : [];
    CA.detail[id] = `<div class="ov-why">
      <p><span class="wl-call ${c.tone}">${esc(c.call)}</span> <b>${esc(a.symbol)}</b> · ${esc(a.label || a.subject)} · ex-date ${fmtDate(a.exDate)}</p>
      <ul>${c.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
      ${chartLine(chart)}
      <p class="small"><button type="button" class="link-btn" data-open-stock="${esc(a.symbol)}">Open ${esc(a.symbol)} stock page ›</button></p>
      ${fy.length ? `<p class="small"><b>Dividend per share by financial year:</b> ${fy.map(([y, v]) => `FY ${esc(y)}: ₹${num(v)}`).join(' · ')}</p>` : ''}
      ${hist.length ? `<p class="small"><b>Past actions</b> (move = 5 days before to 5 days after the ex-date${a.kind === 'Dividend' ? ', dividend included' : ''})</p>
        <div class="tbl-wrap"><table class="ov-table"><thead><tr><th>Ex-date</th><th>Action</th><th>Move</th></tr></thead><tbody>
        ${hist.map(h => `<tr><td>${fmtDate(h.exDate)}</td><td>${esc(h.label || h.subject)}<br><small class="muted">${esc(h.kind)}</small></td><td class="${cls(h.move5)}">${pct(h.move5)}</td></tr>`).join('')}</tbody></table></div>`
        : `<p class="muted small">${err ? 'History not available: ' + esc(err) : 'No past actions found in the last 10 years.'}</p>`}
      <p class="small"><b>News</b></p>${news}
    </div>`;
    const box = container.querySelector('#ca-detail');
    if (box && CA.open === id) { box.innerHTML = CA.detail[id]; wireStockLinks(box); }
  }

  function wireStockLinks(el) { el.querySelectorAll('[data-open-stock]').forEach(b => { b.onclick = e => { e.stopPropagation(); root.Stock && Stock.open(b.dataset.openStock); }; }); }

  // =====================================================================================
  // Results
  // =====================================================================================
  const RS = { data: null, open: null, detail: {}, q: '' };

  function resultCall(d, chart) {
    const why = [];
    let call = 'WAIT FOR THE RESULT', tone = 'wait';
    const qs = d && d.quarters || [];
    const recent = qs.slice(0, 4).filter(q => q.vs_est_profit != null);
    const beats = recent.filter(q => q.vs_est_profit > 0).length;
    if (d && d.moveStats && d.moveStats.n >= 3) why.push(`On past result days the share moved about ±${d.moveStats.absAvg.toFixed(1)}% the next day (up ${d.moveStats.pos} of ${d.moveStats.n} times). Expect a move of that size.`);
    if (recent.length >= 3) why.push(`Profit beat MarketMind's estimate in ${beats} of the last ${recent.length} quarters.`);
    if (d && d.next && d.next.est_profit != null) why.push(`MarketMind estimates next-quarter profit at about ${crore(d.next.est_profit)} and revenue at ${crore(d.next.est_revenue)} (from the company's own growth trend; not analyst consensus).`);
    if (chart && chart.tone === 'long' && chart.backing === 'proven' && beats >= 3) { call = 'BUY BEFORE RESULT (SMALL SIZE)'; tone = 'buy'; why.push('A Proven chart signal and a record of beating estimates. Keep the size small: a result surprise can move the price past your stop.'); }
    else if (chart && (chart.tone === 'short' || /sell|avoid/i.test(chart.verdict))) { call = 'AVOID BEFORE RESULT'; tone = 'sell'; why.push('The chart call today is negative.'); }
    else why.push('No strong edge before the announcement: wait for the numbers and the market\'s first reaction.');
    return { call, tone, why };
  }

  async function renderResults(container) {
    container.innerHTML = '<div class="skeleton"></div><div class="skeleton short"></div>';
    try { RS.data = await getJSON('api/events.php?action=results_board'); }
    catch (e) { RS.data = { meetings: [], error: e.message }; }
    drawResults(container);
  }

  function drawResults(container) {
    const all = RS.data.meetings || [];
    const q = RS.q.trim().toUpperCase();
    const list = all.filter(m => !q || m.symbol.includes(q) || (m.company || '').toUpperCase().includes(q));
    container.innerHTML = `
      <div class="ov-ctrl"><input type="search" id="rs-q" placeholder="Filter, or type any symbol and press Enter" value="${esc(RS.q)}" autocomplete="off"/></div>
      ${RS.data.error ? `<div class="data-warning">Results calendar not available: ${esc(RS.data.error)}</div>` : ''}
      <p class="muted small">${list.length} upcoming results · prices about 15 min delayed · tap a company for its last quarters, MarketMind's estimate vs actual and how the share reacts.</p>
      ${q && !list.some(m => m.symbol === q) ? `<p><button type="button" class="link-btn" data-rs-any="${esc(q)}">Show results for ${esc(q)} ›</button></p>${RS.open === 'any|' + q ? `<div id="rs-detail">${RS.detail['any|' + q] || '<div class="skeleton"></div>'}</div>` : ''}` : ''}
      ${list.length ? `<div class="tbl-wrap"><table class="ov-table"><thead><tr><th>Company</th><th>Result date</th><th>Price</th></tr></thead><tbody>
        ${list.map((m, i) => { const id = m.symbol + '|' + m.date + '|' + i; const d = daysTo(m.date);
          return `<tr data-rs="${esc(id)}" class="${RS.open === id ? 'sel' : ''}"><td><b>${esc(m.symbol)}</b><br><small class="muted">${esc((m.company || '').slice(0, 34))}</small></td>
          <td>${fmtDate(m.date)}<br><small class="muted">${d <= 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`}</small></td>
          <td>${rs(m.price)}<br><small class="${cls(m.chg)}">${pct(m.chg, 2)}</small></td></tr>
          ${RS.open === id ? `<tr class="ov-detail"><td colspan="3"><div id="rs-detail">${RS.detail[id] || '<div class="skeleton"></div>'}</div></td></tr>` : ''}`; }).join('')}
      </tbody></table></div>` : ''}
      <p class="citation">Results: Yahoo Finance quarterly figures (consolidated; NSE when Yahoo has none), ₹ crore. "Estimate" is MarketMind's own: the same quarter last year grown by the company's recent year-on-year growth. It is not an analyst consensus. Not investment advice.</p>`;
    const qi = container.querySelector('#rs-q');
    if (qi) {
      qi.oninput = () => { RS.q = qi.value; const pos = qi.selectionStart; drawResults(container); const n = container.querySelector('#rs-q'); n.focus(); n.setSelectionRange(pos, pos); };
      qi.onkeydown = e => { if (e.key === 'Enter' && qi.value.trim()) openAny(container, qi.value.trim().toUpperCase()); };
    }
    container.querySelectorAll('[data-rs-any]').forEach(b => { b.onclick = () => openAny(container, b.dataset.rsAny); });
    container.querySelectorAll('tr[data-rs]').forEach(tr => {
      tr.onclick = () => { const id = tr.dataset.rs; RS.open = RS.open === id ? null : id; drawResults(container); if (RS.open && !RS.detail[id]) loadResult(container, id, id.split('|')[0]); };
    });
  }
  function openAny(container, sym) { const id = 'any|' + sym; RS.open = id; drawResults(container); if (!RS.detail[id]) loadResult(container, id, sym); }

  async function loadResult(container, id, sym) {
    let err = null;
    const [d, chart, news] = await Promise.all([getJSON(`api/events.php?action=results&symbol=${encodeURIComponent(sym)}`).catch(e => { err = e.message; return null; }), chartCall(sym), newsHtml(sym)]);
    const c = resultCall(d, chart);
    const qs = d ? d.quarters.slice(0, 8) : [];
    const qName = p => { const t = new Date(p + 'T00:00:00'); const m = t.getMonth() + 1, y = t.getFullYear(); const fq = m >= 4 && m <= 6 ? 1 : m <= 9 && m >= 7 ? 2 : m >= 10 ? 3 : 4; const fy = m >= 4 ? y : y - 1; return `Q${fq} FY${String(fy + 1).slice(2)}`; };
    const vs = v => v == null ? '<span class="muted">—</span>' : `<span class="${cls(v)}">${v > 0 ? 'beat' : 'missed'} ${Math.abs(v).toFixed(1)}%</span>`;
    const latest = qs[0];
    RS.detail[id] = `<div class="ov-why">
      <p><span class="wl-call ${c.tone}">${esc(c.call)}</span> <b>${esc(sym)}</b>${chart && chart.price ? ` · ${rs(chart.price)}` : ''}</p>
      <ul>${c.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
      ${chartLine(chart)}
      ${latest ? `<div class="tr-facts">
        <div><span>Latest quarter</span><b>${qName(latest.period)}</b></div>
        <div><span>Revenue</span><b>${crore(latest.revenue)}</b><small class="${cls(latest.yoy_revenue)}">${pct(latest.yoy_revenue)} YoY</small></div>
        <div><span>Profit</span><b>${crore(latest.profit)}</b><small class="${cls(latest.yoy_profit)}">${pct(latest.yoy_profit)} YoY</small></div>
        <div><span>vs MarketMind estimate</span><b>${vs(latest.vs_est_profit)}</b><small>profit</small></div>
      </div>` : ''}
      ${qs.length ? `<div class="tbl-wrap"><table class="ov-table"><thead><tr><th>Quarter</th><th>Revenue</th><th>Profit</th><th>EPS</th><th>Profit vs estimate</th></tr></thead><tbody>
        ${d.next && d.next.est_profit != null ? `<tr class="muted"><td>${qName(d.next.period)} <small>(next)</small></td><td>est. ${crore(d.next.est_revenue)}</td><td>est. ${crore(d.next.est_profit)}</td><td>—</td><td>—</td></tr>` : ''}
        ${qs.map(q => `<tr><td>${qName(q.period)}</td><td>${crore(q.revenue)}<br><small class="${cls(q.yoy_revenue)}">${pct(q.yoy_revenue)} YoY</small></td><td>${crore(q.profit)}<br><small class="${cls(q.yoy_profit)}">${pct(q.yoy_profit)} YoY</small></td><td>${q.eps != null ? num(q.eps) : '—'}</td><td>${vs(q.vs_est_profit)}<br><small class="muted">est. ${crore(q.est_profit)}</small></td></tr>`).join('')}
      </tbody></table></div>` : `<p class="muted small">${err ? 'Results not available: ' + esc(err) : 'No quarterly results found.'}</p>`}
      ${d && d.resultDays && d.resultDays.length ? `<p class="small"><b>Share move the day after past results:</b> ${d.resultDays.slice(0, 8).map(r => `${fmtDate(r.date)} <span class="${cls(r.move)}">${pct(r.move)}</span>`).join(' · ')}</p>` : ''}
      <p class="small"><button type="button" class="link-btn" data-open-stock="${esc(sym)}">Open ${esc(sym)} stock page ›</button></p>
      <p class="small"><b>News</b></p>${news}
    </div>`;
    const box = container.querySelector('#rs-detail');
    if (box && RS.open === id) { box.innerHTML = RS.detail[id]; wireStockLinks(box); }
  }

  root.CorpActions = { renderPage: renderActions, _call: actionCall };
  root.ResultsPage = { renderPage: renderResults, _call: resultCall };
})(window);

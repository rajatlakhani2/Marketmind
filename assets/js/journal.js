// MarketMind AI — Journal (admin): every trade with a note and mood tag, this month's scorecard in R vs the
// back-test, patterns in losses, tax summary for the financial year, and "what if I had held" for each exit.
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = v => (v == null || !isFinite(v) ? '—' : '₹' + Math.round(v).toLocaleString('en-IN'));
  const r2 = v => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
  const tone = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const TAGS = { '': '—', plan: 'Followed plan', calm: 'Calm', rushed: 'Rushed', fomo: 'Fear of missing out', revenge: 'Revenge' };
  const BACKTEST_R = 0.05; // Combined system, average R per trade over FY 2017-25 (research/README.md)
  async function j(url, body) {
    const o = { headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (body) Object.assign(o, { method: 'POST', body: JSON.stringify(body), headers: { ...o.headers, 'Content-Type': 'application/json', 'X-Requested-With': 'MarketMind' } });
    const r = await fetch(url, o); const x = await r.json().catch(() => null);
    if (!r.ok || !x) throw new Error((x && x.error) || `HTTP ${r.status}`); return x;
  }
  const istDay = s => (s ? new Date(Date.parse(s.replace(' ', 'T') + 'Z') + 5.5 * 3600e3).toISOString().slice(0, 10) : '');
  function rOf(t) {
    const e = +t.fill_price || +t.limit_price, risk = t.stop != null ? Math.abs(e - +t.stop) * +t.qty : 0;
    return t.pnl != null && risk > 0 ? +t.pnl / risk : null;
  }
  function fyStart() { const d = new Date(Date.now() + 5.5 * 3600e3), y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${y}-04-01`; }
  const group = (list, key) => { const m = new Map(); list.forEach(t => { const k = key(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }); return [...m]; };
  const avgR = l => { const v = l.map(rOf).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  async function whatIf(btn, t) {
    btn.disabled = true; btn.textContent = '…';
    try {
      const x = await j(`api/chart.php?symbol=${encodeURIComponent(t.symbol + '.NS')}&interval=1d&range=1y`), r = x.chart.result[0];
      const days = r.timestamp.map(s => new Date(s * 1000 + 5.5 * 3600e3).toISOString().slice(0, 10)), cl = r.indicators.quote[0].close;
      const k = days.findIndex(d => d > istDay(t.closed_at));
      const after = k >= 0 ? cl.slice(k, k + 20).filter(v => v != null) : [];
      if (!after.length) { btn.textContent = 'too recent'; return; }
      const end = after[after.length - 1], ex = +t.exit_price, ch = (end / ex - 1) * 100;
      btn.outerHTML = `<span class="${tone(ch)}" title="Price ${after.length} trading days after the exit, vs the exit price">${ch > 0 ? '+' : ''}${ch.toFixed(1)}% after ${after.length}d${ch > 3 ? ' · sold early' : ch < -3 ? ' · good exit' : ''}</span>`;
    } catch (e) { btn.textContent = 'n/a'; btn.title = e.message; }
  }

  async function renderPage(el) {
    if (!el) return;
    if (!(root.Account && Account.isAdmin)) { el.innerHTML = '<p class="home-empty">The journal covers trades placed through MarketMind, which only the admin can do.</p>'; return; }
    el.innerHTML = '<p class="muted">Loading trades…</p>';
    let d; try { d = await j('api/trade.php?action=history'); } catch (e) { el.innerHTML = `<p class="home-empty">${esc(e.message)}</p>`; return; }
    const all = d.trades, closed = all.filter(t => t.status === 'closed' && t.pnl != null);
    const month = istDay(new Date().toISOString().replace('T', ' ').slice(0, 19)).slice(0, 7);
    const thisMonth = closed.filter(t => istDay(t.closed_at).startsWith(month));
    const wins = l => (l.length ? Math.round(l.filter(t => +t.pnl > 0).length / l.length * 100) : 0);
    // Patterns
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const pat = (title, rows) => `<h4>${title}</h4><table class="screener-table"><tbody>${rows.map(([k, l]) => `<tr><td>${esc(k)}</td><td>${l.length} trades</td><td>${wins(l)}% wins</td><td class="${tone(avgR(l))}">${r2(avgR(l))}</td></tr>`).join('')}</tbody></table>`;
    // Tax: trades closed this financial year (delivery: short-term if held under a year; intraday is speculative income)
    const fy = closed.filter(t => istDay(t.closed_at) >= fyStart());
    const kind = t => (t.product === 'mis' ? 'Intraday (speculative)' : ['option', 'future'].includes(t.product) ? 'F&O (business income)' : (Date.parse(t.closed_at) - Date.parse(t.filled_at || t.created_at)) / 864e5 >= 365 ? 'Long-term gains' : 'Short-term gains');
    const tax = group(fy, kind).map(([k, l]) => [k, l.reduce((a, t) => a + +t.pnl, 0), l.length]);
    el.innerHTML = `
      <div class="home-grid">
        <section class="home-card"><div class="home-card-head"><h3>This month's scorecard</h3></div><div class="home-card-body">
          <div class="money-total"><div><span>Closed trades</span><b>${thisMonth.length}</b></div><div><span>Wins</span><b>${wins(thisMonth)}%</b></div>
          <div><span>Average</span><b class="${tone(avgR(thisMonth))}">${r2(avgR(thisMonth))}</b></div></div>
          <p class="citation">Back-test expectation for the combined system: ${r2(BACKTEST_R)} a trade. ${thisMonth.length < 10 ? 'Fewer than 10 trades this month, so this is mostly luck either way.' : avgR(thisMonth) >= BACKTEST_R ? 'At or above expectation.' : 'Below expectation.'} All time: ${closed.length} trades, ${wins(closed)}% wins, ${r2(avgR(closed))}.</p></div></section>
        <section class="home-card"><div class="home-card-head"><h3>Patterns</h3></div><div class="home-card-body">
          ${closed.length ? pat('By mood', group(closed, t => TAGS[t.note_tag || ''] || '—')) + pat('By weekday', group(closed, t => DOW[new Date(istDay(t.filled_at || t.created_at) + 'T00:00:00').getDay()])) + pat('By product', group(closed, t => t.product)) : '<p class="home-empty">Patterns show after the first closed trades.</p>'}</div></section>
        <section class="home-card"><div class="home-card-head"><h3>Tax view · FY from ${new Date(fyStart() + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</h3></div><div class="home-card-body">
          ${tax.length ? `<table class="screener-table"><tbody>${tax.map(([k, v, n]) => `<tr><td>${esc(k)}</td><td>${n} trades</td><td class="${tone(v)}"><b>${rs(v)}</b></td></tr>`).join('')}</tbody></table>` : '<p class="home-empty">No trades closed this financial year.</p>'}
          <p class="citation">Only trades placed through MarketMind, before charges. Not tax advice; your broker's tax P&amp;L statement is the one to file with.</p></div></section>
      </div>
      <h3 style="margin:18px 0 8px">Trades</h3>
      ${all.length ? `<div class="fno-tablewrap"><table class="screener-table fno-table"><thead><tr><th>Closed</th><th>Stock</th><th>Entry → exit</th><th>P&amp;L</th><th>R</th><th>After exit</th><th>Mood</th><th>Note</th></tr></thead><tbody>
        ${all.map(t => `<tr data-id="${t.id}"><td>${esc(istDay(t.closed_at) || 'open')}</td><td><b data-sym="${esc(t.symbol)}">${esc(t.symbol)}</b><br><small class="muted">${esc(t.product)} · ${esc(t.mode)}</small></td>
          <td>${(+t.fill_price || +t.limit_price).toFixed(2)} → ${t.exit_price != null ? (+t.exit_price).toFixed(2) : '—'}</td><td class="${tone(+t.pnl)}">${t.pnl != null ? rs(+t.pnl) : '—'}</td><td class="${tone(rOf(t))}">${r2(rOf(t))}</td>
          <td>${t.status === 'closed' && t.exit_price != null ? '<button class="link-btn" data-whatif>check</button>' : '—'}</td>
          <td><select data-tag>${Object.entries(TAGS).map(([k, v]) => `<option value="${k}" ${k === (t.note_tag || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
          <td><textarea data-note rows="1" maxlength="2000" placeholder="Why I entered, what I learned">${esc(t.note || '')}</textarea></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="home-empty">No trades yet. Trades approved on the Orders page show here.</p>'}`;
    el.querySelectorAll('tr[data-id]').forEach(tr => {
      const t = all.find(x => String(x.id) === tr.dataset.id);
      const save = () => j('api/trade.php?action=note', { id: +t.id, note: tr.querySelector('[data-note]').value, tag: tr.querySelector('[data-tag]').value }).then(() => { tr.classList.add('flash-up'); }).catch(e => root.app && app.ui._toast(e.message, 'error'));
      tr.querySelector('[data-note]').onchange = save; tr.querySelector('[data-tag]').onchange = save;
      const w = tr.querySelector('[data-whatif]'); if (w) w.onclick = () => whatIf(w, t);
    });
  }
  root.Journal = { renderPage };
})(typeof window !== 'undefined' ? window : globalThis);

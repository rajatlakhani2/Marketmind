// MarketMind AI — Live buyers & sellers board.
// For your Watchlist (or the NIFTY heavyweights, or your own list): how many shares are waiting to be
// bought vs sold on NSE right now, the price, and delivery %. Tap a stock to open its Stock page.
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const qty = v => (v == null ? '—' : v >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : v >= 1e5 ? (v / 1e5).toFixed(1) + ' L' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v)));
  const IST = 5.5 * 3600e3;
  const marketOpen = () => { const d = new Date(Date.now() + IST), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && m >= 555 && m <= 930; };

  const HEAVY = ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'BHARTIARTL', 'ITC', 'SBIN', 'LT', 'KOTAKBANK', 'AXISBANK', 'HINDUNILVR', 'BAJFINANCE', 'MARUTI', 'SUNPHARMA', 'M&M', 'TITAN', 'NTPC', 'ULTRACEMCO', 'HCLTECH'];
  const S = { set: 'watch', rows: {}, prices: {}, at: null, busy: false, timer: null, sort: 'ratio', err: null };
  try { S.set = localStorage.getItem('mm-live-set') || 'watch'; } catch { /* default */ }

  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }
  async function symbols() {
    if (S.set === 'heavy') return HEAVY;
    try { return ((await getJSON('api/watchlist.php?action=list')).items || []).map(i => i.symbol); } catch { return []; }
  }

  async function renderPage(container) {
    clearInterval(S.timer);
    draw(container);
    await refresh(container);
    S.timer = setInterval(() => {
      const page = document.getElementById('page-live');
      if (!page || !page.classList.contains('active')) { clearInterval(S.timer); return; }
      if (!document.hidden && marketOpen()) refresh(container);
    }, 30000);
  }

  async function refresh(container) {
    if (S.busy) return;
    S.busy = true; S.err = null; draw(container);
    try {
      const list = await symbols();
      S.list = list;
      if (list.length) {
        // order book from NSE, prices from ICICI when connected
        const [d] = await Promise.all([
          getJSON('api/events.php?action=depth_many&symbols=' + encodeURIComponent(list.join(','))),
          Promise.all(list.map(s => MarketData.getQuote(s).then(q => { S.prices[s] = q; }).catch(() => {}))),
        ]);
        S.rows = d.rows || {}; S.at = d.at;
      }
    } catch (e) { S.err = e.message; }
    S.busy = false;
    draw(container);
  }

  function draw(container) {
    const list = S.list || [];
    const rows = list.map(s => {
      let d = S.rows[s] || {}; const q = S.prices[s];
      // NSE refused: fall back to ICICI's best bid / best offer quantity
      if ((d.error || d.totalBuy == null) && q && q.bidQty != null && q.askQty != null) d = { ...d, totalBuy: q.bidQty, totalSell: q.askQty, top: true, error: null };
      const t = (d.totalBuy || 0) + (d.totalSell || 0);
      return { s, d, q, share: t ? d.totalBuy / t : null, ratio: d.totalSell ? d.totalBuy / d.totalSell : null };
    });
    const key = { ratio: r => (r.ratio == null ? -1 : r.ratio), chg: r => (r.q && r.q.changePct != null ? r.q.changePct : -999), del: r => (r.d.deliveryPct == null ? -1 : r.d.deliveryPct), name: r => r.s };
    rows.sort((a, b) => S.sort === 'name' ? a.s.localeCompare(b.s) : key[S.sort](b) - key[S.sort](a));
    const buyers = rows.filter(r => r.ratio != null && r.ratio >= 1.1).length, sellers = rows.filter(r => r.ratio != null && r.ratio <= 0.9).length;
    container.innerHTML = `
      <div class="live-top">
        <div class="seg"><button type="button" data-set="watch" class="${S.set === 'watch' ? 'active' : ''}">My Watchlist</button><button type="button" data-set="heavy" class="${S.set === 'heavy' ? 'active' : ''}">NIFTY top 20</button></div>
        <div class="live-status"><span class="mkt-pill ${marketOpen() ? 'open' : ''}"><i></i>${marketOpen() ? 'Live · every 30 s' : 'Market closed · last order book'}</span>
        <button type="button" class="btn-secondary" id="live-refresh" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Loading…' : 'Refresh'}</button></div>
      </div>
      ${rows.length ? `<div class="live-sum"><div><span>More buyers</span><b class="up">${buyers}</b></div><div><span>More sellers</span><b class="down">${sellers}</b></div><div><span>Balanced</span><b>${rows.length - buyers - sellers}</b></div></div>` : ''}
      ${S.err ? `<p class="auth-error">${esc(S.err)}</p>` : ''}
      ${!list.length && !S.busy ? '<p class="home-empty">Your Watchlist is empty. Add stocks there, or switch to NIFTY top 20.</p>' : ''}
      ${rows.length ? `<div class="card live-card"><div class="tbl-wrap"><table class="st-table live-table">
        <thead><tr><th data-sort="name">Stock</th><th data-sort="chg">Price</th><th data-sort="ratio" class="live-barcol">Buyers vs sellers ${S.sort === 'ratio' ? '▼' : ''}</th><th data-sort="del" class="hide-sm">Delivery ${S.sort === 'del' ? '▼' : ''}</th></tr></thead>
        <tbody>${rows.map(r => {
          const b = r.share != null ? r.share * 100 : null;
          return `<tr data-sym="${esc(r.s)}"><td><b>${esc(r.s)}</b></td>
            <td>${r.q && r.q.ltp ? `${num(r.q.ltp)}<br><small class="${r.q.changePct > 0 ? 'up' : r.q.changePct < 0 ? 'down' : ''}">${r.q.changePct != null ? (r.q.changePct > 0 ? '+' : '') + r.q.changePct.toFixed(2) + '%' : ''}</small>` : '<span class="muted">—</span>'}</td>
            <td class="live-barcol">${b != null ? `<div class="pbar sm"><div class="pbar-b" style="width:${b}%"></div></div><div class="pbar-l sm"><span class="up">${qty(r.d.totalBuy)}</span><span class="${r.ratio >= 1.1 ? 'up' : r.ratio <= 0.9 ? 'down' : 'muted'}">${r.ratio.toFixed(2)}×</span><span class="down">${qty(r.d.totalSell)}</span></div>${r.d.top ? '<small class="muted">best bid / offer only</small>' : ''}` : `<span class="muted small">${r.d.error === 'later' ? 'next refresh' : r.d.error ? 'not available' : S.busy ? 'loading…' : '—'}</span>`}</td>
            <td class="hide-sm">${r.d.deliveryPct != null ? num(r.d.deliveryPct, 1) + '%' : '—'}</td></tr>`;
        }).join('')}</tbody></table></div></div>` : ''}
      <p class="citation">Buyers vs sellers = all shares waiting in NSE's order book to be bought (green) and sold (red). More than 1.0× means more buyers waiting. It changes every second and can flip fast, so use it with the demand & supply call, not alone. Delivery % is from the last session. Prices come from ICICI when you are connected. When NSE refuses the request, only ICICI's best bid and best offer quantity is shown.${S.at ? ` Order book at ${new Date(S.at * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.` : ''}</p>`;
    container.querySelectorAll('[data-set]').forEach(b => { b.onclick = () => { S.set = b.dataset.set; S.rows = {}; S.list = null; try { localStorage.setItem('mm-live-set', S.set); } catch { /* ok */ } refresh(container); }; });
    const rf = container.querySelector('#live-refresh'); if (rf) rf.onclick = () => refresh(container);
    container.querySelectorAll('th[data-sort]').forEach(th => { th.onclick = () => { S.sort = th.dataset.sort; draw(container); }; });
    container.querySelectorAll('tr[data-sym]').forEach(tr => { tr.onclick = () => root.Stock && Stock.open(tr.dataset.sym); });
  }

  root.LivePage = { renderPage };
})(window);

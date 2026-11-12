// MarketMind AI — Live buyers & sellers board.
// NSE refuses order-book requests from our host (HTTP 403), so instead of "shares waiting in the order book" this
// board measures who has been in control TODAY from the 5-minute candles (ICICI when logged in, else Yahoo):
//   • Buying pressure = share of today's volume traded near the top of each 5-minute candle
//     (close-location: a candle closing at its high counts 100% as buying, at its low 100% as selling).
//   • Price vs VWAP = today's price against the average price paid today, weighted by volume.
//   • Last 30 minutes = the same pressure for the latest 6 candles, to see if buyers are gaining or fading.
// Buyers in control: pressure ≥ 55% and price above VWAP. Sellers in control: ≤ 45% and below VWAP.
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (v, d = 2) => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
  const qty = v => (v == null ? '—' : v >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : v >= 1e5 ? (v / 1e5).toFixed(1) + ' L' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v)));
  const IST = 5.5 * 3600e3;
  const istDay = t => new Date(t + IST).toISOString().slice(0, 10);
  const marketOpen = () => { const d = new Date(Date.now() + IST), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && m >= 555 && m <= 930; };

  const HEAVY = ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'BHARTIARTL', 'ITC', 'SBIN', 'LT', 'KOTAKBANK', 'AXISBANK', 'HINDUNILVR', 'BAJFINANCE', 'MARUTI', 'SUNPHARMA', 'M&M', 'TITAN', 'NTPC', 'ULTRACEMCO', 'HCLTECH'];
  const S = { set: 'watch', rows: {}, list: null, at: null, busy: false, timer: null, sort: 'press', err: null, src: null };
  try { S.set = localStorage.getItem('mm-live-set') || 'watch'; } catch { /* default */ }

  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }
  async function symbols() {
    if (S.set === 'heavy') return HEAVY;
    try { return ((await getJSON('api/watchlist.php?action=list')).items || []).map(i => i.symbol); } catch { return []; }
  }

  // Today's 5-minute candles: ICICI first, Yahoo (delayed) as the fallback
  async function todayCandles(sym) {
    try {
      const j = await getJSON(`api/breeze.php?action=candles&symbol=${encodeURIComponent(sym)}&interval=5minute&days=4`);
      const c = (j.candles || []).map(r => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })).filter(x => x.v > 0);
      if (c.length) return { c, src: 'ICICI' };
    } catch { /* fall back */ }
    const j = await getJSON(`api/chart.php?symbol=${encodeURIComponent(MarketData.toYahooSymbol(sym))}&interval=5m&range=5d`);
    const p = MarketData.parseYahooChart(j);
    const c = p.candles.filter(x => x && x.volume > 0 && isFinite(x.close)).map(x => ({ t: x.time, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume }));
    return { c, src: 'Yahoo (delayed)', prev: p.meta && p.meta.chartPreviousClose };
  }

  function pressure(cs) {
    let vol = 0, buy = 0, pv = 0;
    for (const x of cs) {
      const rng = x.h - x.l, clv = rng > 0 ? (x.c - x.l) / rng : 0.5;
      vol += x.v; buy += x.v * clv; pv += x.v * (x.h + x.l + x.c) / 3;
    }
    return vol ? { share: buy / vol, buyVol: buy, sellVol: vol - buy, vol, vwap: pv / vol } : null;
  }

  async function analyse(sym) {
    const { c, src, prev } = await todayCandles(sym);
    if (!c.length) throw new Error('no candles');
    const day = istDay(c[c.length - 1].t);
    const today = c.filter(x => istDay(x.t) === day);
    const before = c.filter(x => istDay(x.t) < day);
    const p = pressure(today), last = pressure(today.slice(-6));
    const price = today[today.length - 1].c;
    const prevClose = before.length ? before[before.length - 1].c : prev;
    let q = null;
    try { q = await MarketData.getQuote(sym); } catch { /* candles only */ }
    const ltp = q && q.ltp ? q.ltp : price;
    const chg = q && q.changePct != null ? q.changePct : prevClose ? (ltp / prevClose - 1) * 100 : null;
    const vsVwap = p && p.vwap ? (ltp / p.vwap - 1) * 100 : null;
    const share = p ? p.share * 100 : null, lastShare = last ? last.share * 100 : null;
    const state = share == null ? 'mixed' : share >= 55 && vsVwap > 0 ? 'buyers' : share <= 45 && vsVwap < 0 ? 'sellers' : 'mixed';
    return { sym, src, day, ltp, chg, share, lastShare, vsVwap, vwap: p && p.vwap, buyVol: p && p.buyVol, sellVol: p && p.sellVol, vol: p && p.vol, state,
      bid: q && q.bidQty, ask: q && q.askQty, candles: today.length };
  }

  async function renderPage(container) {
    clearInterval(S.timer);
    draw(container);
    await refresh(container);
    S.timer = setInterval(() => {
      const page = document.getElementById('page-live');
      if (!page || !page.classList.contains('active')) { clearInterval(S.timer); return; }
      if (!document.hidden && marketOpen()) refresh(container);
    }, 60000);
  }

  async function refresh(container) {
    if (S.busy) return;
    S.busy = true; S.err = null;
    try {
      S.list = await symbols();
      draw(container);
      let i = 0;
      const worker = async () => {
        while (i < S.list.length) {
          const sym = S.list[i++];
          try { S.rows[sym] = await analyse(sym); } catch (e) { S.rows[sym] = { sym, error: e.message }; }
          draw(container);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      S.at = Date.now();
    } catch (e) { S.err = e.message; }
    S.busy = false;
    draw(container);
  }

  const STATE = { buyers: ['Buyers in control', 'up'], sellers: ['Sellers in control', 'down'], mixed: ['Mixed', 'muted'] };

  function draw(container) {
    const list = S.list || [];
    const rows = list.map(s => S.rows[s] || { sym: s, loading: true });
    const key = { press: r => r.share ?? -1, chg: r => r.chg ?? -999, vwap: r => r.vsVwap ?? -999, name: r => r.sym };
    rows.sort((a, b) => S.sort === 'name' ? a.sym.localeCompare(b.sym) : key[S.sort](b) - key[S.sort](a));
    const done = rows.filter(r => r.share != null);
    const n = st => done.filter(r => r.state === st).length;
    const src = done.find(r => r.src);
    container.innerHTML = `
      <div class="live-top">
        <div class="seg"><button type="button" data-set="watch" class="${S.set === 'watch' ? 'active' : ''}">My Watchlist</button><button type="button" data-set="heavy" class="${S.set === 'heavy' ? 'active' : ''}">NIFTY top 20</button></div>
        <div class="live-status"><span class="mkt-pill ${marketOpen() ? 'open' : ''}"><i></i>${marketOpen() ? 'Live · every minute' : 'Market closed · last session'}</span>
        <button type="button" class="btn-secondary" id="live-refresh" ${S.busy ? 'disabled' : ''}>${S.busy ? `Loading ${done.length}/${list.length}…` : 'Refresh'}</button></div>
      </div>
      ${done.length ? `<div class="live-sum"><div><span>Buyers in control</span><b class="up">${n('buyers')}</b></div><div><span>Sellers in control</span><b class="down">${n('sellers')}</b></div><div><span>Mixed</span><b>${n('mixed')}</b></div></div>` : ''}
      ${S.err ? `<p class="auth-error">${esc(S.err)}</p>` : ''}
      ${!list.length && !S.busy ? '<p class="home-empty">Your Watchlist is empty. Add stocks there, or switch to NIFTY top 20.</p>' : ''}
      ${rows.length ? `<div class="card live-card"><div class="tbl-wrap"><table class="st-table live-table">
        <thead><tr><th data-sort="name">Stock</th><th data-sort="chg">Price ${S.sort === 'chg' ? '▼' : ''}</th><th data-sort="press" class="live-barcol">Buying vs selling today ${S.sort === 'press' ? '▼' : ''}</th><th data-sort="vwap" class="hide-sm">vs VWAP ${S.sort === 'vwap' ? '▼' : ''}</th></tr></thead>
        <tbody>${rows.map(r => {
          if (r.loading || r.error) return `<tr data-sym="${esc(r.sym)}"><td><b>${esc(r.sym)}</b></td><td colspan="3" class="muted small">${r.error ? 'not available: ' + esc(r.error) : 'loading…'}</td></tr>`;
          const [label, cls] = STATE[r.state];
          const trend = r.lastShare == null ? '' : r.lastShare - r.share >= 8 ? ' · buyers gaining' : r.share - r.lastShare >= 8 ? ' · buyers fading' : '';
          return `<tr data-sym="${esc(r.sym)}"><td><b>${esc(r.sym)}</b><br><small class="${cls}">${label}</small></td>
            <td>${num(r.ltp)}<br><small class="${r.chg > 0 ? 'up' : r.chg < 0 ? 'down' : ''}">${pct(r.chg)}</small></td>
            <td class="live-barcol"><div class="pbar sm"><div class="pbar-b" style="width:${r.share.toFixed(0)}%"></div></div>
              <div class="pbar-l sm" title="${qty(r.buyVol)} shares bought · ${qty(r.sellVol)} sold"><span class="up">${r.share.toFixed(0)}% buy</span><span class="down">${(100 - r.share).toFixed(0)}% sell</span></div>
              <small class="muted">last 30 min ${r.lastShare != null ? r.lastShare.toFixed(0) + '% buy' : '—'}${trend}</small></td>
            <td class="hide-sm ${r.vsVwap > 0 ? 'up' : r.vsVwap < 0 ? 'down' : ''}">${pct(r.vsVwap)}<br><small class="muted">VWAP ${num(r.vwap)}</small></td></tr>`;
        }).join('')}</tbody></table></div></div>` : ''}
      <div class="card live-help">
        <h4>How to read this</h4>
        <ul>
          <li><b>Buying vs selling today</b>: of all shares traded today, how much traded near the top of each 5-minute candle (buyers pushing) versus near the bottom (sellers pushing).</li>
          <li><b>vs VWAP</b>: today's price against the average price everyone paid today. Above VWAP means today's buyers are in profit.</li>
          <li><b>Buyers in control</b> = 55%+ buying and price above VWAP. <b>Sellers in control</b> = 45% or less and below VWAP.</li>
          <li>Use it to time an entry on a stock that already has a BUY call, not as a call by itself. Tap a stock to open it.</li>
        </ul>
        <p class="citation">From today's 5-minute candles${src ? ` (${esc(src.src)})` : ''}. NSE's full order book is not available from our server, so it is not used.${S.at ? ` Updated ${new Date(S.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.` : ''}</p>
      </div>`;
    container.querySelectorAll('[data-set]').forEach(b => { b.onclick = () => { S.set = b.dataset.set; S.rows = {}; S.list = null; try { localStorage.setItem('mm-live-set', S.set); } catch { /* ok */ } refresh(container); }; });
    const rf = container.querySelector('#live-refresh'); if (rf) rf.onclick = () => refresh(container);
    container.querySelectorAll('th[data-sort]').forEach(th => { th.onclick = () => { S.sort = th.dataset.sort; draw(container); }; });
    container.querySelectorAll('tr[data-sym]').forEach(tr => { tr.onclick = () => root.Stock && Stock.open(tr.dataset.sym); });
  }

  root.LivePage = { renderPage, _pressure: pressure };
})(window);

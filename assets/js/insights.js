// MarketMind AI — Insights: breadth, sector rotation, strongest stocks, top movers, FII/DII flows, market holidays.
// Built on api/overview.php (NIFTY 500 rows) and api/events.php (fiidii, holidays).
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v, d = 1) => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
  const cr = v => (v == null || !isFinite(v) ? '—' : `₹${Math.round(v).toLocaleString('en-IN')} cr`);
  const tone = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  async function j(url) { const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }); const x = await r.json().catch(() => null); if (!r.ok || !x) throw new Error((x && x.error) || `HTTP ${r.status}`); return x; }
  const median = a => { const b = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
  const card = (id, title, sub) => `<section class="home-card" id="${id}"><div class="home-card-head"><h3>${title}</h3>${sub ? `<small class="muted">${sub}</small>` : ''}</div><div class="home-card-body"><div class="skeleton"></div></div></section>`;
  const put = (id, html) => { const e = document.querySelector(`#${id} .home-card-body`); if (e) e.innerHTML = html; };

  // Sector rotation: x = 3-month strength vs NIFTY, y = momentum (1 month minus 3-month monthly pace)
  function rotation(pts) {
    const W = 520, H = 340, P = 30, xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const mx = Math.max(5, ...xs.map(Math.abs)) * 1.15, my = Math.max(3, ...ys.map(Math.abs)) * 1.15;
    const X = v => P + (v + mx) / (2 * mx) * (W - 2 * P), Y = v => H - P - (v + my) / (2 * my) * (H - 2 * P);
    const q = (x, y, t, c) => `<text x="${x}" y="${y}" class="rot-q" fill="${c}">${t}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" class="rot">
      <line x1="${X(0)}" y1="${P}" x2="${X(0)}" y2="${H - P}" class="rot-ax"/><line x1="${P}" y1="${Y(0)}" x2="${W - P}" y2="${Y(0)}" class="rot-ax"/>
      ${q(W - P - 4, P + 14, 'Leading', 'var(--green)')}${q(P + 4, P + 14, 'Improving', 'var(--accent)')}${q(P + 4, H - P - 6, 'Lagging', 'var(--red)')}${q(W - P - 4, H - P - 6, 'Weakening', 'var(--yellow)')}
      ${pts.map(p => `<g><circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5" fill="${p.x >= 0 ? (p.y >= 0 ? 'var(--green)' : 'var(--yellow)') : (p.y >= 0 ? 'var(--accent)' : 'var(--red)')}"><title>${esc(p.name)}: ${pct(p.x)} vs NIFTY (3m), momentum ${pct(p.y)}</title></circle>
        <text x="${X(p.x) + 7}" y="${Y(p.y) + 4}" class="rot-l">${esc(p.name)}</text></g>`).join('')}
      <text x="${W / 2}" y="${H - 6}" class="rot-t">← weaker than NIFTY · 3 months · stronger →</text></svg>`;
  }

  async function market() {
    let d;
    try { d = await j('api/overview.php?action=market'); } catch (e) { ['in-breadth', 'in-rot', 'in-rs', 'in-move'].forEach(id => put(id, `<p class="home-empty">${esc(e.message)}</p>`)); return; }
    const rows = d.rows.filter(r => r[3] != null).map(r => ({ sym: r[0], g: r[1], i: r[2], last: r[3], d1: r[4], w1: r[5], m1: r[6], m3: r[7], a50: r[8], a200: r[9] }));
    const nifty = (d.tiles.find(t => t.sym === '^NSEI') || {});
    // Breadth
    const share = (list, k) => (list.length ? list.filter(r => r[k]).length / list.length * 100 : null);
    const adv = rows.filter(r => r.d1 > 0).length, dec = rows.filter(r => r.d1 < 0).length;
    const groups = Object.entries(d.groups || {}).map(([g, x]) => [x.name, rows.filter(r => r.g === g)]);
    put('in-breadth', `<div class="money-total"><div><span>Advancing / declining today</span><b><span class="up">${adv}</span> / <span class="down">${dec}</span></b></div>
      <div><span>Above 50-DMA</span><b>${pct(share(rows, 'a50'), 0).replace('+', '')}</b></div><div><span>Above 200-DMA</span><b>${pct(share(rows, 'a200'), 0).replace('+', '')}</b></div></div>
      <table class="screener-table"><thead><tr><th>Group</th><th>Above 50-DMA</th><th>Above 200-DMA</th><th>Median 1 month</th></tr></thead><tbody>
      ${groups.map(([n, l]) => `<tr><td>${esc(n)}</td><td>${pct(share(l, 'a50'), 0).replace('+', '')}</td><td>${pct(share(l, 'a200'), 0).replace('+', '')}</td><td class="${tone(median(l.map(r => r.m1)))}">${pct(median(l.map(r => r.m1)))}</td></tr>`).join('')}</tbody></table>
      <p class="citation">Healthy markets usually have more than 60% of stocks above their 200-day average; below 40% is weak. NIFTY 500 stocks, prices delayed.</p>`);
    // Sector rotation
    const pts = Object.entries(d.sectors).map(([i, s]) => { const l = rows.filter(r => String(r.i) === String(i)); const m3 = median(l.map(r => r.m3)), m1 = median(l.map(r => r.m1)); return l.length >= 3 && m3 != null ? { name: s.short || s.name, x: m3 - (nifty.m3 || 0), y: m1 - m3 / 3 } : null; }).filter(Boolean);
    put('in-rot', rotation(pts) + '<p class="citation">Each dot is a sector (median of its NIFTY 500 stocks). Leading = stronger than NIFTY and still speeding up; Weakening = strong but slowing; Improving = weak but turning up.</p>');
    // Relative strength leaderboard
    const rs = rows.filter(r => r.m3 != null).map(r => ({ ...r, rs: r.m3 - (nifty.m3 || 0) })).sort((a, b) => b.rs - a.rs).slice(0, 20);
    put('in-rs', `<table class="screener-table"><thead><tr><th>#</th><th>Stock</th><th>Sector</th><th>3 months</th><th>vs NIFTY</th><th>1 month</th></tr></thead><tbody>
      ${rs.map((r, k) => `<tr data-sym="${esc(r.sym)}"><td>${k + 1}</td><td><b>${esc(r.sym)}</b></td><td>${esc((d.sectors[r.i] || {}).short || '')}</td><td class="up">${pct(r.m3)}</td><td class="up">${pct(r.rs)}</td><td class="${tone(r.m1)}">${pct(r.m1)}</td></tr>`).join('')}</tbody></table>`);
    // Top movers today, with that sector's latest headline as context
    let news = {}; try { news = (await j('api/overview.php?action=news')).sectors || {}; } catch { /* optional */ }
    const mv = [...rows].filter(r => r.d1 != null).sort((a, b) => Math.abs(b.d1) - Math.abs(a.d1)).slice(0, 8);
    put('in-move', `<ul class="q-list">${mv.map(r => { const n = ((news[r.i] || {}).items || [])[0]; return `<li data-sym="${esc(r.sym)}"><div><b>${esc(r.sym)}</b><small>${n ? esc(n.title.slice(0, 90)) : esc((d.sectors[r.i] || {}).name || '')}</small></div><div class="q-num"><b class="${tone(r.d1)}">${pct(r.d1, 2)}</b></div></li>`; }).join('')}</ul>
      <p class="citation">Headline = the latest news for the stock's sector, as context only; it may not be the reason for the move.</p>`);
  }

  async function flows() {
    try {
      const f = await j('api/events.php?action=fiidii');
      if (!f.rows.length) return put('in-flow', `<p class="home-empty">NSE returned no FII/DII data${f.keys && f.keys.length ? ' (fields: ' + esc(f.keys.join(', ')) + ')' : ''}.</p>`);
      put('in-flow', `<table class="screener-table"><thead><tr><th>Who</th><th>Date</th><th>Bought</th><th>Sold</th><th>Net</th></tr></thead><tbody>
        ${f.rows.map(r => `<tr><td>${esc(r.who)}</td><td>${esc(r.date)}</td><td>${cr(r.buy)}</td><td>${cr(r.sell)}</td><td class="${tone(r.net)}"><b>${cr(r.net)}</b></td></tr>`).join('')}</tbody></table>
        <p class="citation">Cash market, provisional figures from NSE. FII = foreign institutions, DII = Indian institutions (mutual funds, insurers).</p>`);
    } catch (e) { put('in-flow', `<p class="home-empty">Could not load FII/DII data: ${esc(e.message)}</p>`); }
  }

  async function holidays() {
    try {
      const h = await j('api/events.php?action=holidays');
      const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
      const next = h.holidays.filter(x => x.date >= today).slice(0, 8);
      put('in-hol', next.length ? `<ul class="ev-list">${next.map(x => `<li><time>${new Date(x.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', weekday: 'short' })}</time><div><b>${esc(x.what)}</b></div></li>`).join('')}</ul>
        <p class="citation">NSE trading holidays. Avoid opening short-term trades just before a long weekend.</p>` : '<p class="home-empty">No more trading holidays listed this year.</p>');
    } catch (e) { put('in-hol', `<p class="home-empty">Could not load holidays: ${esc(e.message)}</p>`); }
  }

  async function renderPage(el) {
    if (!el) return;
    el.innerHTML = `<div class="home-grid in-grid">
      ${card('in-breadth', 'Market breadth', 'NIFTY 500')}${card('in-rot', 'Sector rotation', 'strength vs momentum')}
      ${card('in-rs', 'Strongest stocks', 'top 20 vs NIFTY, 3 months')}${card('in-move', 'What moved today', 'biggest moves, with sector news')}
      ${card('in-flow', 'FII / DII money flow', 'NSE')}${card('in-hol', 'Market holidays', 'NSE')}</div>`;
    market(); flows(); holidays();
  }
  root.Insights = { renderPage };
})(typeof window !== 'undefined' ? window : globalThis);

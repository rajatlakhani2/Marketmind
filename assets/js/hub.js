// MarketMind AI — Ideas (today's swing setups, near breakouts, stocks passing your rules) and the More hub.
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function j(url) { const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }); const x = await r.json().catch(() => null); if (!r.ok || !x) throw new Error((x && x.error) || `HTTP ${r.status}`); return x; }
  const card = (id, title, sub) => `<section class="home-card" id="${id}"><div class="home-card-head"><h3>${title}</h3>${sub ? `<small class="muted">${sub}</small>` : ''}</div><div class="home-card-body"><div class="skeleton"></div></div></section>`;
  const put = (id, html) => { const e = document.querySelector(`#${id} .home-card-body`); if (e) e.innerHTML = html; };

  async function renderIdeas(el) {
    if (!el) return;
    el.innerHTML = `<div class="home-grid">${card('id-swing', "Today's swing setups", 'trend-template breakouts, NIFTY 500')}${card('id-near', 'Close to a breakout', 'within 2% of the trigger')}${card('id-rules', 'Passed my rules', 'NIFTY 500, evening scan')}
      <section class="home-card"><div class="home-card-head"><h3>More ways to find ideas</h3></div><div class="home-card-body hub-grid">
        <button class="hub-tile" data-go="screener"><b>Screener</b><span>Filter stocks by your own numbers</span></button>
        <button class="hub-tile" data-go="opps"><b>Opportunities</b><span>The daily scan's strongest setups</span></button>
        <button class="hub-tile" data-go="optcalls"><b>Option calls</b><span>Buy call / buy put / wait on indices</span></button>
      </div></section></div>`;
    el.onclick = e => { const b = e.target.closest('[data-go]'); if (b && root.Nav) Nav.go(b.dataset.go); };
    let d = null;
    try { d = await j('api/swing.php?action=latest'); } catch (e) { put('id-swing', `<p class="home-empty">${esc(e.message)}</p>`); }
    if (d && d.date) {
      const cs = d.closedStats || {};
      put('id-swing', `${!d.market.up ? '<p class="warn">NIFTY is below its 200-day average: no new buys today.</p>' : ''}
        ${d.signals.length ? `<div class="fno-tablewrap"><table class="screener-table"><thead><tr><th>Stock</th><th>Industry</th><th>Close</th><th>Stop</th><th>Risk</th><th>Shares for ₹500 risk</th></tr></thead><tbody>
          ${d.signals.map(x => `<tr data-sym="${esc(x.sym)}"><td><b>${esc(x.sym)}</b></td><td>${esc(x.ind)}</td><td>₹${x.close}</td><td>₹${x.stop}</td><td>${x.riskPct}%</td><td>${x.qty}</td></tr>`).join('')}</tbody></table></div>` : `<p class="home-empty">No breakout on ${esc(d.date)}.</p>`}
        <p class="citation">Paper record since ${esc(d.start)}: ${cs.n || 0} closed, ${cs.n ? Math.round(cs.wins / cs.n * 100) + '% winners, ' + (cs.avgR > 0 ? '+' : '') + cs.avgR + 'R a trade' : 'no closed trades yet'}; ${d.open.length} open. <a href="#" data-go="insights">Full tracker</a></p>`);
      put('id-near', d.near.length ? `<ul class="q-list">${d.near.map(x => `<li data-sym="${esc(x.sym)}"><div><b>${esc(x.sym)}</b><small>${esc(x.ind)} · breaks out above ₹${x.trigger}</small></div><div class="q-num"><b>₹${x.close}</b><small>${x.gap}% away</small></div></li>`).join('')}</ul>` : '<p class="home-empty">None today.</p>');
    } else if (d) { put('id-swing', `<p class="home-empty">${esc(d.note || 'No scan yet.')}</p>`); put('id-near', ''); }
    try {
      const r = await Kundli.scanRules();
      put('id-rules', r.results.length ? r.results.map(x => `<div class="rule-hit"><b>${esc(x.rule.name)}</b> <span class="muted">${x.onlyFund ? 'fundamentals only: check in Stock 360°' : `${x.hits.length} stocks`}</span>
        ${x.hits.length ? `<div class="chips">${x.hits.slice(0, 40).map(h => `<button data-sym="${esc(h.sym)}">${esc(h.sym)}</button>`).join('')}</div>` : ''}</div>`).join('') + `<p class="citation">Scan of ${esc(r.date)}. <a href="#" data-myrules>Manage my rules</a></p>`
        : '<p class="home-empty">No rules yet.</p><button class="btn-secondary btn-small" data-myrules>Create a rule</button>');
    } catch (e) { put('id-rules', `<p class="home-empty">${esc(e.message)}</p>`); }
    el.querySelectorAll('[data-myrules]').forEach(b => (b.onclick = e => { e.preventDefault(); Kundli.openRules(() => renderIdeas(el)); }));
  }

  const MORE = [
    ['Markets', [['insights', 'Insights', 'Breadth, sector rotation, movers, gaps, FII/DII, swing tracker'], ['events', 'Events & News', 'Results calendar and market news'], ['corpactions', 'Corporate actions', 'Dividends, splits, bonus, buybacks'], ['results', 'Results', 'Quarterly results and estimates']]],
    ['F&O', [['fno', 'Option chain & futures', 'Chains, PCR, max pain, strategy builder'], ['optcalls', 'Option calls', 'Buy call / buy put / wait']]],
    ['Research', [['backtest', 'Back-test', 'Test strategies on years of data'], ['strategies', 'Strategies', 'Every strategy and its tier'], ['mindguru', 'MindGuru', "How MarketMind's calls turned out"]]],
    ['Learn', [['concepts', 'Concepts', 'Trading ideas explained simply'], ['knowledge', 'Library', 'Your uploaded documents'], ['theory', 'Theory', 'How the analysis works'], ['methodology', 'Methodology', 'Rules behind the verdicts']]],
  ];
  function renderMore(el) {
    if (!el) return;
    const settings = [['theme', 'Theme and tabs', 'Clean light, Pro dark, Soft colour; reorder and pin pages'], ['brokers', 'Broker accounts', 'ICICI, Zerodha; daily log-in; sharing'], ['rules', 'My rules', 'Your buy criteria, with a 5-year test'], ['alerts', 'Alerts', 'Price, RSI and 200-day alerts']];
    el.innerHTML = `<div class="hub">${MORE.map(([g, items]) => `<div><h3>${g}</h3><div class="hub-grid">${items.map(([p, t, d]) => `<button class="hub-tile" data-go="${p}"><b>${esc(t)}</b><span>${esc(d)}</span></button>`).join('')}</div></div>`).join('')}
      <div><h3>Settings</h3><div class="hub-grid">${settings.map(([k, t, d]) => `<button class="hub-tile" data-set="${k}"><b>${esc(t)}</b><span>${esc(d)}</span></button>`).join('')}</div></div></div>`;
    el.querySelectorAll('[data-go]').forEach(b => (b.onclick = () => root.Nav && Nav.go(b.dataset.go)));
    const act = { theme: () => Nav.customize(), brokers: () => Account.openBrokers(), rules: () => Kundli.openRules(), alerts: () => UX.openAlerts() };
    el.querySelectorAll('[data-set]').forEach(b => (b.onclick = () => act[b.dataset.set] && act[b.dataset.set]()));
  }
  root.Hub = { renderIdeas, renderMore };
})(typeof window !== 'undefined' ? window : globalThis);

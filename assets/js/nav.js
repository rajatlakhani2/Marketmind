// MarketMind AI — app shell: 5 main tabs with sub-tabs (top bar on desktop, bottom bar on phone),
// account sheet, and tap-to-expand help text. Pages still open through the original
// #nav-links links, so admin-only pages and badges keep working.
(function (root) {
  'use strict';

  const ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    watch: '<path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
    markets: '<path d="M3 17l5-5 4 4 8-8"/><path d="M15 8h5v5"/>',
    trade: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    learn: '<path d="M12 6.5C10 5 7 4.5 3 5v13c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5z"/><path d="M12 6.5V19"/>',
  };
  const svg = k => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;

  const GROUPS = [
    { id: 'home', label: 'Home', pages: [['dashboard', 'Overview']] },
    { id: 'watch', label: 'Watchlist', pages: [['watchlist', 'Watchlist']] },
    { id: 'markets', label: 'Markets', pages: [['stock', 'Stock'], ['live', 'Live buyers'], ['opps', 'Opportunities'], ['fno', 'F&O'], ['optcalls', 'Option calls'], ['corpactions', 'Corporate actions'], ['results', 'Results'], ['analyze', 'Analyze'], ['events', 'Events & News'], ['screener', 'Screener']] },
    { id: 'trade', label: 'Trade', pages: [['trading', 'Orders'], ['holdings', 'Holdings']] },
    { id: 'learn', label: 'Learn', pages: [['mindguru', 'MindGuru'], ['backtest', 'Back-test'], ['strategies', 'Strategies'], ['concepts', 'Concepts'], ['knowledge', 'Library'], ['theory', 'Theory'], ['methodology', 'Methodology']] },
  ];
  const groupOf = page => GROUPS.find(g => g.pages.some(p => p[0] === page)) || GROUPS[0];
  const lastPage = {};
  let current = 'dashboard';

  const link = page => document.querySelector(`#nav-links a[data-page="${page}"]`);
  const visible = page => { const a = link(page); return !!a && !a.closest('li.hidden'); };
  const visiblePages = g => g.pages.filter(([p]) => visible(p));
  const badgeOf = page => { const b = link(page) && link(page).querySelector('.nav-badge'); return b ? b.textContent : ''; };

  function go(page) { const a = link(page); if (a) a.click(); }

  function render() {
    const groups = GROUPS.filter(g => visiblePages(g).length);
    const g = groupOf(current);
    const tabs = groups.map(x => {
      const n = visiblePages(x).map(([p]) => badgeOf(p)).filter(Boolean).reduce((a, b) => a + (+b || 0), 0);
      return `<button type="button" class="${x.id === g.id ? 'active' : ''}" data-group="${x.id}" aria-current="${x.id === g.id ? 'page' : 'false'}">${svg(x.id)}<span>${x.label}</span>${n ? `<i class="tab-badge">${n}</i>` : ''}</button>`;
    }).join('');
    document.getElementById('tb-groups').innerHTML = tabs;
    document.getElementById('bottombar').innerHTML = tabs;
    const subs = visiblePages(g);
    const sub = document.getElementById('subnav');
    sub.classList.toggle('hidden', subs.length < 2);
    sub.innerHTML = `<div class="subnav-inner">${subs.map(([p, label]) => `<button type="button" class="${p === current ? 'active' : ''}" data-sub="${p}">${label}${badgeOf(p) ? `<i class="tab-badge">${badgeOf(p)}</i>` : ''}</button>`).join('')}</div>`;
    const act = sub.querySelector('.active');
    if (act && act.scrollIntoView && sub.scrollWidth > sub.clientWidth) act.scrollIntoView({ block: 'nearest', inline: 'center' });
    document.querySelectorAll('[data-group]').forEach(b => { b.onclick = () => { const x = GROUPS.find(y => y.id === b.dataset.group); const ps = visiblePages(x).map(p => p[0]); go(ps.includes(lastPage[x.id]) ? lastPage[x.id] : ps[0]); }; });
    sub.querySelectorAll('[data-sub]').forEach(b => { b.onclick = () => go(b.dataset.sub); });
  }

  // Called by the app after every page change
  function sync(page) {
    const changed = page !== current;
    current = page;
    lastPage[groupOf(page).id] = page;
    try { localStorage.setItem('mm-last-page', page); } catch { /* private mode */ }
    render();
    if (changed) window.scrollTo(0, 0);
  }

  // ---------- account sheet ----------
  function initSheet() {
    const sheet = document.getElementById('account-sheet');
    const foot = document.querySelector('.sidebar-footer');
    if (foot) sheet.querySelector('.sheet-body').appendChild(foot);
    const open = () => { sheet.classList.remove('hidden'); document.body.classList.add('sheet-open'); };
    const close = () => { sheet.classList.add('hidden'); document.body.classList.remove('sheet-open'); };
    document.getElementById('tb-account').onclick = open;
    sheet.addEventListener('click', e => { if (e.target === sheet || e.target.closest('[data-close]') || e.target.closest('.account-links a')) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

    // Mirror the account initial and the ICICI dot in the top bar
    const avatar = document.getElementById('tb-account');
    const status = document.getElementById('broker-status');
    const menu = document.getElementById('account-menu');
    const mirror = () => {
      const name = (menu.querySelector('.account-name') || {}).textContent || '';
      avatar.querySelector('b').textContent = (name.trim()[0] || '•').toUpperCase();
      const dot = status.querySelector('.broker-dot');
      const cls = dot ? (dot.classList.contains('on') ? 'on' : dot.classList.contains('warn') ? 'warn' : 'off') : 'off';
      avatar.querySelector('i').className = 'tb-dot ' + cls;
      avatar.title = (status.textContent || '').trim();
    };
    new MutationObserver(mirror).observe(menu, { childList: true, subtree: true });
    new MutationObserver(mirror).observe(status, { childList: true, subtree: true, attributes: true });
    mirror();
  }

  // ---------- long help text: two lines, tap to expand ----------
  const HELP = '.citation, .mg-help, .tf-hint, .page-sub, .outlook-note';
  function initHelp() {
    document.addEventListener('click', e => {
      const h = e.target.closest(HELP);
      if (!h || e.target.closest('a, button, input, select, label')) return;
      if (h.scrollHeight > h.clientHeight + 2 || h.classList.contains('open')) h.classList.toggle('open');
    });
  }


  // ---------- universal search: stocks, pages, strategies, concepts ----------
  const PAGE_WORDS = {
    dashboard: 'home overview index nifty sensex', watchlist: 'watchlist calls buy sell my stocks', stock: 'stock chart price', live: 'live buyers sellers order book depth market depth pressure',
    opps: 'opportunities scan setups ideas', fno: 'f&o fno options futures option chain calls puts strategy builder iron condor straddle', analyze: 'analyze analysis verdict',
    events: 'events news results dividend corporate actions calendar', screener: 'screener filter', trading: 'orders trading algo approve', holdings: 'holdings portfolio',
    mindguru: 'mindguru learning record accuracy', backtest: 'backtest back-test test history results accuracy', strategies: 'strategies', concepts: 'concepts', knowledge: 'library documents upload books', theory: 'theory', methodology: 'methodology sources',
  };
  const pageLabel = p => { for (const g of GROUPS) for (const [id, l] of g.pages) if (id === p) return [l, g.label]; return [p, '']; };
  let SQ = { items: [], sel: 0, timer: null, seq: 0 };
  const recent = () => { try { return JSON.parse(localStorage.getItem('mm-recent-stocks') || '[]'); } catch { return []; } };
  const remember = st => { try { const r = recent().filter(x => x.symbol !== st.symbol); r.unshift({ symbol: st.symbol, name: st.name || '' }); localStorage.setItem('mm-recent-stocks', JSON.stringify(r.slice(0, 8))); } catch { /* ok */ } };
  const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function openSearch(prefill) {
    const ov = document.getElementById('search-ov');
    ov.classList.remove('hidden'); document.body.classList.add('sheet-open');
    const inp = ov.querySelector('input');
    inp.value = prefill || ''; runSearch(inp.value);
    setTimeout(() => inp.focus(), 30);
  }
  function closeSearch() { document.getElementById('search-ov').classList.add('hidden'); document.body.classList.remove('sheet-open'); }

  function runSearch(q) {
    q = q.trim();
    const seq = ++SQ.seq;
    const ql = q.toLowerCase();
    const items = [];
    if (!q) {
      recent().forEach(r => items.push({ kind: 'stock', title: r.symbol, sub: r.name, run: () => openStock(r) }));
      if (!items.length) ['RELIANCE', 'HDFCBANK', 'TCS', 'INFY', 'SBIN'].forEach(sym => items.push({ kind: 'stock', title: sym, sub: 'Popular', run: () => openStock({ symbol: sym }) }));
    } else {
      // pages
      for (const g of GROUPS) for (const [id, label] of g.pages) {
        if (!visible(id)) continue;
        if (label.toLowerCase().includes(ql) || (PAGE_WORDS[id] || '').includes(ql)) items.push({ kind: 'page', title: label, sub: g.label, run: () => go(id) });
      }
      // strategies & concepts from the knowledge base
      const eng = root.app && app.ui && app.ui.engine;
      if (eng && q.length >= 2) {
        (eng.strategies || []).filter(x => (x.name || '').toLowerCase().includes(ql)).slice(0, 4).forEach(x => items.push({ kind: 'strategy', title: x.name, sub: x.category || 'Strategy', run: () => openStrategy(x) }));
        (eng.concepts || []).filter(x => (x.name || '').toLowerCase().includes(ql)).slice(0, 4).forEach(x => items.push({ kind: 'concept', title: x.name, sub: x.category || 'Concept', run: () => openConcept(x) }));
      }
    }
    SQ.items = items; SQ.sel = 0; drawResults(q, true);
    if (!q) return;
    clearTimeout(SQ.timer);
    SQ.timer = setTimeout(async () => {
      try {
        const r = await fetch(`api/stocks.php?action=search&limit=8&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (seq !== SQ.seq) return;
        const stocks = (j.results || []).map(st => ({ kind: 'stock', title: st.nse || st.symbol, sub: `${st.name || ''}${st.exchange && st.exchange !== 'NSE' ? ' · ' + st.exchange : ''}`, run: () => openStock({ symbol: st.nse || st.symbol, name: st.name }) }));
        SQ.items = [...stocks, ...SQ.items]; SQ.sel = 0; drawResults(q, false);
      } catch { if (seq === SQ.seq) drawResults(q, false); }
    }, 180);
  }
  const KIND = { stock: 'Stock', page: 'Go to', strategy: 'Strategy', concept: 'Concept' };
  function drawResults(q, loading) {
    const box = document.querySelector('#search-ov .so-results');
    if (!SQ.items.length) { box.innerHTML = `<p class="so-empty">${loading ? 'Searching…' : `Nothing found for “${escH(q)}”.`}</p>`; return; }
    let lastKind = null;
    box.innerHTML = (!q ? '<div class="so-group">Recent stocks</div>' : '') + SQ.items.map((it, i) => {
      const head = q && it.kind !== lastKind ? `<div class="so-group">${{ stock: 'Stocks', page: 'Pages', strategy: 'Strategies', concept: 'Concepts' }[it.kind]}</div>` : '';
      lastKind = it.kind;
      return `${head}<button type="button" class="so-item${i === SQ.sel ? ' sel' : ''}" data-i="${i}"><span class="so-k ${it.kind}">${KIND[it.kind]}</span><b>${escH(it.title)}</b><small>${escH(it.sub || '')}</small></button>`;
    }).join('') + (loading && q ? '<p class="so-empty small">Searching stocks…</p>' : '');
    box.querySelectorAll('.so-item').forEach(b => { b.onclick = () => pick(+b.dataset.i); });
  }
  function pick(i) { const it = SQ.items[i]; if (!it) return; closeSearch(); it.run(); }
  function openStock(st) { remember(st); if (root.Stock) Stock.open(st.symbol, st.name); }
  function openStrategy(x) {
    go('strategies');
    setTimeout(() => { try { app.ui.currentStrategy = x; app.ui._renderStrategyDetail(x); app.ui._renderStrategiesList(); } catch { /* list still opens */ } }, 300);
  }
  function openConcept(x) {
    go('concepts');
    setTimeout(() => { const inp = document.getElementById('concept-search'); if (inp) { inp.value = x.name; inp.dispatchEvent(new Event('input')); } }, 300);
  }
  function initSearch() {
    const ov = document.getElementById('search-ov'), inp = ov.querySelector('input');
    document.querySelectorAll('[data-open-search]').forEach(b => { b.onclick = () => openSearch(); });
    inp.addEventListener('input', () => runSearch(inp.value));
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); SQ.sel = Math.max(0, Math.min(SQ.items.length - 1, SQ.sel + (e.key === 'ArrowDown' ? 1 : -1)));
        document.querySelectorAll('#search-ov .so-item').forEach((b, i) => b.classList.toggle('sel', i === SQ.sel));
        const s = document.querySelector('#search-ov .so-item.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') { e.preventDefault(); pick(SQ.sel); }
    });
    ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close-search]')) closeSearch(); });
    document.addEventListener('keydown', e => {
      const typing = /input|textarea|select/i.test((document.activeElement || {}).tagName || '');
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { e.preventDefault(); openSearch(); }
      else if (e.key === 'Escape' && !ov.classList.contains('hidden')) closeSearch();
    });
  }

  function init() {
    initSheet();
    initSearch();
    initHelp();
    // Re-render when admin pages appear / badges change
    new MutationObserver(() => render()).observe(document.getElementById('nav-links'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    render();
    initAndroidBack();
  }

  // Android app: the phone's back button closes the account sheet, then returns to Home, then leaves the app
  function initAndroidBack() {
    const App = root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.App;
    if (!App || !App.addListener) return;
    document.documentElement.classList.add('in-app');
    App.addListener('backButton', () => {
      const so = document.getElementById('search-ov');
      if (so && !so.classList.contains('hidden')) { closeSearch(); return; }
      const sheet = document.getElementById('account-sheet');
      const modal = document.getElementById('modal-overlay');
      if (sheet && !sheet.classList.contains('hidden')) { sheet.classList.add('hidden'); document.body.classList.remove('sheet-open'); return; }
      if (modal && !modal.classList.contains('hidden')) { modal.classList.add('hidden'); return; }
      if (current !== 'dashboard') { go('dashboard'); return; }
      App.exitApp();
    });
  }

  root.Nav = { init, sync, go, GROUPS, search: openSearch };
})(window);

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
    { id: 'markets', label: 'Markets', pages: [['analyze', 'Analyze'], ['opps', 'Opportunities'], ['fno', 'F&O'], ['events', 'Events & News'], ['screener', 'Screener']] },
    { id: 'trade', label: 'Trade', pages: [['trading', 'Orders'], ['holdings', 'Holdings']] },
    { id: 'learn', label: 'Learn', pages: [['mindguru', 'MindGuru'], ['strategies', 'Strategies'], ['concepts', 'Concepts'], ['knowledge', 'Library'], ['theory', 'Theory'], ['methodology', 'Methodology']] },
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

  function init() {
    initSheet();
    initHelp();
    // Re-render when admin pages appear / badges change
    new MutationObserver(() => render()).observe(document.getElementById('nav-links'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    render();
  }

  root.Nav = { init, sync, go, GROUPS };
})(window);

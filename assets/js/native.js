// MarketMind AI — native app feel for phones (works in the Android app and in a phone browser):
// swipe between sub-tabs with the page following your finger, pull down to refresh with a spinner,
// slide transitions between pages, pop-ups as bottom sheets you can drag down to close, haptic taps,
// the status bar following the theme, and push notifications in the Android app.
(function (root) {
  'use strict';
  const Cap = root.Capacitor;
  const P = (Cap && Cap.Plugins) || {};
  const inApp = !!(Cap && (Cap.isNativePlatform ? Cap.isNativePlatform() : Cap.getPlatform && Cap.getPlatform() !== 'web'));
  const touch = 'ontouchstart' in root || navigator.maxTouchPoints > 0;
  const reduced = root.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const toast = (m, t) => root.app && app.ui && app.ui._toast(m, t || 'info');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (inApp) document.documentElement.classList.add('in-app');

  // ---------- haptics ----------
  function haptic(kind) {
    try {
      if (P.Haptics) {
        if (kind === 'success' || kind === 'warning' || kind === 'error') return P.Haptics.notification({ type: kind.toUpperCase() });
        return P.Haptics.impact({ style: kind === 'heavy' ? 'HEAVY' : kind === 'medium' ? 'MEDIUM' : 'LIGHT' });
      }
      if (touch && navigator.vibrate) navigator.vibrate(kind === 'medium' || kind === 'success' ? 18 : 8);
    } catch { /* not supported */ }
  }
  document.addEventListener('click', e => {
    if (e.target.closest('#bottombar button, #subnav button, .tr-tabs button, .seg button, .tabs button')) haptic('select');
    else if (e.target.closest('.btn-primary')) haptic('light');
  }, true);

  // ---------- styles ----------
  const css = `
  .pg-in-r { animation: mmInR .24s cubic-bezier(.2,.8,.2,1) both; }
  .pg-in-l { animation: mmInL .24s cubic-bezier(.2,.8,.2,1) both; }
  .pg-in-f { animation: mmFade .2s ease-out both; }
  @keyframes mmInR { from { opacity: .2; transform: translateX(42px); } to { opacity: 1; transform: none; } }
  @keyframes mmInL { from { opacity: .2; transform: translateX(-42px); } to { opacity: 1; transform: none; } }
  @keyframes mmFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  #mm-ptr { position: fixed; left: 50%; top: 0; z-index: 900; width: 38px; height: 38px; margin-left: -19px; border-radius: 50%;
    background: var(--bg-card); box-shadow: 0 3px 12px rgba(0,0,0,.18); display: flex; align-items: center; justify-content: center;
    transform: translateY(-50px); opacity: 0; pointer-events: none; color: var(--accent, #1f4e9e); }
  #mm-ptr svg { width: 20px; height: 20px; }
  #mm-ptr.ready svg { color: var(--green, #16a34a); }
  #mm-ptr.spin svg { animation: mmSpin .8s linear infinite; }
  @keyframes mmSpin { to { transform: rotate(360deg); } }
  .mm-edge { position: fixed; top: 45%; z-index: 900; width: 34px; height: 34px; border-radius: 50%; background: var(--bg-card);
    box-shadow: 0 2px 10px rgba(0,0,0,.18); display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none;
    font-size: 1.1rem; color: var(--text-secondary); transition: opacity .1s; }
  .mm-edge.l { left: 8px; } .mm-edge.r { right: 8px; }
  .mm-edge small { position: absolute; top: 38px; white-space: nowrap; font-size: .7rem; background: var(--bg-card); padding: 2px 6px; border-radius: 6px; }
  .mm-edge.l small { left: 0; } .mm-edge.r small { right: 0; }
  html.mm-touch body { overscroll-behavior-y: contain; -webkit-tap-highlight-color: transparent; }
  html.mm-touch button:active, html.mm-touch .card:active { transition: transform .08s; }
  html.mm-touch #bottombar button:active, html.mm-touch .btn-primary:active, html.mm-touch .btn-secondary:active { transform: scale(.95); }
  @media (max-width: 768px) {
    html #modal-overlay { align-items: flex-end; animation: mmFade .18s ease-out; }
    #modal-overlay .modal { width: 100%; max-width: 100% !important; max-height: 88vh; border-radius: 18px 18px 0 0; border-bottom: none;
      padding: 22px 16px calc(18px + env(safe-area-inset-bottom)); animation: mmUp .26s cubic-bezier(.2,.8,.2,1); position: relative; }
    #modal-overlay .modal::before { content: ''; position: absolute; top: 7px; left: 50%; width: 40px; height: 4px; margin-left: -20px;
      border-radius: 2px; background: var(--border-strong, var(--text-muted)); opacity: .55; }
    .sheet .sheet-card { animation: mmUp .26s cubic-bezier(.2,.8,.2,1); }
  }
  @keyframes mmUp { from { transform: translateY(100%); } to { transform: none; } }
  .nt-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
  .nt-row b { display: block; font-size: .95rem; } .nt-row span { font-size: .8rem; color: var(--text-muted); }
  .nt-sw { position: relative; width: 46px; height: 26px; flex: none; }
  .nt-sw input { opacity: 0; width: 0; height: 0; }
  .nt-sw i { position: absolute; inset: 0; border-radius: 13px; background: var(--border); transition: .2s; }
  .nt-sw i::after { content: ''; position: absolute; left: 3px; top: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: .2s; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
  .nt-sw input:checked + i { background: var(--green, #16a34a); }
  .nt-sw input:checked + i::after { transform: translateX(20px); }
  .mm-app-btn { width: 100%; text-align: left; }
  @media (prefers-reduced-motion: reduce) { .pg-in-r, .pg-in-l, .pg-in-f, #modal-overlay .modal, .sheet .sheet-card { animation: none !important; } }`;
  const st = document.createElement('style'); st.id = 'mm-native-css'; st.textContent = css; document.head.appendChild(st);
  if (touch) document.documentElement.classList.add('mm-touch');

  // ---------- helpers ----------
  const subs = () => [...document.querySelectorAll('#subnav [data-sub]')];
  const activePage = () => document.querySelector('.page.active');
  const overlayOpen = () => {
    const m = document.getElementById('modal-overlay'), s = document.getElementById('account-sheet'), d = document.getElementById('ux-drawer'), so = document.getElementById('search-ov');
    return (m && !m.classList.contains('hidden')) || (s && !s.classList.contains('hidden')) || (d && d.classList.contains('open')) || (so && !so.classList.contains('hidden'));
  };
  // Is the finger on something that scrolls sideways (a wide table, chips, a chart)?
  function scrollsX(el, dx) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.matches && n.matches('input, textarea, select, svg, canvas, #subnav, #bottombar, .ov-heat, [data-noswipe]')) return true;
      if (n.scrollWidth > n.clientWidth + 2) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll') {
          if (dx == null) return true;
          if (dx < 0 && n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
          if (dx > 0 && n.scrollLeft > 0) return true;
        }
      }
    }
    return false;
  }

  // ---------- page transitions ----------
  let nextDir = null, prevPage = null;
  function animateIn(page) {
    if (reduced) return;
    const el = document.getElementById(`page-${page}`); if (!el) return;
    let dir = nextDir;
    if (!dir && prevPage) {
      const order = subs().map(b => b.dataset.sub), a = order.indexOf(prevPage), b = order.indexOf(page);
      dir = a >= 0 && b >= 0 ? (b > a ? 'r' : 'l') : 'f';
    }
    nextDir = null;
    el.classList.remove('pg-in-r', 'pg-in-l', 'pg-in-f'); void el.offsetWidth;
    el.classList.add(`pg-in-${dir || 'f'}`);
    setTimeout(() => el.classList.remove('pg-in-r', 'pg-in-l', 'pg-in-f'), 320);
  }
  function hookNav() {
    if (!root.app || app._mmHooked) return !!root.app;
    const orig = app._navigateTo.bind(app);
    app._navigateTo = function (page) {
      const from = app.currentPage; prevPage = from;
      const r = orig(page);
      if (from !== page) animateIn(page);
      return r;
    };
    app._mmHooked = true;
    return true;
  }

  // ---------- swipe between sub-tabs, pull to refresh ----------
  const ptr = document.createElement('div'); ptr.id = 'mm-ptr';
  ptr.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>';
  const edgeL = document.createElement('div'); edgeL.className = 'mm-edge l'; edgeL.innerHTML = '‹<small></small>';
  const edgeR = document.createElement('div'); edgeR.className = 'mm-edge r'; edgeR.innerHTML = '›<small></small>';
  let g = null; // current gesture
  const PULL = 72, SWIPE = 80;
  function topOffset() { const t = document.getElementById('topbar'); return t ? Math.max(0, t.getBoundingClientRect().bottom) : 0; }

  async function refresh() {
    ptr.classList.add('spin'); ptr.classList.remove('ready');
    ptr.style.transition = 'transform .2s'; ptr.style.transform = `translateY(${topOffset() + 14}px)`; ptr.style.opacity = '1';
    haptic('medium');
    const t0 = Date.now();
    try { if (root.app && app.currentPage) await app._navigateTo(app.currentPage); } catch { /* the page shows its own error */ }
    await new Promise(r => setTimeout(r, Math.max(0, 450 - (Date.now() - t0))));
    ptr.classList.remove('spin'); ptr.style.transform = 'translateY(-50px)'; ptr.style.opacity = '0';
  }

  function onStart(e) {
    if (e.touches.length !== 1 || overlayOpen()) { g = null; return; }
    const t = e.touches[0];
    g = { x: t.clientX, y: t.clientY, t: Date.now(), mode: null, target: e.target, el: activePage() };
  }
  function onMove(e) {
    if (!g) return;
    const t = e.touches[0], dx = t.clientX - g.x, dy = t.clientY - g.y;
    if (!g.mode) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.6 && !scrollsX(g.target, dx) && document.getElementById('main-content')?.contains(g.target)) {
        const list = subs(), i = list.findIndex(b => b.classList.contains('active')), nb = list[i + (dx < 0 ? 1 : -1)];
        if (i < 0 || !nb) { g = null; return; }
        g.mode = 'swipe'; g.next = nb; g.dirSign = dx < 0 ? 1 : -1;
        const edge = dx < 0 ? edgeR : edgeL; edge.querySelector('small').textContent = nb.textContent.replace(/\d+$/, '').trim();
      } else if (dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.4 && root.scrollY <= 0 && !g.target.closest('.modal, #ux-drawer, textarea, [data-nopull]')) {
        g.mode = 'pull'; ptr.style.transition = 'none';
      } else { g = null; return; }
    }
    if (g.mode === 'swipe') {
      if (g.el) { g.el.style.transition = 'none'; g.el.style.transform = `translateX(${dx * 0.45}px)`; g.el.style.opacity = String(1 - Math.min(0.35, Math.abs(dx) / 900)); }
      const edge = dx < 0 ? edgeR : edgeL, other = dx < 0 ? edgeL : edgeR;
      edge.style.opacity = String(Math.min(1, Math.abs(dx) / SWIPE)); other.style.opacity = '0';
      if (!g.armed && Math.abs(dx) >= SWIPE) { g.armed = true; haptic('light'); } else if (g.armed && Math.abs(dx) < SWIPE) g.armed = false;
    } else if (g.mode === 'pull') {
      if (e.cancelable) e.preventDefault();
      const d = Math.min(130, dy * 0.5);
      ptr.style.opacity = String(Math.min(1, d / PULL));
      ptr.style.transform = `translateY(${topOffset() - 40 + d}px) rotate(${d * 3.2}deg)`;
      const ready = d >= PULL; if (ready !== !!g.armed) { g.armed = ready; ptr.classList.toggle('ready', ready); if (ready) haptic('light'); }
    }
  }
  function onEnd() {
    if (!g) return;
    const gg = g; g = null;
    if (gg.mode === 'swipe') {
      edgeL.style.opacity = edgeR.style.opacity = '0';
      if (gg.el) { gg.el.style.transition = 'transform .18s, opacity .18s'; gg.el.style.transform = ''; gg.el.style.opacity = ''; setTimeout(() => { gg.el.style.transition = ''; }, 200); }
      if (gg.armed) { nextDir = gg.dirSign > 0 ? 'r' : 'l'; if (gg.el) { gg.el.style.transition = ''; } gg.next.click(); }
    } else if (gg.mode === 'pull') {
      ptr.classList.remove('ready');
      if (gg.armed) refresh();
      else { ptr.style.transition = 'transform .2s, opacity .2s'; ptr.style.transform = 'translateY(-50px)'; ptr.style.opacity = '0'; }
    }
  }

  // ---------- bottom sheets: drag a pop-up down to close it ----------
  let sh = null;
  function closeModal(ov) {
    const x = ov.querySelector('[data-x], .modal-close, [data-close]');
    if (x) x.click(); else ov.classList.add('hidden');
  }
  function sheetStart(e) {
    const m = e.target.closest('#modal-overlay .modal, #account-sheet .sheet-card');
    if (!m || innerWidth > 768 || e.touches.length !== 1) { sh = null; return; }
    const r = m.getBoundingClientRect(), y = e.touches[0].clientY;
    // only from the top strip, or from anywhere when the sheet is scrolled to the top
    if (y - r.top > 56 && (m.scrollTop > 0 || e.target.closest('input, textarea, select, table, .cust-list'))) { sh = null; return; }
    sh = { m, y, dy: 0 };
  }
  function sheetMove(e) {
    if (!sh) return;
    const dy = e.touches[0].clientY - sh.y;
    if (dy <= 0 || sh.m.scrollTop > 0) { sh.m.style.transform = ''; sh.dy = 0; return; }
    sh.dy = dy; sh.m.style.transition = 'none'; sh.m.style.transform = `translateY(${dy}px)`;
    if (e.cancelable) e.preventDefault();
  }
  function sheetEnd() {
    if (!sh) return;
    const { m, dy } = sh; sh = null;
    m.style.transition = 'transform .2s';
    if (dy > 110) {
      m.style.transform = 'translateY(100%)'; haptic('light');
      setTimeout(() => {
        m.style.transform = ''; m.style.transition = '';
        const acc = m.closest('#account-sheet');
        if (acc) { acc.classList.add('hidden'); document.body.classList.remove('sheet-open'); } else closeModal(document.getElementById('modal-overlay'));
      }, 190);
    } else { m.style.transform = ''; setTimeout(() => { m.style.transition = ''; }, 210); }
  }

  // ---------- status bar and browser colour follow the theme ----------
  function syncBars() {
    const bar = document.getElementById('topbar');
    let bg = getComputedStyle(bar || document.body).backgroundColor;
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/\d+(\.\d+)?/g) || [255, 255, 255], [r, gg, b] = m.map(Number);
    const hex = '#' + [r, gg, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    const dark = (0.299 * r + 0.587 * gg + 0.114 * b) < 140;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = hex;
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    if (P.StatusBar) {
      try { P.StatusBar.setBackgroundColor({ color: hex }); P.StatusBar.setStyle({ style: dark ? 'DARK' : 'LIGHT' }); } catch { /* old app */ }
    }
  }
  new MutationObserver(() => requestAnimationFrame(syncBars)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------- push notifications (Android app) ----------
  const PKEY = 'marketmind_push';
  const DEF = { ideas: true, alerts: true, events: true };
  const prefs = () => { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(PKEY)) || {}) }; } catch { return { ...DEF }; } };
  const pushOK = () => !!(P.PushNotifications && (!Cap.isPluginAvailable || Cap.isPluginAvailable('PushNotifications')));
  async function api(action, body) {
    const o = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body) Object.assign(o, { method: 'POST', body: JSON.stringify(body), headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'MarketMind' } });
    const r = await fetch(`api/push.php?action=${action}`, o), j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }
  let token = null, listening = false;
  function listen() {
    if (listening || !pushOK()) return; listening = true;
    const PN = P.PushNotifications;
    PN.addListener('registration', async t => {
      token = t.value;
      try { localStorage.setItem('mm-push-token', token); } catch { /* ignore */ }
      try { await api('register', { token, prefs: prefs(), platform: 'android' }); } catch (e) { console.warn('push register', e); }
    });
    PN.addListener('registrationError', e => toast('Could not turn on notifications: ' + ((e && e.error) || 'unknown'), 'warning'));
    PN.addListener('pushNotificationReceived', n => { haptic('success'); toast(`${n.title || 'MarketMind'}: ${n.body || ''}`, 'info'); });
    PN.addListener('pushNotificationActionPerformed', a => openFrom((a && a.notification && a.notification.data) || {}));
  }
  function openFrom(d) {
    const go = () => {
      if (d.symbol && root.UX && UX.drawer) UX.drawer(d.symbol);
      else if (d.page && root.Nav) Nav.go(d.page);
    };
    if (root.app && app.currentPage) go(); else setTimeout(go, 1500);
  }
  async function enablePush() {
    if (!pushOK()) return false;
    listen();
    let p = await P.PushNotifications.checkPermissions();
    if (p.receive !== 'granted') p = await P.PushNotifications.requestPermissions();
    if (p.receive !== 'granted') { toast('Notifications are blocked. Allow them in Android Settings → Apps → MarketMind.', 'warning'); return false; }
    try { await P.PushNotifications.createChannel({ id: 'market', name: 'Market alerts', description: 'Trade ideas, price alerts, results and dividends', importance: 4, vibration: true }); } catch { /* Android < 8 */ }
    await P.PushNotifications.register();
    return true;
  }
  async function openNotifications() {
    const ov = document.getElementById('modal-overlay');
    let status = null; try { status = await api('status'); } catch { /* signed out */ }
    if (status && status.prefs) try { localStorage.setItem(PKEY, JSON.stringify(status.prefs)); } catch { /* ignore */ }
    const p = prefs();
    const on = !!(status && status.devices > 0);
    const note = !inApp ? '<p class="auth-text">Notifications come to the MarketMind Android app. Install the app, sign in, and turn them on here.</p>'
      : !pushOK() ? '<p class="auth-text">This copy of the app is too old for notifications. Install the latest MarketMind app.</p>'
      : status && !status.server ? '<p class="auth-text">Your phone is ready. The server still needs its Firebase key before messages can be sent; MarketMind will start sending as soon as it is added.</p>' : '';
    const row = (k, t, s) => `<label class="nt-row"><div><b>${t}</b><span>${s}</span></div><span class="nt-sw"><input type="checkbox" data-k="${k}" ${p[k] ? 'checked' : ''}><i></i></span></label>`;
    ov.innerHTML = `<div class="modal"><button class="modal-close" data-x>&times;</button><h3>Notifications</h3>${note}
      <label class="nt-row"><div><b>Notifications on this phone</b><span>${on ? 'On' : 'Off'}${status && status.devices > 1 ? ` · ${status.devices} phones` : ''}</span></div><span class="nt-sw"><input type="checkbox" data-master ${on ? 'checked' : ''} ${inApp && pushOK() ? '' : 'disabled'}><i></i></span></label>
      ${row('ideas', 'Trade ideas', "This morning's swing buys from the scan, before the market opens")}
      ${row('alerts', 'Price alerts', 'The moment an alert you set is hit')}
      ${row('events', 'Results and dividends', 'Watchlist stocks with results, ex-dividend, bonus or split today or tomorrow')}
      <div class="modal-actions"><button class="btn-secondary" data-test ${on ? '' : 'disabled'}>Send a test</button><button class="btn-primary" data-x>Done</button></div></div>`;
    ov.classList.remove('hidden');
    const save = async () => { const q = prefs(); ov.querySelectorAll('[data-k]').forEach(c => (q[c.dataset.k] = c.checked)); try { localStorage.setItem(PKEY, JSON.stringify(q)); } catch { /* ignore */ } try { await api('prefs', { prefs: q }); } catch { /* not registered yet */ } };
    ov.querySelectorAll('[data-k]').forEach(c => (c.onchange = save));
    const m = ov.querySelector('[data-master]');
    if (m) m.onchange = async () => {
      if (m.checked) { const ok = await enablePush(); if (!ok) m.checked = false; else { toast('Notifications on', 'success'); ov.querySelector('[data-test]').disabled = false; } }
      else { try { await api('unregister', { token: token || localStorage.getItem('mm-push-token') }); } catch { /* ignore */ } try { await P.PushNotifications.unregister(); } catch { /* ignore */ } toast('Notifications off'); }
    };
    ov.querySelector('[data-test]').onclick = async () => { try { const r = await api('test', {}); toast(r.sent ? 'Test sent: check your notification bar' : (r.note || 'Not sent'), r.sent ? 'success' : 'warning'); } catch (e) { toast(e.message, 'warning'); } };
    ov.querySelectorAll('[data-x]').forEach(b => (b.onclick = () => { ov.classList.add('hidden'); ov.innerHTML = ''; }));
  }
  function addSheetButton() {
    const body = document.querySelector('#account-sheet .sheet-body');
    if (!body || body.querySelector('.mm-app-btn')) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-secondary mm-app-btn'; b.textContent = '🔔 Notifications';
    b.onclick = () => { document.getElementById('account-sheet').classList.add('hidden'); document.body.classList.remove('sheet-open'); openNotifications(); };
    body.prepend(b);
  }
  // Re-register quietly each time the app opens (tokens can change)
  async function resumePush() {
    if (!inApp || !pushOK()) return;
    try { const p = await P.PushNotifications.checkPermissions(); if (p.receive === 'granted' && localStorage.getItem('mm-push-token')) { listen(); await P.PushNotifications.register(); } else listen(); } catch { /* ignore */ }
  }

  // ---------- start ----------
  function init() {
    document.body.append(ptr, edgeL, edgeR);
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    document.addEventListener('touchstart', sheetStart, { passive: true });
    document.addEventListener('touchmove', sheetMove, { passive: false });
    document.addEventListener('touchend', sheetEnd, { passive: true });
    if (!hookNav()) { const iv = setInterval(() => { if (hookNav()) clearInterval(iv); }, 200); setTimeout(() => clearInterval(iv), 15000); }
    syncBars();
    addSheetButton();
    resumePush();
    if (P.App && P.App.addListener) P.App.addListener('appStateChange', s => { if (s.isActive) syncBars(); });
    if (P.SplashScreen && P.SplashScreen.hide) setTimeout(() => P.SplashScreen.hide(), 150);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  root.Native = { haptic, refresh, notifications: openNotifications, inApp };
})(window);

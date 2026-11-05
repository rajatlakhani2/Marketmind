// MarketMind AI — sign-in, first-time setup, password change, admin user management
// and per-user settings. Talks to api/auth.php and api/users.php.
//
// Account.boot() resolves once someone is signed in (and has a password of their own).
// On a local dev server without PHP it runs in "local dev" mode with no sign-in.
(function () {
  const AUTH = 'api/auth.php';
  const USERS = 'api/users.php';
  // Browser storage keys that follow the user from device to device (server key -> localStorage key)
  const SYNCED = { sizing: 'marketmind_sizing', methodology: 'marketmind_methodology' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

  const state = { user: null, devMode: false };

  async function request(url, body) {
    const opts = { headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-Requested-With'] = 'MarketMind';
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch {
      throw Object.assign(new Error(resp.ok ? 'The server did not answer in the expected format (is PHP enabled?)' : `Server error ${resp.status}`), { status: resp.status, notJson: true });
    }
    if (!resp.ok) throw Object.assign(new Error(json.error || `HTTP ${resp.status}`), { status: resp.status, data: json });
    return json;
  }

  // ---------- full-screen sign-in ----------
  function screen() {
    let el = document.getElementById('auth-screen');
    if (!el) {
      el = document.createElement('div');
      el.id = 'auth-screen';
      document.body.appendChild(el);
    }
    el.classList.remove('hidden');
    document.body.classList.add('auth-open');
    return el;
  }

  function closeScreen() {
    const el = document.getElementById('auth-screen');
    if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
    document.body.classList.remove('auth-open');
  }

  function card(title, subtitle, inner) {
    return `<div class="auth-card">
      <div class="auth-brand">MarketMind <span class="logo-accent">AI</span></div>
      <h2>${esc(title)}</h2>${subtitle ? `<p class="auth-sub">${subtitle}</p>` : ''}
      ${inner}
    </div>`;
  }

  // Wires a form: runs `submit(values)`; shows its error message under the form.
  function bindForm(form, submit) {
    const err = form.querySelector('.auth-error');
    const btn = form.querySelector('button[type="submit"]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const values = Object.fromEntries(new FormData(form).entries());
      btn.disabled = true;
      try { await submit(values); } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
    });
  }

  function showNotConfigured(message) {
    screen().innerHTML = card('Finish the server setup', '', `
      <p class="auth-text">${esc(message || 'MarketMind needs its database settings before anyone can sign in.')}</p>
      <ol class="auth-steps">
        <li>In cPanel → <b>MySQL Databases</b>, create a database and a user, and add the user to the database with <b>All privileges</b>.</li>
        <li>Copy <code>api/marketmind-config.sample.php</code> to <code>marketmind-config.php</code> in the folder <b>above public_html</b>.</li>
        <li>Fill in the database name, user and password, and choose a <code>setup_key</code>.</li>
        <li>Reload this page.</li>
      </ol>
      <button class="btn-primary auth-wide" onclick="location.reload()">Reload</button>`);
  }

  function showSetup() {
    return new Promise((resolve) => {
      screen().innerHTML = card('Create the admin account', 'First-time setup. This account can create logins for other people.', `
        <form class="auth-form" autocomplete="off">
          <label>Setup key<input name="setupKey" type="password" required placeholder="setup_key from marketmind-config.php" /></label>
          <label>Your name<input name="displayName" maxlength="100" placeholder="e.g. Rajat" /></label>
          <label>Username<input name="username" required maxlength="50" autocapitalize="none" autocomplete="username" /></label>
          <label>Password<input name="password" type="password" required minlength="8" autocomplete="new-password" /></label>
          <label>Repeat password<input name="password2" type="password" required minlength="8" autocomplete="new-password" /></label>
          <p class="auth-error"></p>
          <button type="submit" class="btn-primary auth-wide">Create admin and sign in</button>
        </form>`);
      bindForm(document.querySelector('#auth-screen form'), async (v) => {
        if (v.password !== v.password2) throw new Error("The two passwords don't match");
        const r = await request(`${AUTH}?action=setup`, { setupKey: v.setupKey, displayName: v.displayName, username: v.username, password: v.password });
        resolve(r.user);
      });
    });
  }

  function showLogin(note) {
    return new Promise((resolve) => {
      screen().innerHTML = card('Sign in', note ? esc(note) : '', `
        <form class="auth-form">
          <label>Username<input name="username" required maxlength="50" autocapitalize="none" autocomplete="username" /></label>
          <label>Password<input name="password" type="password" required autocomplete="current-password" /></label>
          <label class="auth-check"><input name="remember" type="checkbox" checked /> Keep me signed in on this device</label>
          <p class="auth-error"></p>
          <button type="submit" class="btn-primary auth-wide">Sign in</button>
        </form>`);
      const form = document.querySelector('#auth-screen form');
      form.querySelector('input[name="username"]').focus();
      bindForm(form, async (v) => {
        const r = await request(`${AUTH}?action=login`, { username: v.username, password: v.password, remember: !!v.remember });
        resolve(r.user);
      });
    });
  }

  function passwordForm(prefix) {
    return `<form class="auth-form">
      <label>${prefix}<input name="currentPassword" type="password" required autocomplete="current-password" /></label>
      <label>New password<input name="newPassword" type="password" required minlength="8" autocomplete="new-password" /></label>
      <label>Repeat new password<input name="newPassword2" type="password" required minlength="8" autocomplete="new-password" /></label>
      <p class="auth-error"></p>
      <button type="submit" class="btn-primary auth-wide">Save new password</button>
    </form>`;
  }

  async function changePassword(v) {
    if (v.newPassword !== v.newPassword2) throw new Error("The two new passwords don't match");
    const r = await request(`${AUTH}?action=change_password`, { currentPassword: v.currentPassword, newPassword: v.newPassword });
    return r.user;
  }

  function showForcedPasswordChange() {
    return new Promise((resolve) => {
      screen().innerHTML = card('Choose your own password', 'The admin gave you a temporary password. Pick a new one to continue.', passwordForm('Temporary password'));
      bindForm(document.querySelector('#auth-screen form'), async (v) => resolve(await changePassword(v)));
    });
  }

  // ---------- modal helpers (uses the app's #modal-overlay) ----------
  function openModal(html) {
    const ov = document.getElementById('modal-overlay');
    ov.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
    ov.classList.remove('hidden');
    ov.onclick = (e) => { if (e.target === ov) closeModal(); };
    ov.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
    return ov.firstElementChild;
  }

  function closeModal() {
    const ov = document.getElementById('modal-overlay');
    ov.classList.add('hidden');
    ov.innerHTML = '';
  }

  function toast(msg, type) {
    if (window.app && app.ui) app.ui._toast(msg, type);
  }

  function openChangePassword() {
    const m = openModal(`<button class="modal-close" data-close>&times;</button><h3>Change password</h3>${passwordForm('Current password')}
      <p class="auth-text">Other devices signed in to your account will be signed out.</p>`);
    bindForm(m.querySelector('form'), async (v) => {
      state.user = await changePassword(v);
      closeModal();
      toast('Password changed', 'success');
    });
  }

  // ---------- admin: users ----------
  function fmtDate(s) {
    if (!s) return 'never';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function tempPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(12);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => chars[n % chars.length]).join('');
  }

  async function openUsers() {
    const m = openModal(`<button class="modal-close" data-close>&times;</button><h3>Users</h3><div id="users-body"><p class="auth-text">Loading…</p></div>`);
    m.classList.add('modal-wide');
    await renderUsers();
  }

  async function renderUsers() {
    const body = document.getElementById('users-body');
    if (!body) return;
    let users;
    try { users = (await request(`${USERS}?action=list`)).users; } catch (e) { body.innerHTML = `<p class="auth-error">${esc(e.message)}</p>`; return; }
    const me = state.user.id;
    body.innerHTML = `
      <div class="users-list">${users.map((u) => `
        <div class="user-row${u.isActive ? '' : ' off'}" data-id="${u.id}">
          <div class="user-main">
            <div><b>${esc(u.displayName)}</b> <span class="text-muted">@${esc(u.username)}</span>
              ${u.role === 'admin' ? '<span class="user-badge admin">Admin</span>' : ''}
              ${u.isActive ? '' : '<span class="user-badge">Switched off</span>'}
              ${u.mustChangePassword ? '<span class="user-badge warn">Temp password</span>' : ''}
              ${u.id === me ? '<span class="user-badge you">You</span>' : ''}</div>
            <div class="text-muted user-meta">Last sign-in: ${esc(fmtDate(u.lastLoginAt))}</div>
          </div>
          ${u.id === me ? '' : `<div class="user-actions">
            <button class="btn-secondary btn-small" data-act="reset">Reset password</button>
            <button class="btn-secondary btn-small" data-act="toggle">${u.isActive ? 'Switch off' : 'Switch on'}</button>
            <button class="btn-secondary btn-small" data-act="role">${u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
            <button class="btn-danger btn-small" data-act="delete">Delete</button>
          </div>`}
        </div>`).join('')}
      </div>
      <h4 class="users-sub">Add a user</h4>
      <form class="auth-form users-add" autocomplete="off">
        <div class="users-grid">
          <label>Name<input name="displayName" maxlength="100" placeholder="e.g. Amit" /></label>
          <label>Username<input name="username" required maxlength="50" autocapitalize="none" placeholder="e.g. amit" /></label>
          <label>Temporary password<input name="password" required minlength="8" value="${tempPassword()}" /></label>
          <label>Role<select name="role"><option value="user">User</option><option value="admin">Admin</option></select></label>
        </div>
        <p class="auth-text">They sign in with this temporary password and must choose their own straight away. Share it privately.</p>
        <p class="auth-error"></p>
        <button type="submit" class="btn-primary">Add user</button>
      </form>`;

    bindForm(body.querySelector('form'), async (v) => {
      const r = await request(`${USERS}?action=create`, v);
      toast(`Added ${r.user.username} — temporary password: ${v.password}`, 'success');
      await renderUsers();
    });

    body.querySelectorAll('.user-row').forEach((row) => {
      const id = Number(row.dataset.id);
      const u = users.find((x) => x.id === id);
      row.querySelectorAll('[data-act]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            const act = btn.dataset.act;
            if (act === 'reset') {
              const pw = prompt(`New temporary password for ${u.username} (at least 8 characters):`, tempPassword());
              if (!pw) return;
              await request(`${USERS}?action=reset_password`, { id, password: pw });
              toast(`Password reset. ${u.username} must choose a new one at next sign-in.`, 'success');
            } else if (act === 'toggle') {
              await request(`${USERS}?action=update`, { id, isActive: !u.isActive });
            } else if (act === 'role') {
              await request(`${USERS}?action=update`, { id, role: u.role === 'admin' ? 'user' : 'admin' });
            } else if (act === 'delete') {
              if (!confirm(`Delete ${u.username}? Their saved settings are removed too. This can't be undone.`)) return;
              await request(`${USERS}?action=delete`, { id });
              toast(`Deleted ${u.username}`, 'success');
            }
            await renderUsers();
          } catch (e) { toast(e.message, 'error'); }
        };
      });
    });
  }

  // ---------- sidebar account block ----------
  function renderMenu() {
    const el = document.getElementById('account-menu');
    if (!el || !state.user) return;
    const u = state.user;
    if (state.devMode) {
      el.innerHTML = `<div class="account-name">Local dev mode</div><div class="account-role">No sign-in on the dev server</div>`;
      return;
    }
    el.innerHTML = `
      <div class="account-name" title="@${esc(u.username)}">${esc(u.displayName)}${u.role === 'admin' ? ' <span class="user-badge admin">Admin</span>' : ''}</div>
      <div class="account-links">
        ${u.role === 'admin' ? '<a href="#" data-acc="users">Users</a>' : ''}
        <a href="#" data-acc="password">Password</a>
        <a href="#" data-acc="logout">Sign out</a>
      </div>`;
    el.querySelectorAll('[data-acc]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        const act = a.dataset.acc;
        if (act === 'users') openUsers();
        else if (act === 'password') openChangePassword();
        else if (act === 'logout') logout();
      };
    });
  }

  async function logout() {
    try { await request(`${AUTH}?action=logout`, {}); } catch { /* signed out anyway */ }
    Object.values(SYNCED).forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
    location.reload();
  }

  // ---------- per-user settings ----------
  async function loadSettings() {
    if (state.devMode) return;
    let settings = {};
    try { settings = (await request(`${AUTH}?action=settings`)).settings || {}; } catch { return; }
    // Server copy wins. Signing out clears these keys, so a value that is only in this
    // browser was saved before sign-in existed: keep it and copy it to the account.
    for (const [key, lsKey] of Object.entries(SYNCED)) {
      try {
        if (key in settings) localStorage.setItem(lsKey, JSON.stringify(settings[key]));
        else {
          const local = localStorage.getItem(lsKey);
          if (local) request(`${AUTH}?action=save_setting`, { key, value: JSON.parse(local) }).catch(() => {});
        }
      } catch { /* ignore */ }
    }
  }

  const pending = {};
  // Called when the app stores one of the synced values; saves it to the server shortly after.
  function saveSetting(lsKey, value) {
    if (state.devMode || !state.user) return;
    const key = Object.keys(SYNCED).find((k) => SYNCED[k] === lsKey);
    if (!key) return;
    clearTimeout(pending[key]);
    pending[key] = setTimeout(() => {
      request(`${AUTH}?action=save_setting`, { key, value }).catch((e) => console.warn('Could not save setting', key, e));
    }, 800);
  }

  // ---------- boot ----------
  async function boot() {
    let st;
    try {
      st = await request(`${AUTH}?action=status`);
    } catch (e) {
      if (isLocalHost && (e.notJson || e.status === 404)) {
        state.devMode = true;
        state.user = { id: 0, username: 'dev', displayName: 'Local dev', role: 'admin' };
        return state.user;
      }
      if (e.data && e.data.configured === false) { showNotConfigured(e.message); return new Promise(() => {}); }
      if (e.data && e.data.dbOk === false) { showNotConfigured(e.message); return new Promise(() => {}); }
      screen().innerHTML = card("Can't reach the server", '', `<p class="auth-text">${esc(e.message)}</p><button class="btn-primary auth-wide" onclick="location.reload()">Try again</button>`);
      return new Promise(() => {});
    }
    if (!st.configured) { showNotConfigured(); return new Promise(() => {}); }

    let user = st.user;
    if (st.needsSetup) user = await showSetup();
    else if (!st.loggedIn) user = await showLogin();
    if (user.mustChangePassword) user = await showForcedPasswordChange();
    state.user = user;
    await loadSettings();
    closeScreen();
    return user;
  }

  // A data request found the sign-in had ended (signed out elsewhere, switched off, expired).
  let reauthOpen = false;
  window.addEventListener('mm:auth-required', async () => {
    if (state.devMode || reauthOpen) return;
    reauthOpen = true;
    await showLogin('Your session ended. Sign in again to continue.');
    location.reload();
  });

  window.Account = {
    boot, renderMenu, saveSetting, openUsers, openChangePassword, logout,
    get user() { return state.user; },
    get isAdmin() { return !!state.user && state.user.role === 'admin'; },
    get devMode() { return state.devMode; },
  };
})();

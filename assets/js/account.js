// MarketMind AI — sign-in, first-time setup, password change, admin user management
// and per-user settings. Talks to api/auth.php and api/users.php.
//
// Account.boot() resolves once someone is signed in (and has a password of their own).
// On a local dev server without PHP it runs in "local dev" mode with no sign-in.
(function () {
  const AUTH = 'api/auth.php';
  const USERS = 'api/users.php';
  // Browser storage keys that follow the user from device to device (server key -> localStorage key)
  const SYNCED = { sizing: 'marketmind_sizing', methodology: 'marketmind_methodology', home_layout: 'marketmind_home_layout', nav_layout: 'marketmind_nav_layout', theme: 'marketmind_theme' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

  const state = { user: null, devMode: false, signupOpen: false };

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

  function showLogin(note, noteIsHtml) {
    return new Promise((resolve) => {
      screen().innerHTML = card('Sign in', note ? (noteIsHtml ? note : esc(note)) : '', `
        <form class="auth-form">
          <label>Username<input name="username" required maxlength="50" autocapitalize="none" autocomplete="username" /></label>
          <label>Password<input name="password" type="password" required autocomplete="current-password" /></label>
          <label class="auth-check"><input name="remember" type="checkbox" checked /> Keep me signed in on this device</label>
          <p class="auth-error"></p>
          <button type="submit" class="btn-primary auth-wide">Sign in</button>
        </form>
        ${state.signupOpen ? '<p class="auth-text auth-switch">New here? <a href="#" id="auth-to-signup">Create an account</a></p>' : ''}`);
      const form = document.querySelector('#auth-screen form');
      form.querySelector('input[name="username"]').focus();
      const link = document.getElementById('auth-to-signup');
      if (link) link.onclick = (e) => { e.preventDefault(); showSignup().then(resolve); };
      bindForm(form, async (v) => {
        const r = await request(`${AUTH}?action=login`, { username: v.username, password: v.password, remember: !!v.remember });
        resolve(r.user);
      });
    });
  }

  // Ask for an account. It works only after the admin approves it, so this goes back to the sign-in screen.
  function showSignup() {
    return new Promise((resolve) => {
      screen().innerHTML = card('Create an account', 'The admin checks every new account. You can sign in once it is approved.', `
        <form class="auth-form" autocomplete="off">
          <label>Your name<input name="displayName" required maxlength="100" placeholder="e.g. Amit Shah" /></label>
          <label>Mobile or email <span class="text-muted">(so the admin knows who you are)</span><input name="contact" maxlength="120" /></label>
          <label>Username<input name="username" required maxlength="50" autocapitalize="none" autocomplete="username" placeholder="letters, numbers, . _ -" /></label>
          <label>Password<input name="password" type="password" required minlength="8" autocomplete="new-password" /></label>
          <label>Repeat password<input name="password2" type="password" required minlength="8" autocomplete="new-password" /></label>
          <input name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;height:0;opacity:0" />
          <p class="auth-error"></p>
          <button type="submit" class="btn-primary auth-wide">Send request</button>
        </form>
        <p class="auth-text auth-switch">Already have an account? <a href="#" id="auth-to-login">Sign in</a></p>`);
      document.getElementById('auth-to-login').onclick = (e) => { e.preventDefault(); showLogin().then(resolve); };
      const form = document.querySelector('#auth-screen form');
      form.querySelector('input[name="displayName"]').focus();
      bindForm(form, async (v) => {
        if (v.password !== v.password2) throw new Error("The two passwords don't match");
        await request(`${AUTH}?action=register`, { displayName: v.displayName, contact: v.contact, username: v.username, password: v.password, website: v.website });
        showLogin(`<span class="auth-ok">Request sent. You can sign in as <b>${esc(String(v.username).toLowerCase())}</b> once the admin approves your account.</span>`, true).then(resolve);
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
    const m = openModal(`<button class="modal-close" data-close>&times;</button><h3>Users</h3><div id="users-body"><p class="auth-text">Loading…</p></div>
      <h4 class="users-sub">Stock list</h4><div id="stocks-admin"><p class="auth-text">Loading…</p></div>
      <h4 class="users-sub">System health</h4><div id="sys-health"><p class="auth-text">Checking…</p></div>`);
    m.classList.add('modal-wide');
    renderStockAdmin();
    health();
    await renderUsers();
  }

  // ---------- admin: system health (each data source answers, and how fast) ----------
  async function health() {
    const el = document.getElementById('sys-health');
    if (!el) return;
    const checks = [
      ['Database and sign-in', 'api/auth.php?action=status', (x) => (x.dbOk ? `ok · sign-ups ${x.signupOpen ? 'open' : 'closed'}` : 'database not reachable')],
      ['Prices (Yahoo)', 'api/chart.php?symbol=%5ENSEI&interval=1d&range=5d', (x) => (x.chart && x.chart.result ? 'ok' : 'no data')],
      ['ICICI main account', 'api/breeze.php?action=status', (x) => (!x.configured ? 'not set up' : x.loggedIn ? 'logged in today' : 'not logged in today')],
      ['NSE calendar', 'api/events.php?action=calendar', (x) => `ok · ${(x.meetings || []).length} meetings`],
      ['Market overview', 'api/overview.php?action=market', (x) => `ok · ${(x.rows || []).length} stocks`],
      ['Daily scan', 'api/scan.php?action=latest', (x) => (x.date ? `last run ${x.date}` : 'no scan yet')],
    ];
    el.innerHTML = '<ul class="users-list">' + checks.map(([n], i) => `<li class="user-row"><div class="user-main"><b>${esc(n)}</b> <span class="text-muted" id="hc-${i}">checking…</span></div></li>`).join('') + '</ul>';
    checks.forEach(async ([, url, fmt], i) => {
      const t0 = performance.now(), out = document.getElementById('hc-' + i);
      try { const x = await request(url); out.innerHTML = `<span class="text-green">✓ ${esc(fmt(x))}</span> · ${Math.round(performance.now() - t0)} ms`; }
      catch (e) { out.innerHTML = `<span class="text-red">✗ ${esc(e.message)}</span>`; }
    });
  }

  // ---------- admin: NSE + BSE stock list ----------
  async function refreshStocks() {
    const r = await request('api/stocks.php?action=refresh', {});
    return r;
  }

  async function renderStockAdmin() {
    const el = document.getElementById('stocks-admin');
    if (!el) return;
    let info;
    try { info = await request('api/stocks.php?action=info'); } catch (e) { el.innerHTML = `<p class="auth-error">${esc(e.message)}</p>`; return; }
    const last = info.lastRefresh;
    el.innerHTML = `<p class="auth-text"><b>${info.nse.toLocaleString('en-IN')}</b> NSE and <b>${info.bse.toLocaleString('en-IN')}</b> BSE stocks listed.
        ${last ? `Last updated ${esc(fmtDate(last.at))} from ${esc(last.source)}.` : 'Not downloaded yet.'}
        The list also refreshes itself every week.</p>
      <p class="auth-error"></p>
      <button class="btn-secondary" id="btn-refresh-stocks">Refresh stock list now</button>`;
    const btn = el.querySelector('#btn-refresh-stocks');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Downloading… (up to a minute)';
      try {
        const r = await refreshStocks();
        toast(`Stock list updated: ${r.nse} NSE, ${r.bse} BSE`, 'success');
        renderStockAdmin();
      } catch (e) {
        el.querySelector('.auth-error').textContent = e.message;
        btn.disabled = false; btn.textContent = 'Try again';
      }
    };
  }

  // Admin: show how many sign-up requests are waiting, next to "Users" and as a reminder.
  async function checkWaiting() {
    if (state.devMode || !state.user || state.user.role !== 'admin') return;
    try {
      const users = (await request(`${USERS}?action=list`)).users;
      const n = users.filter((u) => u.approvalStatus === 'pending').length;
      if (n !== state.waiting) { state.waiting = n; renderMenu(); }
      if (n) toast(`${n} new account request${n > 1 ? 's are' : ' is'} waiting for approval (Users)`, 'info');
    } catch { /* not important */ }
  }

  // First time an admin signs in, load the stock list in the background.
  async function ensureStockList() {
    if (state.devMode || !state.user || state.user.role !== 'admin') return;
    checkWaiting();
    try {
      const info = await request('api/stocks.php?action=info');
      if (info.nse + info.bse > 0) return;
      toast('Downloading the full NSE + BSE stock list…', 'info');
      const r = await refreshStocks();
      toast(`Stock list ready: ${r.nse} NSE and ${r.bse} BSE stocks`, 'success');
    } catch (e) {
      toast('Could not download the stock list: ' + e.message, 'warning');
    }
  }

  async function renderUsers() {
    const body = document.getElementById('users-body');
    if (!body) return;
    let users;
    try { users = (await request(`${USERS}?action=list`)).users; } catch (e) { body.innerHTML = `<p class="auth-error">${esc(e.message)}</p>`; return; }
    const me = state.user.id;
    const waiting = users.filter((u) => u.approvalStatus === 'pending');
    if (waiting.length !== state.waiting) { state.waiting = waiting.length; renderMenu(); }
    users = users.filter((u) => u.approvalStatus !== 'pending');
    body.innerHTML = `
      ${waiting.length ? `<h4 class="users-sub">Waiting for approval (${waiting.length})</h4>
      <div class="users-list">${waiting.map((u) => `
        <div class="user-row pending" data-id="${u.id}">
          <div class="user-main">
            <div><b>${esc(u.displayName)}</b> <span class="text-muted">@${esc(u.username)}</span> <span class="user-badge warn">New request</span></div>
            <div class="text-muted user-meta">${u.contact ? esc(u.contact) + ' · ' : ''}Asked ${esc(fmtDate(u.createdAt))}</div>
          </div>
          <div class="user-actions">
            <button class="btn-primary btn-small" data-act="approve">Approve</button>
            <button class="btn-secondary btn-small" data-act="reject">Reject</button>
          </div>
        </div>`).join('')}
      </div><h4 class="users-sub">Accounts</h4>` : ''}
      <div class="users-list">${users.map((u) => `
        <div class="user-row${u.isActive ? '' : ' off'}" data-id="${u.id}">
          <div class="user-main">
            <div><b>${esc(u.displayName)}</b> <span class="text-muted">@${esc(u.username)}</span>
              ${u.role === 'admin' ? '<span class="user-badge admin">Admin</span>' : ''}
              ${u.approvalStatus === 'rejected' ? '<span class="user-badge">Rejected</span>' : u.isActive ? '' : '<span class="user-badge">Switched off</span>'}
              ${u.mustChangePassword ? '<span class="user-badge warn">Temp password</span>' : ''}
              ${u.id === me ? '<span class="user-badge you">You</span>' : ''}</div>
            <div class="text-muted user-meta">${u.contact ? esc(u.contact) + ' · ' : ''}Last sign-in: ${esc(fmtDate(u.lastLoginAt))}</div>
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
          <label>Password<input name="password" required minlength="8" value="${tempPassword()}" /></label>
          <label>Role<select name="role"><option value="user">User</option><option value="admin">Admin</option></select></label>
        </div>
        <label class="auth-check"><input type="checkbox" name="mustChange" value="1" /> Make them choose their own password at first sign-in</label>
        <p class="auth-text">Leave it unticked to keep this password (for example a test account). Share it privately.</p>
        <p class="auth-error"></p>
        <button type="submit" class="btn-primary">Add user</button>
      </form>`;

    bindForm(body.querySelector('form'), async (v) => {
      const r = await request(`${USERS}?action=create`, { ...v, mustChange: !!v.mustChange });
      toast(`Added ${r.user.username} with password: ${v.password}${v.mustChange ? ' (must change it at first sign-in)' : ''}`, 'success');
      await renderUsers();
    });

    const everyone = users.concat(waiting);
    body.querySelectorAll('.user-row').forEach((row) => {
      const id = Number(row.dataset.id);
      const u = everyone.find((x) => x.id === id);
      row.querySelectorAll('[data-act]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            const act = btn.dataset.act;
            if (act === 'approve') {
              await request(`${USERS}?action=approve`, { id });
              toast(`Approved ${u.username}. They can sign in now.`, 'success');
            } else if (act === 'reject') {
              if (!confirm(`Reject ${u.displayName} (@${u.username})? They won't be able to sign in. You can delete the request later.`)) return;
              await request(`${USERS}?action=reject`, { id });
              toast(`Rejected ${u.username}`, 'success');
            } else if (act === 'reset') {
              const pw = prompt(`New password for ${u.username} (at least 8 characters):`, tempPassword());
              if (!pw) return;
              const mustChange = confirm(`Should ${u.username} have to choose their own password at next sign-in?\n\nOK = yes, make them change it\nCancel = no, keep "${pw}"`);
              await request(`${USERS}?action=reset_password`, { id, password: pw, mustChange });
              toast(mustChange ? `Password reset. ${u.username} must choose a new one at next sign-in.` : `Password reset. ${u.username} can keep using it.`, 'success');
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

  // ---------- broker accounts (each user's own) ----------
  const BROKERS_API = 'api/brokers.php';
  const REDIRECT_URL = new URL('api/breeze.php', location.href).href;

  async function openBrokers() {
    const m = openModal(`<button class="modal-close" data-close>&times;</button><h3>Broker accounts</h3>
      <p class="auth-text">Connect your own broker accounts to see holdings and P&amp;L in MarketMind. Each account needs a daily log-in (an exchange rule). Only you can use the accounts you add.</p>
      <div id="brokers-body"><p class="auth-text">Loading…</p></div>`);
    m.classList.add('modal-wide');
    await renderBrokers();
  }

  async function renderBrokers() {
    const body = document.getElementById('brokers-body');
    if (!body) return;
    let d;
    try { d = await request(`${BROKERS_API}?action=list`); } catch (e) { body.innerHTML = `<p class="auth-error">${esc(e.message)}</p>`; return; }
    const status = (a) => a.connectedToday
      ? `<span class="user-badge you">Connected today${a.brokerUser ? ' · ' + esc(a.brokerUser) : ''}</span>`
      : '<span class="user-badge warn">Log in needed today</span>';
    body.innerHTML = `
      <div class="users-list">
        ${d.main ? `<div class="user-row"><div class="user-main"><div><b>ICICI Direct · main</b> <span class="text-muted">server settings (breeze-config.php)</span> ${status(d.main)}</div>
          <div class="text-muted user-meta">Market data for everyone and your trading come from this account.</div></div>
          <div class="user-actions"><a class="btn-secondary btn-small" href="api/breeze.php?action=login">Log in today</a></div></div>` : ''}
        ${d.accounts.map((a) => `<div class="user-row" data-id="${a.id}">
          <div class="user-main"><div><b>${esc(a.label)}</b> <span class="text-muted">${esc(a.brokerName)} · key …${esc(a.apiKeyEnd)}</span> ${status(a)}</div>
            ${a.lastError ? `<div class="auth-error user-meta">${esc(a.lastError)}</div>` : ''}</div>
          <div class="user-actions">
            <a class="btn-primary btn-small" href="${BROKERS_API}?action=login&id=${a.id}">Log in today</a>
            <button class="btn-secondary btn-small" data-act="holdings">Holdings</button>
            <button class="btn-secondary btn-small" data-act="edit">Edit</button>
            ${a.connectedToday ? '<button class="btn-secondary btn-small" data-act="logout">Log out</button>' : ''}
            <button class="btn-danger btn-small" data-act="delete">Remove</button>
          </div></div>`).join('') || (d.main ? '' : '<p class="auth-text">No broker accounts yet.</p>')}
      </div>
      <h4 class="users-sub" id="broker-form-title">Add an account</h4>
      <form class="auth-form users-add" autocomplete="off">
        <input type="hidden" name="acctId" value="" />
        <div class="users-grid">
          <label>Broker<select name="broker">
            ${Object.entries(d.brokers).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}
            <option disabled>Zerodha (coming next)</option><option disabled>Groww (coming soon)</option>
            <option disabled>Upstox (coming soon)</option><option disabled>Angel One (coming soon)</option>
          </select></label>
          <label>Name for this account<input name="label" maxlength="60" placeholder="e.g. ICICI · Mom" /></label>
          <label>API key<input name="apiKey" maxlength="120" autocapitalize="none" spellcheck="false" /></label>
          <label>API secret<input name="secret" type="password" maxlength="200" autocomplete="new-password" spellcheck="false" /></label>
        </div>
        <details class="auth-text"><summary>How to get an ICICI API key and secret</summary>
          <ol class="auth-steps">
            <li>The account holder signs in at <b>api.icicidirect.com</b> with their own ICICI login.</li>
            <li>Choose <b>Register an App</b> and give it any name.</li>
            <li>Set the redirect URL to <code>${esc(REDIRECT_URL)}</code></li>
            <li>Copy the <b>API key</b> and <b>secret</b> it shows into this form.</li>
          </ol>
          The secret is stored encrypted on the MarketMind server and is never shown again.</details>
        <p class="auth-error"></p>
        <button type="submit" class="btn-primary">Add account</button>
        <button type="button" class="btn-secondary hidden" id="broker-cancel-edit">Cancel</button>
      </form>`;

    const form = body.querySelector('form');
    const title = body.querySelector('#broker-form-title');
    const cancel = body.querySelector('#broker-cancel-edit');
    const submitBtn = form.querySelector('button[type="submit"]');
    const resetForm = () => {
      form.reset(); form.elements.acctId.value = ''; title.textContent = 'Add an account'; submitBtn.textContent = 'Add account';
      form.elements.broker.disabled = false; form.elements.apiKey.placeholder = ''; form.elements.secret.placeholder = ''; cancel.classList.add('hidden');
    };
    cancel.onclick = resetForm;
    bindForm(form, async (v) => {
      if (v.acctId) {
        await request(`${BROKERS_API}?action=update`, { id: Number(v.acctId), label: v.label, apiKey: v.apiKey, secret: v.secret });
        toast('Account updated', 'success');
      } else {
        if (!v.apiKey || !v.secret) throw new Error('Enter both the API key and the API secret');
        const r = await request(`${BROKERS_API}?action=add`, { broker: v.broker, label: v.label, apiKey: v.apiKey, secret: v.secret });
        toast(`Added ${r.account.label}. Click "Log in today" to connect it.`, 'success');
      }
      await renderBrokers();
    });

    body.querySelectorAll('.user-row[data-id]').forEach((row) => {
      const id = Number(row.dataset.id);
      const a = d.accounts.find((x) => x.id === id);
      row.querySelectorAll('[data-act]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            const act = btn.dataset.act;
            if (act === 'edit') {
              form.elements.acctId.value = id; form.elements.label.value = a.label; form.elements.broker.value = a.broker; form.elements.broker.disabled = true;
              form.elements.apiKey.value = ''; form.elements.apiKey.placeholder = `…${a.apiKeyEnd} (leave blank to keep)`;
              form.elements.secret.value = ''; form.elements.secret.placeholder = 'leave blank to keep the saved secret';
              title.textContent = `Edit ${a.label}`; submitBtn.textContent = 'Save'; cancel.classList.remove('hidden');
              form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              return;
            }
            if (act === 'holdings') {
              try { localStorage.setItem('mm_holdings_account', String(id)); } catch { /* ignore */ }
              closeModal();
              if (window.app && app._navigateTo) app._navigateTo('holdings');
              return;
            }
            if (act === 'logout') await request(`${BROKERS_API}?action=logout`, { id });
            if (act === 'delete') {
              if (!confirm(`Remove ${a.label} from MarketMind? Its saved key and secret are deleted here (your broker account itself is not affected).`)) return;
              await request(`${BROKERS_API}?action=delete`, { id });
              toast(`Removed ${a.label}`, 'success');
            }
            await renderBrokers();
          } catch (e) { toast(e.message, 'error'); }
        };
      });
    });
  }

  // Coming back from a broker's login page
  function brokerReturnNotice() {
    const m = /^#broker=(\w+)/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    const msg = { connected: ['Broker account connected for today', 'success'], failed: ['The broker login did not finish. Open Broker accounts to see the error and try again.', 'error'], badcode: ["That doesn't look like a broker session code. Try logging in again.", 'error'] }[m[1]];
    if (msg) setTimeout(() => toast(msg[0], msg[1]), 1500);
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
        ${u.role === 'admin' ? `<a href="#" data-acc="users">Users${state.waiting ? ` <span class="user-badge warn">${state.waiting} new</span>` : ''}</a>` : ''}
        <a href="#" data-acc="brokers">Broker accounts</a>
        <a href="#" data-acc="layout">Tabs &amp; theme</a>
        <a href="#" data-acc="password">Password</a>
        <a href="#" data-acc="logout">Sign out</a>
      </div>`;
    el.querySelectorAll('[data-acc]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        const act = a.dataset.acc;
        if (act === 'users') openUsers();
        else if (act === 'brokers') openBrokers();
        else if (act === 'layout') { if (window.Nav && Nav.customize) Nav.customize(); }
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

    state.signupOpen = !!st.signupOpen;
    let user = st.user;
    if (st.needsSetup) user = await showSetup();
    else if (!st.loggedIn) user = await showLogin();
    if (user.mustChangePassword) user = await showForcedPasswordChange();
    state.user = user;
    await loadSettings();
    closeScreen();
    brokerReturnNotice();
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
    boot, renderMenu, saveSetting, openUsers, openChangePassword, openBrokers, logout, ensureStockList, request,
    get user() { return state.user; },
    get isAdmin() { return !!state.user && state.user.role === 'admin'; },
    get devMode() { return state.devMode; },
  };
})();

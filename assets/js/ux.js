// MarketMind AI — interaction layer: stock drawer (tap any symbol), position-size calculator, swipe between tabs,
// pull to refresh, long-press tips, offline notice, undo toasts, number flashes, voice summary, snapshot,
// pre-market checklist.
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n2 = v => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
  const toast = (m, t) => root.app && app.ui && app.ui._toast(m, t || 'info');
  async function j(url, body) {
    const o = { headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (body) Object.assign(o, { method: 'POST', body: JSON.stringify(body), headers: { ...o.headers, 'Content-Type': 'application/json', 'X-Requested-With': 'MarketMind' } });
    const r = await fetch(url, o); const x = await r.json().catch(() => null);
    if (!r.ok || !x) throw new Error((x && x.error) || `HTTP ${r.status}`);
    return x;
  }

  // ---------- stock drawer ----------
  function spark(c) {
    if (c.length < 2) return '';
    const lo = Math.min(...c), hi = Math.max(...c), w = 300, h = 70, x = i => i / (c.length - 1) * w, y = v => h - (v - lo) / (hi - lo || 1) * h;
    return `<svg viewBox="0 0 ${w} ${h}" class="dr-spark"><polyline fill="none" stroke="${c[c.length - 1] >= c[0] ? 'var(--green)' : 'var(--red)'}" stroke-width="2" points="${c.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/></svg>`;
  }
  async function drawer(sym) {
    sym = String(sym || '').toUpperCase().replace(/\.NS$/, '');
    let d = document.getElementById('ux-drawer');
    if (!d) { d = document.createElement('aside'); d.id = 'ux-drawer'; document.body.appendChild(d); }
    d.innerHTML = `<div class="dr-head"><b>${esc(sym)}</b><button class="modal-close" data-close>&times;</button></div><p class="muted">Loading…</p>`;
    d.classList.add('open');
    d.querySelector('[data-close]').onclick = () => d.classList.remove('open');
    let c = [], last = null, prev = null, atr = null, raw = null;
    try {
      const x = await j(`api/chart.php?symbol=${encodeURIComponent(/^\d{6}$/.test(sym) ? sym + '.BO' : sym + '.NS')}&interval=1d&range=2y`);
      raw = x;
      const r = x.chart.result[0], q = r.indicators.quote[0];
      c = (q.close || []).filter(v => v != null);
      last = r.meta.regularMarketPrice || c[c.length - 1]; prev = c[c.length - 2];
      let s = 0, k = 0; for (let i = Math.max(1, q.close.length - 14); i < q.close.length; i++) if (q.high[i] != null && q.close[i - 1] != null) { s += Math.max(q.high[i] - q.low[i], Math.abs(q.high[i] - q.close[i - 1]), Math.abs(q.low[i] - q.close[i - 1])); k++; }
      atr = k ? s / k : null;
    } catch (e) { d.querySelector('p').textContent = 'Could not load prices: ' + e.message; }
    const ch = last && prev ? (last / prev - 1) * 100 : null;
    let sz = {}; try { sz = JSON.parse(localStorage.getItem('marketmind_sizing')) || {}; } catch { /* default */ }
    const cap = +sz.capital || +sz.account || 100000, rp = +sz.riskPercent || +sz.risk || 1;
    const stop0 = last && atr ? +(last - 2 * atr).toFixed(2) : '';
    d.innerHTML = `<div class="dr-head"><b>${esc(sym)}</b><button class="modal-close" data-close>&times;</button></div>
      <div class="dr-price"><b>₹${n2(last)}</b> <span class="${ch >= 0 ? 'up' : 'down'}">${ch == null ? '' : (ch > 0 ? '+' : '') + ch.toFixed(2) + '%'}</span></div>
      ${spark(c.slice(-63))}<p class="muted dr-sub">3 months · ATR(14) ₹${n2(atr)}</p>
      <div data-why></div>
      <div class="dr-actions"><button class="btn-primary btn-small" data-open>Open stock page</button><button class="btn-secondary btn-small" data-watch>+ Watchlist</button></div>
      <h4>Alert me when</h4>
      <div class="dr-alert"><select data-ak><option value="above">price rises above</option><option value="below">price falls below</option><option value="rsi_below">RSI falls below</option><option value="rsi_above">RSI rises above</option><option value="ma200_up">crosses above 200-DMA</option><option value="ma200_down">crosses below 200-DMA</option></select>
        <input type="number" step="0.05" data-av value="${last ? (last * 1.05).toFixed(2) : ''}"><button class="btn-secondary btn-small" data-aadd>Set</button></div>
      <h4>Position size</h4>
      <div class="dr-calc"><label>Capital ₹<input type="number" data-cap value="${cap}"></label><label>Risk %<input type="number" step="0.1" data-rp value="${rp}"></label>
        <label>Entry<input type="number" step="0.05" data-en value="${last ? last.toFixed(2) : ''}"></label><label>Stop<input type="number" step="0.05" data-st value="${stop0}"></label></div>
      <p class="dr-out" data-out></p>`;
    d.querySelector('[data-close]').onclick = () => d.classList.remove('open');
    d.querySelector('[data-open]').onclick = () => { d.classList.remove('open'); root.Stock && Stock.open(sym); };
    const ak = d.querySelector('[data-ak]'), av = d.querySelector('[data-av]');
    ak.onchange = () => { av.disabled = ak.value.startsWith('ma200'); av.value = ak.value === 'above' ? (last * 1.05).toFixed(2) : ak.value === 'below' ? (last * 0.95).toFixed(2) : ak.value === 'rsi_below' ? 30 : ak.value === 'rsi_above' ? 70 : ''; };
    d.querySelector('[data-aadd]').onclick = async () => {
      try { await j('api/alerts.php?action=add', { symbol: sym, kind: ak.value, value: +av.value || null }); toast('Alert set. You get a notification while MarketMind is open, and an email if your contact is an email address.', 'success'); if ('Notification' in root && Notification.permission === 'default') Notification.requestPermission(); }
      catch (e) { toast(e.message, 'error'); }
    };
    d.querySelector('[data-watch]').onclick = async () => { try { await j('api/watchlist.php?action=add', { symbol: sym }); toast(`${sym} added to your Watchlist`, 'success'); } catch (e) { toast(e.message, 'error'); } };
    const calc = () => {
      const g = k => +d.querySelector(`[data-${k}]`).value, risk = g('cap') * g('rp') / 100, per = g('en') - g('st');
      const q = per > 0 ? Math.floor(risk / per) : 0;
      d.querySelector('[data-out]').innerHTML = per > 0 ? `Buy <b>${q}</b> shares · value ₹${n2(q * g('en'))} · loses ₹${n2(q * per)} at the stop (${g('rp')}% of capital)` : 'Stop must be below the entry.';
    };
    d.querySelectorAll('.dr-calc input').forEach(i => (i.oninput = calc)); calc();
    why(d.querySelector('[data-why]'), raw, sym);
  }

  // Why (or why not) a buy signal today: the Proven strategies' own conditions, checked on this stock
  function why(el, raw, sym) {
    if (!el || !raw || !root.MarketData || !root.Conditions || !root.MarketMindLibrary) return;
    try {
      const candles = MarketData.parseYahooChart(raw).candles.slice(-400);
      const md = MarketData.buildMarketData({ symbol: sym, timeframe: '1d', candles, meta: null, source: 'History' });
      const strats = MarketMindLibrary.STRATEGIES.filter(s => (root.Tiers ? Tiers.info(s.id).tier : '') === 'proven');
      el.innerHTML = '<h4>Buy signal check</h4>' + strats.map(s => {
        const res = s.conditions.map(c => [c, Conditions.check(c, md)]).filter(([, r]) => r);
        const ok = res.length && res.every(([, r]) => r.met), t = Tiers.info(s.id);
        const bt = t.bt ? ` · back-test ${t.bt.avg > 0 ? '+' : ''}${t.bt.avg}R a trade, ${t.bt.yearsPos} of ${t.bt.years} years positive` : '';
        return `<div class="why"><b class="${ok ? 'up' : ''}">${ok ? '✓ Buy signal' : '✗ No signal'}: ${esc(root.Plain ? Plain.name(s.id, s.name) : s.name)}</b><small class="muted">${esc(t.label)}${bt}</small>
          <ul>${res.map(([c, r]) => `<li class="${r.met ? 'up' : 'down'}">${r.met ? '✓' : '✗'} ${esc(c)}</li>`).join('')}</ul></div>`;
      }).join('');
    } catch (e) { el.innerHTML = ''; }
  }
  // Tapping a symbol anywhere (elements with data-sym) opens the drawer instead of leaving the page
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-sym]');
    if (!el || e.ctrlKey || e.metaKey || el.closest('#ux-drawer')) return;
    e.preventDefault(); e.stopPropagation(); drawer(el.dataset.sym);
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { const d = document.getElementById('ux-drawer'); if (d) d.classList.remove('open'); } });

  // ---------- undo toast ----------
  function undo(msg, onUndo, ms = 6000) {
    const t = document.createElement('div'); t.className = 'ux-undo'; t.innerHTML = `<span>${esc(msg)}</span><button>Undo</button>`;
    document.body.appendChild(t);
    const done = () => t.remove(); const timer = setTimeout(done, ms);
    t.querySelector('button').onclick = () => { clearTimeout(timer); done(); onUndo(); };
  }
  // ---------- number flash: call with the element after its value changed ----------
  function flash(el, up) { if (!el) return; el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth; el.classList.add(up ? 'flash-up' : 'flash-down'); }

  // ---------- touch: swipe between tabs, pull to refresh, long-press tips ----------
  let sx = 0, sy = 0, st = 0, lp = null;
  document.addEventListener('touchstart', e => {
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now();
    const tip = e.target.closest('[title]');
    clearTimeout(lp); if (tip && tip.title) lp = setTimeout(() => toast(tip.title), 550);
  }, { passive: true });
  document.addEventListener('touchmove', () => clearTimeout(lp), { passive: true });
  document.addEventListener('touchend', e => {
    clearTimeout(lp);
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Date.now() - st > 600 || e.target.closest('input, textarea, select, table, .fno-tablewrap, .ov-heat, svg, #ux-drawer, .modal')) return;
    if (Math.abs(dx) > 90 && Math.abs(dy) < 40) {
      const subs = [...document.querySelectorAll('#subnav [data-sub]')], i = subs.findIndex(b => b.classList.contains('active'));
      const next = subs[i + (dx < 0 ? 1 : -1)]; if (next) next.click();
    } else if (dy > 120 && Math.abs(dx) < 40 && window.scrollY <= 0) {
      const act = document.querySelector('#subnav .active, #tb-groups .active'); toast('Refreshing…'); if (act) act.click();
    }
  }, { passive: true });

  // ---------- offline notice ----------
  const net = () => document.body.classList.toggle('is-offline', !navigator.onLine);
  addEventListener('online', () => { net(); toast('Back online', 'success'); });
  addEventListener('offline', () => { net(); toast('No internet: showing the last loaded data', 'warning'); });

  // ---------- voice summary and snapshot (Home) ----------
  function speak() {
    if (!('speechSynthesis' in root)) return toast('Voice is not supported in this browser', 'warning');
    const txt = s => (document.querySelector(s) || {}).innerText || '';
    const say = [txt('.mood'), txt('.today'), txt('#home-money .money-total')].filter(Boolean).join('. ').replace(/₹/g, 'rupees ').replace(/\s+/g, ' ');
    speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(say || 'Nothing to report yet.'));
  }
  async function snapshot() {
    const m = document.querySelector('.mood'); const opps = [...document.querySelectorAll('#home-opps .q-list li b')].slice(0, 5).map(b => b.textContent);
    const cv = document.createElement('canvas'); cv.width = 720; cv.height = 360; const g = cv.getContext('2d');
    const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim() || '#333';
    g.fillStyle = css('--bg-card'); g.fillRect(0, 0, 720, 360);
    g.fillStyle = css('--text-primary'); g.font = 'bold 30px sans-serif'; g.fillText('MarketMind · ' + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }), 30, 55);
    g.font = 'bold 26px sans-serif'; g.fillStyle = m && m.classList.contains('mood-up') ? css('--green') : m && m.classList.contains('mood-down') ? css('--red') : css('--yellow');
    g.fillText(m ? m.querySelector('b').textContent + ' — ' + m.querySelector('span').textContent : 'Market mood unavailable', 30, 115);
    g.fillStyle = css('--text-secondary'); g.font = '20px sans-serif'; g.fillText(m ? m.querySelector('small').textContent : '', 30, 150);
    g.fillStyle = css('--text-primary'); g.font = 'bold 22px sans-serif'; g.fillText("Today's best setups", 30, 210);
    g.font = '20px sans-serif'; g.fillText(opps.length ? opps.join(' · ') : 'none yet', 30, 245);
    g.fillStyle = css('--text-muted'); g.font = '15px sans-serif'; g.fillText('For information only, not a recommendation.', 30, 330);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const file = new File([blob], 'marketmind.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'MarketMind' }); return; } catch { /* cancelled */ } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'marketmind.png'; a.click();
  }

  // ---------- pre-market checklist (shown on trading mornings until 9:30) ----------
  const CHECK = ['Read the market mood', 'Check news on my holdings', 'Review today\'s planned trades and stops', 'Feeling calm, not rushed or chasing a loss'];
  function checklist(el) {
    const ist = new Date(Date.now() + 5.5 * 3600e3), m = ist.getUTCHours() * 60 + ist.getUTCMinutes(), day = ist.toISOString().slice(0, 10);
    if (!el || ist.getUTCDay() === 0 || ist.getUTCDay() === 6 || m < 7 * 60 || m > 9 * 60 + 30) return;
    let done = []; try { const s = JSON.parse(localStorage.getItem('mm_checklist')) || {}; if (s.day === day) done = s.done || []; } catch { /* none */ }
    if (done.length === CHECK.length) return;
    el.innerHTML = `<div class="checklist"><b>Before the open</b>${CHECK.map((c, i) => `<label><input type="checkbox" data-c="${i}" ${done.includes(i) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div>`;
    el.querySelectorAll('[data-c]').forEach(x => (x.onchange = () => {
      done = [...el.querySelectorAll('[data-c]:checked')].map(y => +y.dataset.c);
      try { localStorage.setItem('mm_checklist', JSON.stringify({ day, done })); } catch { /* ignore */ }
      if (done.length === CHECK.length) { el.innerHTML = ''; toast('Checklist done. Trade well.', 'success'); }
    }));
  }

  // ---------- alerts: check every minute while the app is open in market hours ----------
  async function pollAlerts() {
    if (document.hidden || !(root.Account && Account.user)) return;
    const n = new Date(Date.now() + 5.5 * 3600e3), m = n.getUTCHours() * 60 + n.getUTCMinutes();
    if (n.getUTCDay() === 0 || n.getUTCDay() === 6 || m < 555 || m > 935) return;
    try {
      const r = await j('api/alerts.php?action=check');
      if (!r.fired.length) return;
      r.fired.forEach(a => { toast('🔔 ' + a.message, 'warning'); if ('Notification' in root && Notification.permission === 'granted') new Notification('MarketMind alert', { body: a.message, icon: 'icon-192.png' }); });
      j('api/alerts.php?action=seen', {});
    } catch { /* quiet */ }
  }
  setInterval(pollAlerts, 60000); setTimeout(pollAlerts, 8000);
  async function openAlerts() {
    const ov = document.getElementById('modal-overlay');
    const draw = async () => {
      let d = { alerts: [], kinds: {} }; try { d = await j('api/alerts.php?action=list'); } catch (e) { toast(e.message, 'error'); }
      ov.innerHTML = `<div class="modal modal-wide"><button class="modal-close" data-x>&times;</button><h3>Alerts</h3>
        <p class="auth-text">Set alerts from any stock's panel (tap a stock symbol). They are checked every minute while MarketMind is open in market hours, and every 5 minutes on the server if the admin added the cron job.</p>
        ${d.alerts.length ? `<ul class="users-list">${d.alerts.map(a => `<li class="user-row${a.active == 1 ? '' : ' off'}"><div class="user-main"><b>${esc(a.symbol)}</b> <span class="text-muted">${esc(d.kinds[a.kind] || a.kind)} ${a.value != null ? esc(+a.value) : ''}</span>
          ${a.active == 1 ? '<span class="user-badge you">Active</span>' : `<div class="text-muted user-meta">Fired: ${esc(a.message)}</div>`}</div><div class="user-actions"><button class="btn-danger btn-small" data-del="${a.id}">Delete</button></div></li>`).join('')}</ul>` : '<p class="home-empty">No alerts yet.</p>'}
        <button class="btn-primary" data-x>Close</button></div>`;
      ov.querySelectorAll('[data-x]').forEach(b => (b.onclick = () => { ov.classList.add('hidden'); ov.innerHTML = ''; }));
      ov.querySelectorAll('[data-del]').forEach(b => (b.onclick = async () => { await j('api/alerts.php?action=delete', { id: +b.dataset.del }); draw(); }));
    };
    ov.classList.remove('hidden'); await draw();
  }

  root.UX = { drawer, undo, flash, speak, snapshot, checklist, openAlerts };
})(typeof window !== 'undefined' ? window : globalThis);

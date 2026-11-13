// ============================================================
// MarketMind AI — Opportunities (daily scan) and My Holdings
//
// Fast verdict: one daily-candle request per stock; the weekly and monthly charts the
// verdict also needs are built from those daily candles instead of fetched again, so a
// scan of ~220 F&O stocks fits ICICI's rate limit (about 3 requests per stock).
// Opportunities: run after market close (automatically if MarketMind is open, or on demand),
//   saved on the server, ranked into Buy now / Near a buy / Buy on dip / Avoid.
// My Holdings: your ICICI holdings and today's positions with each stock's verdict.
// ============================================================
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = (v, d = 2) => (v == null || !isFinite(v) ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = v => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%');
  const ist = () => new Date(Date.now() + 5.5 * 3600e3);
  const istDate = () => ist().toISOString().slice(0, 10);
  const istMins = () => ist().getUTCHours() * 60 + ist().getUTCMinutes();
  const tradingDay = () => { const d = ist().getUTCDay(); return d >= 1 && d <= 5; };
  const toast = (m, t) => root.app && root.app.ui && root.app.ui._toast(m, t || 'info');
  const isAdmin = () => !!(root.Account && root.Account.isAdmin);

  async function getJSON(url, body) {
    const opts = { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.headers['X-Requested-With'] = 'MarketMind'; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw Object.assign(new Error((j && j.error) || `HTTP ${r.status}`), { needsLogin: !!(j && j.needsLogin) });
    return j;
  }

  // ---------- fast verdict ----------
  let brain = null, brainAt = 0;
  async function verdict(symbol) {
    const k = root.app.analysis.knowledge;
    const md = await k.getMarketData(symbol, '1d');
    if (!md.live) throw new Error('no live prices');
    const hist = md.priceHistory;
    const ks = KS001.analyze({
      price: md.price,
      ltf: { tf: '1d', candles: hist },
      itf: { tf: '1w', candles: MarketData.aggregateByPeriod(hist, 'week') },
      htf: { tf: '1mo', candles: MarketData.aggregateByPeriod(hist, 'month') },
    });
    if (root.MindGuru && Date.now() - brainAt > 10 * 60e3) { brain = await MindGuru.getBrain().catch(() => null); brainAt = Date.now(); }
    const cs = Consensus.run({ md, ks, strategies: k.strategies, check: (c, d) => k.checkConditionDetail(c, d), learned: brain ? brain.strategies : null });
    return { md, ks, cs };
  }

  // A buy counts as strong only when backed by a Proven strategy (or two Watch ones), gain at least 1.5× the risk,
  // and the monthly trend not falling. Applied when showing, so older scans regroup too.
  const strong = r => (root.Tiers ? Tiers.isStrong(r) : r.agree >= 2);
  function categorize(r) {
    if (r.verdict === 'Buy') return strong(r) && r.rr >= 1.5 && r.trend[0] !== 'Bearish' ? 'buy' : 'weak';
    if (r.tone === 'short') return 'avoid';
    if (r.verdict === 'Buy on dip') return r.dist != null && r.dist <= 3 ? 'near' : 'dip';
    return 'wait';
  }

  function rowFrom(symbol, name, v) {
    const { md, ks, cs } = v, c = cs.conclusion;
    const buy = c.buyHigh != null ? c.buyHigh : null;
    const dist = buy && md.price ? (md.price - buy) / md.price * 100 : null;   // how far price must fall to reach the buy zone
    return {
      symbol, name: name || md.name, price: md.price, change: md.changePercent, verdict: c.verdict, tone: c.tone,
      agree: c.agree, of: c.of, score: c.score ?? null, backing: c.backing || null, buyLow: c.buyLow, buyHigh: c.buyHigh, stop: c.stop, target: c.sell1 ?? c.coverAt ?? null, sellAt: c.sellAt ?? null,
      rr: c.rr != null && isFinite(c.rr) ? +c.rr.toFixed(2) : null, dist: dist != null ? +dist.toFixed(2) : null,
      setting: (c.settingUp || []).length,
      trend: [ks.trends.htf.trend, ks.trends.itf.trend, ks.trends.ltf.trend],
      demandBelow: (ks.nearestDemand || []).filter(z => z.proximal < md.price).map(z => z.distal)[0] ?? null,
    };
  }
  const withCat = r => ({ ...r, cat: categorize(r) });
  // Who backs the call: Proven / Watch strategies, or nothing counted
  const backTag = r => r.tone !== 'long' ? `${r.agree}/${r.of} agree` : r.backing === 'proven' ? '<span class="tier tier-proven">Proven</span>'
    : r.backing === 'watch' ? '<span class="tier tier-watch">Watch</span>'
    : r.backing === 'none' ? '<span class="tier tier-unproven">Not proven</span>' : `${r.agree}/${r.of} agree`;

  // ---------- results calendar (for "results soon" flags) ----------
  let calendar = null;
  async function resultsSoon() {
    if (!calendar) {
      try {
        const cal = await getJSON('api/events.php?action=calendar');
        calendar = {};
        for (const m of cal.meetings) if (!calendar[m.symbol]) calendar[m.symbol] = m.date;
      } catch { calendar = {}; }
    }
    return calendar;
  }
  const daysUntil = d => Math.round((new Date(d + 'T00:00:00') - new Date(istDate() + 'T00:00:00')) / 864e5);

  // ---------- the scan ----------
  const scan = { running: false, done: 0, total: 0, cancel: false, rows: null, date: null, at: null };

  async function universe() {
    try {
      const meta = (await getJSON('api/breeze.php?action=fo_meta')).underlyings;
      return meta.filter(u => u.kind === 'stock').map(u => ({ symbol: u.symbol, name: u.name }));
    } catch {
      // ICICI not logged in: the 45 large caps from the Analyze page
      return [...document.querySelectorAll('#analyze-symbol option')].map(o => ({ symbol: o.value, name: o.textContent.split(' — ')[1] || o.value }));
    }
  }

  async function runScan(onProgress) {
    if (scan.running) return;
    scan.running = true; scan.cancel = false; scan.done = 0;
    const list = await universe();
    scan.total = list.length;
    const rows = [], failed = [];
    const queue = [...list];
    const worker = async () => {
      while (queue.length && !scan.cancel) {
        const s = queue.shift();
        try { rows.push(withCat(rowFrom(s.symbol, s.name, await verdict(s.symbol)))); }
        catch (e) { failed.push(s.symbol); }
        scan.done++;
        onProgress && onProgress();
      }
    };
    try {
      await Promise.all([worker(), worker()]);
      if (!scan.cancel && rows.length) {
        await getJSON('api/scan.php?action=save', { date: istDate(), rows });
        scan.rows = rows; scan.date = istDate(); scan.at = new Date().toISOString();
        toast(`Scan finished: ${rows.filter(r => r.cat === 'buy').length} strong buys, ${rows.filter(r => r.cat === 'near').length} near a buy${failed.length ? ` (${failed.length} stocks had no data)` : ''}.`, 'success');
      }
    } finally {
      scan.running = false;
      onProgress && onProgress();
    }
  }

  async function loadLatest() {
    const j = await getJSON('api/scan.php?action=latest');
    scan.rows = j.rows.map(withCat); scan.date = j.date; scan.at = j.at;
  }

  // After 3:40 pm on a trading day, the admin's open MarketMind runs today's scan once
  function autoScan() {
    let tries = 0;
    const iv = setInterval(async () => {
      tries++;
      if (!(root.Account && root.Account.user && root.app && root.app.analysis)) { if (tries > 120) clearInterval(iv); return; }
      clearInterval(iv);
      if (!isAdmin()) return;
      const check = async () => {
        if (!tradingDay() || istMins() < 15 * 60 + 40 || scan.running) return;
        if (!scan.date) await loadLatest().catch(() => {});
        if (scan.date === istDate()) return;
        runScan(() => { const c = document.getElementById('opps-container'); if (c && c.dataset.ready) renderOpps(c); });
      };
      check();
      setInterval(check, 10 * 60e3);
    }, 1000);
  }
  if (typeof document !== 'undefined') autoScan();

  // ---------- Opportunities page ----------
  const oppState = { tab: 'buy', filter: '' };
  const CAT = {
    buy: ['Strong buy', 'In a buy zone now, backed by a Proven strategy (or two Watch ones), gain at least 1.5× the risk, monthly trend not falling.'],
    weak: ['Weak buy', 'In a buy zone, but backed only by one Watch strategy, the gain is small for the risk, or the monthly trend is falling.'],
    near: ['Near a buy', 'A buy zone is within 3% below the price: set a limit order or watch it.'],
    dip: ['Buy on dip', 'Bullish, but the buy zone is more than 3% below.'],
    avoid: ['Avoid / sell', 'Strategies point down: avoid buying; holders may consider selling.'],
    wait: ['Wait', 'No clear setup today.'],
  };

  async function renderOppsPage(container) {
    if (!container) return;
    container.dataset.ready = '1';
    if (!scan.rows && !scan.running) {
      container.innerHTML = '<p class="muted" style="padding:16px;">Loading the latest scan…</p>';
      try { await loadLatest(); } catch (e) { container.innerHTML = `<div class="data-warning">${esc(e.message)}</div>`; return; }
    }
    await resultsSoon();
    renderOpps(container);
  }

  function renderOpps(container) {
    const rows = scan.rows || [];
    const cal = calendar || {};
    const f = oppState.filter.toLowerCase();
    const list = rows.filter(r => r.cat === oppState.tab && (!f || (r.symbol + ' ' + r.name).toLowerCase().includes(f)));
    const sorters = { buy: (a, b) => (b.score ?? b.agree) - (a.score ?? a.agree) || (b.rr || 0) - (a.rr || 0), weak: (a, b) => (b.score ?? b.agree) - (a.score ?? a.agree) || (b.rr || 0) - (a.rr || 0), near: (a, b) => a.dist - b.dist, dip: (a, b) => a.dist - b.dist, avoid: (a, b) => b.agree - a.agree, wait: (a, b) => b.setting - a.setting };
    list.sort(sorters[oppState.tab]);
    const counts = Object.fromEntries(Object.keys(CAT).map(k => [k, rows.filter(r => r.cat === k).length]));
    const head = scan.running
      ? `<div class="live-bar"><span class="live-dot"></span><span>Scanning ${scan.done} of ${scan.total} stocks… (about ${Math.max(1, Math.round((scan.total - scan.done) * 1.8 / 60))} min left)</span><button type="button" class="live-toggle" id="opp-cancel">Stop</button></div>`
      : `<div class="live-bar"><span>${scan.date ? `Latest scan: <b>${esc(new Date(scan.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }))}</b>, ${rows.length} stocks, daily chart.` : 'No scan yet.'} ${isAdmin() ? 'It runs by itself after 3:40 pm when MarketMind is open, or now:' : ''}</span>${isAdmin() ? '<button type="button" class="live-toggle" id="opp-run">Scan now</button>' : ''}</div>`;
    const trendWord = t => (t === 'Bullish' ? '<span class="text-green">up</span>' : t === 'Bearish' ? '<span class="text-red">down</span>' : '<span class="text-yellow">flat</span>');
    const table = list.length ? `<div class="fno-tablewrap"><table class="screener-table fno-table">
      <thead><tr><th>Stock</th><th>Price</th><th>Verdict</th><th>${oppState.tab === 'avoid' ? 'Sell near' : 'Buy zone'}</th><th>Stop</th><th>Target</th><th>Reward : risk</th><th>Trend M/W/D</th><th></th></tr></thead>
      <tbody>${list.map(r => {
        const res = cal[r.symbol] && daysUntil(cal[r.symbol]) >= 0 && daysUntil(cal[r.symbol]) <= 7 ? `<br><span class="tag tag-orange">Results ${daysUntil(cal[r.symbol]) === 0 ? 'today' : 'in ' + daysUntil(cal[r.symbol]) + 'd'}</span>` : '';
        const zone = oppState.tab === 'avoid' ? rs(r.sellAt) : r.buyLow == null ? '—' : r.buyLow === r.buyHigh ? rs(r.buyLow) : `${rs(r.buyLow)} – ${rs(r.buyHigh)}`;
        return `<tr><td><b>${esc(r.symbol)}</b><br><span class="muted">${esc(String(r.name).slice(0, 28))}</span>${res}</td>
          <td>${rs(r.price)}<br><span class="${r.change > 0 ? 'text-green' : r.change < 0 ? 'text-red' : ''}">${pct(r.change)}</span></td>
          <td>${esc(r.verdict)}<br><span class="muted">${backTag(r)}${r.dist != null && r.cat !== 'buy' && r.cat !== 'avoid' ? ` · ${r.dist.toFixed(1)}% away` : ''}</span></td>
          <td>${zone}</td><td>${rs(r.stop)}</td><td>${rs(r.target)}</td><td>${r.rr != null ? '1 : ' + r.rr.toFixed(1) : '—'}</td>
          <td>${r.trend.map(trendWord).join(' / ')}</td>
          <td class="opp-actions"><button type="button" class="link-btn" data-analyze="${esc(r.symbol)}">Analyze</button>${isAdmin() && r.tone !== 'short' ? `<button type="button" class="link-btn" data-watch="${esc(r.symbol)}" data-name="${esc(r.name)}">+ Trading watchlist</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>` : `<p class="muted">${scan.rows ? 'No stocks in this group today.' : ''}</p>`;
    container.innerHTML = `${head}
      <div class="fno-tabs" role="tablist">${Object.entries(CAT).map(([k, [label]]) => `<button type="button" class="fno-tab${oppState.tab === k ? ' active' : ''}" data-tab="${k}">${label} (${counts[k]})</button>`).join('')}</div>
      <div class="ev-filters"><input type="search" id="opp-filter" placeholder="Filter by symbol or company" value="${esc(oppState.filter)}" /><span class="muted">${esc(CAT[oppState.tab][1])}</span></div>
      ${table}
      <p class="citation">All-Strategy Verdict on each F&amp;O stock's daily chart (weekly and monthly trends built from the same daily candles). "Results" flags a results date within 7 days. Not a recommendation.</p>`;
    container.querySelectorAll('.fno-tab').forEach(b => { b.onclick = () => { oppState.tab = b.dataset.tab; renderOpps(container); }; });
    const fi = container.querySelector('#opp-filter');
    fi.oninput = () => { oppState.filter = fi.value; const p = fi.selectionStart; renderOpps(container); const n = container.querySelector('#opp-filter'); n.focus(); n.setSelectionRange(p, p); };
    const run = container.querySelector('#opp-run');
    if (run) run.onclick = () => runScan(() => renderOpps(container));
    const cancel = container.querySelector('#opp-cancel');
    if (cancel) cancel.onclick = () => { scan.cancel = true; };
    container.querySelectorAll('[data-analyze]').forEach(b => { b.onclick = () => openAnalyze(b.dataset.analyze); });
    container.querySelectorAll('[data-watch]').forEach(b => {
      b.onclick = async () => {
        try {
          await getJSON('api/trade.php?action=watch_add', { symbol: b.dataset.watch, name: b.dataset.name, delivery: true, intraday: false, options: false });
          toast(`${b.dataset.watch} added to the Trading watchlist (delivery).`, 'success');
        } catch (e) { toast(e.message, 'warning'); }
      };
    });
  }

  function openAnalyze(symbol) {
    const input = document.getElementById('analyze-custom-symbol');
    if (input) input.value = symbol;
    const tf = document.getElementById('analyze-timeframe'); if (tf) tf.value = '1d';
    const st = document.getElementById('analyze-strategy'); if (st) st.value = '__all';
    document.querySelector('#nav-links a[data-page="analyze"]').click();
    setTimeout(() => document.getElementById('btn-analyze')?.click(), 400);
  }

  // ---------- My Holdings ----------
  const num = v => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
  const pick = (r, keys) => { for (const k of keys) if (num(r[k]) != null) return num(r[k]); return null; };

  // Which account the Holdings page shows: 'main' (admin's server-config ICICI) or a Broker accounts id
  const HOLD_KEY = 'mm_holdings_account';
  async function renderHoldingsPage(container) {
    if (!container) return;
    container.innerHTML = '<p class="muted" style="padding:16px;">Reading your accounts…</p>';
    const admin = !!(root.Account && root.Account.isAdmin);
    let list = { accounts: [] };
    try { list = await getJSON('api/brokers.php?action=list'); } catch (e) { /* older server: main account only */ }
    const choices = [...(admin ? [{ id: 'main', label: 'ICICI Direct · main' }] : []), ...list.accounts.map(a => ({ id: String(a.id), label: `${a.label}${a.connectedToday ? '' : ' (log in needed)'}` }))];
    if (!choices.length) {
      container.innerHTML = '<div class="data-warning">No broker account connected yet. Open <b>Broker accounts</b> in the sidebar (under your name) to add your ICICI account, then log in to it for today.</div>';
      return;
    }
    let sel; try { sel = localStorage.getItem(HOLD_KEY); } catch { sel = null; }
    if (!choices.some(c => c.id === sel)) sel = choices[0].id;
    const picker = choices.length > 1 ? `<div class="live-bar"><label>Account <select id="hold-account">${choices.map(c => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label></div>` : '';
    const loginUrl = sel === 'main' ? 'api/breeze.php?action=login' : `api/brokers.php?action=login&id=${encodeURIComponent(sel)}`;
    container.innerHTML = picker + '<div id="hold-main"><p class="muted" style="padding:16px;">Reading holdings…</p></div>';
    const pickEl = container.querySelector('#hold-account');
    if (pickEl) pickEl.onchange = () => { try { localStorage.setItem(HOLD_KEY, pickEl.value); } catch { /* ignore */ } renderHoldingsPage(container); };
    const target = container.querySelector('#hold-main');
    let h;
    try { h = await getJSON(sel === 'main' ? 'api/breeze.php?action=holdings' : `api/brokers.php?action=holdings&id=${encodeURIComponent(sel)}`); }
    catch (e) {
      target.innerHTML = e.needsLogin
        ? `<div class="data-warning">This account isn't connected today. <a href="${loginUrl}">Log in to it</a>, then come back to this page.</div>`
        : `<div class="data-warning">Couldn't read the holdings: ${esc(e.message)}</div>`;
      return;
    }
    container = target;
    const sym = code => h.symbols[String(code || '').toUpperCase()] || String(code || '').toUpperCase();
    const src = h.holdings && h.holdings.length ? h.holdings : (h.demat || []);
    const holdings = src.map(r => ({
      code: r.stock_code, symbol: sym(r.stock_code),
      qty: pick(r, ['quantity', 'demat_avail_quantity', 'demat_total_bulk_quantity']),
      avg: pick(r, ['average_price', 'avg_price', 'purchase_price']),
      ltp: pick(r, ['current_market_price', 'ltp']),
    })).filter(x => x.qty > 0);
    const positions = (h.positions || []).filter(p => num(p.quantity) && num(p.quantity) !== 0);

    container.innerHTML = `<div class="live-bar"><span>${holdings.length} holdings · ${positions.length} open positions today. Working out each stock's verdict…</span></div><div id="hold-body"></div>`;
    const out = [];
    for (const x of holdings) {
      try {
        const v = await verdict(x.symbol);
        const r = rowFrom(x.symbol, '', v);
        out.push({ ...x, r, ltp: r.price || x.ltp });
      } catch (e) { out.push({ ...x, r: null, err: e.message }); }
      drawHoldings(container, out, holdings.length, positions, h, sym);
    }
    drawHoldings(container, out, holdings.length, positions, h, sym);
  }

  function drawHoldings(container, out, total, positions, h, sym) {
    const cal = calendar || {};
    let invested = 0, value = 0;
    for (const x of out) if (x.avg && x.ltp) { invested += x.avg * x.qty; value += x.ltp * x.qty; }
    const flags = x => {
      const f = [];
      if (!x.r) return x.err ? `<span class="muted">${esc(x.err)}</span>` : '';
      if (x.r.tone === 'short') f.push('<span class="tag tag-red">Verdict: sell / avoid</span>');
      const stop = x.r.stop ?? x.r.demandBelow;
      if (stop && x.ltp < stop) f.push('<span class="tag tag-red">Below its stop level</span>');
      const d = cal[x.symbol];
      if (d && daysUntil(d) >= 0 && daysUntil(d) <= 7) f.push(`<span class="tag tag-orange">Results ${daysUntil(d) === 0 ? 'today' : 'in ' + daysUntil(d) + 'd'}</span>`);
      return f.join(' ');
    };
    const body = container.querySelector('#hold-body');
    const bar = container.querySelector('.live-bar');
    if (bar) bar.innerHTML = `<span>${out.length < total ? `Checking ${out.length} of ${total} holdings…` : `${total} holdings`} · invested ${rs(invested, 0)} · now ${rs(value, 0)} · <b class="${value - invested >= 0 ? 'text-green' : 'text-red'}">${rs(value - invested, 0)} (${invested ? pct((value - invested) / invested * 100) : '—'})</b></span>`;
    body.innerHTML = `
      ${out.length ? `<div class="fno-tablewrap"><table class="screener-table fno-table">
        <thead><tr><th>Stock</th><th>Qty</th><th>Avg price</th><th>Price</th><th>P&amp;L</th><th>Verdict</th><th>Suggested stop</th><th>Watch</th><th></th></tr></thead>
        <tbody>${out.map(x => {
          const pl = x.avg && x.ltp ? (x.ltp - x.avg) * x.qty : null;
          const stop = x.r ? (x.r.stop ?? x.r.demandBelow) : null;
          return `<tr><td><b>${esc(x.symbol)}</b>${x.code && x.code !== x.symbol ? `<br><span class="muted">ICICI ${esc(x.code)}</span>` : ''}</td>
            <td>${(x.qty || 0).toLocaleString('en-IN')}</td><td>${rs(x.avg)}</td><td>${rs(x.ltp)}</td>
            <td class="${pl > 0 ? 'text-green' : pl < 0 ? 'text-red' : ''}">${pl != null ? rs(pl, 0) + `<br>${pct((x.ltp - x.avg) / x.avg * 100)}` : '—'}</td>
            <td>${x.r ? esc(x.r.verdict) + `<br><span class="muted">${x.r.agree}/${x.r.of} agree</span>` : '—'}</td>
            <td>${rs(stop)}${stop && x.ltp ? `<br><span class="muted">${((x.ltp - stop) / x.ltp * 100).toFixed(1)}% below</span>` : ''}</td>
            <td>${flags(x)}</td>
            <td><button type="button" class="link-btn" data-analyze="${esc(x.symbol)}">Analyze</button></td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="muted">No holdings found in your ICICI demat account.</p>'}
      ${positions.length ? `<h4 style="margin:16px 0 8px;">Open positions today</h4><div class="fno-tablewrap"><table class="screener-table fno-table">
        <thead><tr><th>Contract</th><th>Product</th><th>Qty</th><th>Avg price</th><th>Price</th></tr></thead>
        <tbody>${positions.map(p => `<tr><td>${esc(sym(p.stock_code))}${p.strike_price && num(p.strike_price) ? ` ${esc(num(p.strike_price))} ${esc(String(p.right || '').toUpperCase().slice(0, 1) === 'P' ? 'PE' : 'CE')} ${esc(String(p.expiry_date || '').slice(0, 11))}` : ''}</td>
          <td>${esc(p.product_type || p.segment || '')}</td><td>${esc(num(p.quantity))}</td><td>${rs(pick(p, ['average_price', 'cost_price']))}</td><td>${rs(pick(p, ['ltp', 'current_market_price']))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${h.notes && h.notes.length ? `<p class="citation">${esc(h.notes.join(' · '))}</p>` : ''}
      <p class="citation">Read-only from ${h.account ? esc(h.account.label) : 'your ICICI account'}. Suggested stop = the verdict's stop-loss, or the bottom of the nearest demand zone below the price. Not a recommendation.</p>`;
    body.querySelectorAll('[data-analyze]').forEach(b => { b.onclick = () => openAnalyze(b.dataset.analyze); });
  }

  root.Opportunities = { renderPage: renderOppsPage, runScan, verdict };
  root.Holdings = { renderPage: async c => { await resultsSoon(); return renderHoldingsPage(c); } };
})(typeof window !== 'undefined' ? window : globalThis);

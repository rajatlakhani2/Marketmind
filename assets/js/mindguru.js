// MarketMind AI — MindGuru, the app's learning layer.
//
// 1. Every All-Strategy Verdict on live data is saved as projections (each active
//    strategy's entry / stop / target, plus the combined verdict).
// 2. The server checks each projection against the real price path once its day has
//    passed: target hit, stop hit, expired, or entry never reached.
// 3. Those results become per-strategy weights (overall, by trend, by KS-001 score).
//    The next verdict uses them: proven strategies count more, weak ones less.
// 4. "Train on history" replays the strategies on ~1 year of past daily candles so
//    MindGuru starts with hundreds of results instead of waiting weeks.
(function () {
  const API = 'api/mindguru.php';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = 864e5;
  const istDate = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);

  let brain = null, brainAt = 0, serverOk = true;

  async function api(action, body) {
    const opts = { headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-Requested-With'] = 'MarketMind';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${API}?action=${action}`, opts);
    let j;
    try { j = await r.json(); } catch { serverOk = false; throw new Error('MindGuru needs the PHP server and database'); }
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
    return j;
  }

  // Learned weights, refreshed every 10 minutes. Returns null when unavailable.
  async function getBrain(force) {
    if (!serverOk || (window.Account && Account.devMode)) return null;
    if (!force && brain && Date.now() - brainAt < 10 * 60e3) return brain;
    try { brain = await api('brain'); brainAt = Date.now(); } catch { return brain; }
    return brain;
  }

  // ---------- projections from a verdict ----------
  function projections(cs, md, ks, signalDate) {
    if (!cs) return [];
    const trend = ks && ks.trends && ks.trends.htf ? ks.trends.htf.trend : '';
    const c = cs.conclusion;
    const list = [];
    for (const r of cs.results) {
      if (r.status !== 'Active' || !r.plan) continue;
      list.push({ kind: 'strategy', strategyId: r.id, strategyName: r.name, side: r.plan.side, entry: r.plan.entry, stop: r.plan.stop, target: r.plan.target, ksScore: r.plan.ksScore ?? null });
    }
    if (c.tone === 'long' && c.buyHigh != null && c.stop != null && c.sell1 != null) {
      list.push({ kind: 'verdict', strategyId: '__verdict', strategyName: 'All-Strategy Verdict', side: 'long', entry: c.verdict === 'Buy' ? md.price : c.buyHigh, stop: c.stop, target: c.sell1 });
    } else if (c.tone === 'short' && c.sellAt != null) {
      list.push({ kind: 'verdict', strategyId: '__verdict', strategyName: 'All-Strategy Verdict', side: 'short', entry: c.sellAt, stop: c.stop, target: c.coverAt });
    }
    return list.map((p) => ({
      ...p, symbol: md.symbol, name: md.name || md.symbol, signalDate, price: md.price, trend,
      context: { verdict: c.verdict, agree: c.agree, of: c.of, rsi: md.rsi, bias: ks ? ks.bias : null },
    }));
  }

  // Called after an All-Strategy Verdict on live data. Fire-and-forget.
  function recordVerdict(result) {
    const md = result && result.marketData;
    if (!result || !result.consensus || !md || !md.live || md.timeframe !== '1d' || !serverOk) return;
    const hist = md.priceHistory || [];
    if (!hist.length) return;
    const preds = projections(result.consensus, md, result.ks001, istDate(hist[hist.length - 1].time));
    if (!preds.length) return;
    api('record', { source: 'live', predictions: preds }).catch((e) => console.warn('MindGuru could not save projections:', e.message));
  }

  // ---------- learning ----------
  async function learn(onStep) {
    let total = 0, gen = 0;
    for (let i = 0; i < 30; i++) {
      const r = await api('learn', {});
      total += r.resolved; gen = r.generation;
      if (onStep) onStep(total, r);
      if (r.done) break;
    }
    try { localStorage.setItem('mm_mg_learned_at', String(Date.now())); } catch { /* ignore */ }
    await getBrain(true);
    return { resolved: total, generation: gen };
  }

  // In the background after sign-in, at most every 3 hours.
  async function autoLearn() {
    if (!serverOk || (window.Account && Account.devMode)) return;
    let last = 0;
    try { last = Number(localStorage.getItem('mm_mg_learned_at') || 0); } catch { /* ignore */ }
    if (Date.now() - last < 3 * 3600e3) { getBrain(); return; }
    try {
      const r = await learn();
      if (r.resolved && window.app && app.ui) app.ui._toast(`MindGuru learned from ${r.resolved} new result${r.resolved > 1 ? 's' : ''}`, 'info');
    } catch { /* not set up yet */ }
  }

  // ---------- training on history ----------
  const completedBefore = (candles, T, next) => candles.filter((c) => next(c.time) <= T + DAY);
  const nextWeek = (t) => t + 7 * DAY;
  const nextMonth = (t) => { const d = new Date(t + 5.5 * 3600e3); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 5.5 * 3600e3; };

  // Replays every built-in strategy on past daily candles (every `step` days over ~1 year).
  async function train({ symbols, step = 3, onProgress, isCancelled }) {
    const strategies = (app.engine.strategies || []).filter((s) => Consensus.LEVELS[s.id]);
    const check = (c, d) => app.engine.checkConditionDetail(c, d);
    const all = [];
    let done = 0, failed = 0;
    for (const sym of symbols) {
      if (isCancelled && isCancelled()) break;
      try {
        const [d, w, m] = await Promise.all(['1d', '1w', '1mo'].map((tf) => MarketData.fetchCandles(sym, tf)));
        const daily = d.candles, n = daily.length;
        for (let t = Math.max(210, n - 250); t <= n - 2; t += step) {
          const day = daily.slice(0, t + 1), T = day[t].time;
          const weekly = completedBefore(w.candles, T, nextWeek);
          const monthly = completedBefore(m.candles, T, nextMonth);
          if (weekly.length < 25 || monthly.length < 12) continue;
          const md = MarketData.buildMarketData({ symbol: sym, timeframe: '1d', candles: day, meta: { longName: d.meta.longName || d.meta.shortName }, source: 'History' });
          const ks = KS001.analyze({ price: md.price, ltf: { tf: '1d', candles: day }, itf: { tf: '1w', candles: weekly }, htf: { tf: '1mo', candles: monthly } });
          const cs = Consensus.run({ md, ks, strategies, check });
          all.push(...projections(cs, md, ks, istDate(T)));
        }
      } catch (e) {
        failed++;
        console.warn('MindGuru training skipped', sym, e.message);
      }
      done++;
      if (onProgress) onProgress({ phase: 'replay', done, total: symbols.length, found: all.length, failed });
      await new Promise((r) => setTimeout(r, 0));
    }
    let added = 0;
    for (let i = 0; i < all.length; i += 400) {
      const r = await api('record', { source: 'backtest', predictions: all.slice(i, i + 400) });
      added += r.added;
      if (onProgress) onProgress({ phase: 'save', done: Math.min(i + 400, all.length), total: all.length });
    }
    const res = await learn((resolved) => onProgress && onProgress({ phase: 'learn', resolved }));
    return { projections: all.length, added, failed, ...res };
  }

  // ---------- MindGuru page ----------
  const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
  const rFmt = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + 'R');
  const STATUS = {
    pending: ['Waiting', 'st-wait'], target_hit: ['Target hit', 'st-win'], stop_hit: ['Stop hit', 'st-loss'],
    expired: ['Time exit', 'st-exp'], no_entry: ['Entry not reached', 'st-none'], invalid: ['Skipped', 'st-none'],
  };
  function fmtWhen(s) {
    if (!s) return 'never';
    return new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function popularSymbols() {
    return [...document.querySelectorAll('#analyze-symbol option')].map((o) => o.value);
  }

  async function renderPage(el) {
    if (window.Account && Account.devMode) {
      el.innerHTML = `<div class="mg-card"><p>MindGuru stores projections and results in MySQL, so it works on the hosted site, not on the local dev server.</p></div>`;
      return;
    }
    el.innerHTML = '<p class="muted">Loading MindGuru…</p>';
    let rep;
    try { rep = await api('report'); } catch (e) { el.innerHTML = `<div class="mg-card"><p class="text-red">${esc(e.message)}</p></div>`; return; }
    const count = (src, st) => rep.counts.filter((c) => c.source === src && (!st || c.status === st)).reduce((x, c) => x + Number(c.n), 0);
    const live = count('live'), livePending = count('live', 'pending'), hist = count('backtest');
    const b = rep.brain;
    const verdict = rep.stats.find((s) => s.strategyId === '__verdict');
    const strategies = rep.stats.filter((s) => s.strategyId !== '__verdict');
    const maxW = 2;

    el.innerHTML = `
      <div class="mg-hero">
        <div class="mg-hero-main">
          <div class="mg-gen">Generation ${b.generation}</div>
          <h3>${b.trades ? `Learned from ${b.trades.toLocaleString('en-IN')} finished trades` : 'Still learning'}</h3>
          <p>${b.learnedAt ? `Last learned ${esc(fmtWhen(b.learnedAt))}. ` : ''}${live.toLocaleString('en-IN')} projections from your analyses (${livePending} waiting for the market) and ${hist.toLocaleString('en-IN')} from history.</p>
        </div>
        <div class="mg-hero-actions">
          <button class="btn-primary" id="mg-learn">Learn now</button>
          <button class="btn-secondary" id="mg-train">Train on history</button>
        </div>
      </div>
      <div id="mg-progress" class="mg-progress hidden"></div>

      ${verdict ? `<div class="mg-stats">
        <div class="mg-stat"><span>Verdict win rate</span><b>${pct(verdict.winRate)}</b><small>${verdict.trades} trades</small></div>
        <div class="mg-stat"><span>Average result</span><b class="${verdict.avgR >= 0 ? 'text-green' : 'text-red'}">${rFmt(verdict.avgR)}</b><small>per verdict trade</small></div>
        <div class="mg-stat"><span>Entry reached</span><b>${pct(verdict.trades / Math.max(1, verdict.trades + verdict.noEntry))}</b><small>of buy-on-dip levels</small></div>
      </div>` : ''}

      <section class="mg-card">
        <h4>What MindGuru has learned</h4>
        ${rep.insights.length ? `<ul class="mg-insights">${rep.insights.map((i) => `<li class="mg-${i.tone}">${esc(i.text)}</li>`).join('')}</ul>`
          : '<p class="muted">No lessons yet. A strategy needs about 10 finished trades before MindGuru draws conclusions. Use <b>Train on history</b> to get there today.</p>'}
      </section>

      <section class="mg-card">
        <h4>Strategy trust</h4>
        <p class="muted mg-help">Trust starts at 1.0 for every strategy. It rises when a strategy's trades make money on average and falls when they lose, more strongly as results pile up. The verdict weighs each strategy's vote by this number.</p>
        ${strategies.length ? `<div class="mg-table-wrap"><table class="mg-table">
          <thead><tr><th>Strategy</th><th>Trades</th><th>Win %</th><th>Avg</th><th>Trust</th><th>Best when trend is</th></tr></thead>
          <tbody>${strategies.map((s) => {
            const trends = Object.entries(s.buckets || {}).filter(([k, v]) => k.startsWith('trend:') && v.trades >= 5).sort((x, y) => y[1].avgR - x[1].avgR);
            const best = trends.length > 1 ? `${trends[0][0].slice(6)} <span class="muted">${rFmt(trends[0][1].avgR)}</span>` : '<span class="muted">—</span>';
            return `<tr>
              <td>${esc(s.name)}</td><td>${s.trades}</td><td>${pct(s.winRate)}</td>
              <td class="${s.avgR >= 0 ? 'text-green' : 'text-red'}">${rFmt(s.avgR)}</td>
              <td><div class="mg-trust"><div class="mg-trust-bar"><i style="width:${Math.min(100, (s.weight / maxW) * 100)}%" class="${s.weight >= 1 ? 'up' : 'down'}"></i><em></em></div><span>${s.weight.toFixed(2)}</span></div></td>
              <td>${best}</td></tr>`;
          }).join('')}</tbody></table></div>`
          : '<p class="muted">No finished trades yet.</p>'}
      </section>

      <section class="mg-card">
        <h4>Projected vs actual <span class="muted">(your analyses)</span></h4>
        ${rep.recent.length ? `<div class="mg-table-wrap"><table class="mg-table mg-recent">
          <thead><tr><th>Date</th><th>Stock</th><th>Strategy</th><th>Plan</th><th>What happened</th><th>Result</th></tr></thead>
          <tbody>${rep.recent.map((p) => {
            const [label, cls] = STATUS[p.status] || [p.status, ''];
            const f = (v) => '₹' + Number(v).toFixed(2);
            return `<tr>
              <td>${esc(p.signal_date)}</td><td><b>${esc(p.symbol)}</b></td><td>${esc(p.strategy_name)}</td>
              <td class="mg-plan">${p.side === 'short' ? 'Sell' : 'Buy'} ${f(p.entry)} · SL ${f(p.stop)} · T ${f(p.target)}</td>
              <td><span class="mg-status ${cls}">${label}</span>${p.exit_date ? ` <span class="muted">${esc(p.exit_date)}${p.exit_price ? ' @ ' + f(p.exit_price) : ''}</span>` : ''}</td>
              <td class="${p.r_multiple > 0 ? 'text-green' : p.r_multiple < 0 ? 'text-red' : ''}">${p.r_multiple != null ? rFmt(Number(p.r_multiple)) : ''}</td></tr>`;
          }).join('')}</tbody></table></div>`
          : '<p class="muted">Run an <b>All strategies — verdict</b> analysis on any stock. Its projections are saved here automatically and checked against real prices every day.</p>'}
      </section>

      <section class="mg-card">
        <h4>Learning log</h4>
        ${rep.log.length ? `<ul class="mg-log">${rep.log.map((g) => `<li><b>Generation ${g.generation}</b> <span class="muted">${esc(fmtWhen(g.at))} · ${g.outcomes} new result${g.outcomes === 1 ? '' : 's'}</span>
          <ul>${(g.notes || []).slice(0, 5).map((n) => `<li>${esc(n.strategy)}: ${n.winRateBefore != null ? `${n.winRateBefore}% → ` : ''}${n.winRate}% winners over ${n.trades} trades, trust ${n.weightBefore != null ? n.weightBefore.toFixed(2) + ' → ' : ''}${n.weight.toFixed(2)}</li>`).join('')}</ul></li>`).join('')}</ul>`
          : '<p class="muted">Nothing learned yet.</p>'}
      </section>

      <section class="mg-card mg-how">
        <h4>How MindGuru judges a projection</h4>
        <ul>
          <li>An entry close to the price at the time counts as filled at once; otherwise price must reach the entry within 10 trading days, or the result is "entry not reached".</li>
          <li>Then whichever comes first, stop-loss or target, decides the trade. If one day touches both, MindGuru assumes the stop (the cautious reading). Still open after 30 trading days: closed at that day's price.</li>
          <li>Results are measured in R: +2R means the trade made twice the amount it risked.</li>
          <li>History training replays the strategies on past candles. It is a guide, not a guarantee; projections from your live analyses are tracked separately.</li>
        </ul>
        ${rep.isAdmin ? `<p class="mg-admin"><button class="btn-danger btn-small" id="mg-reset-hist">Forget history training</button> <button class="btn-danger btn-small" id="mg-reset-all">Reset MindGuru completely</button></p>` : ''}
      </section>`;

    const progress = el.querySelector('#mg-progress');
    const busy = (on) => el.querySelectorAll('#mg-learn, #mg-train').forEach((b) => (b.disabled = on));
    const show = (html) => { progress.classList.remove('hidden'); progress.innerHTML = html; };

    el.querySelector('#mg-learn').onclick = async () => {
      busy(true);
      show('Checking projections against real prices…');
      try {
        const r = await learn((n) => show(`Checking projections against real prices… ${n} judged so far`));
        show(r.resolved ? `Learned from ${r.resolved} new result${r.resolved > 1 ? 's' : ''}.` : 'No new results yet. Projections are judged once their trading days have passed.');
        setTimeout(() => renderPage(el), 1200);
      } catch (e) { show(`<span class="text-red">${esc(e.message)}</span>`); busy(false); }
    };

    el.querySelector('#mg-train').onclick = async () => {
      const symbols = popularSymbols();
      if (!confirm(`Replay every strategy on about one year of daily candles for ${symbols.length} large-cap NSE stocks? This takes a few minutes; keep this page open.`)) return;
      busy(true);
      let cancelled = false;
      try {
        const r = await train({
          symbols, isCancelled: () => cancelled,
          onProgress: (p) => show(
            p.phase === 'replay' ? `<div>Replaying strategies… ${p.done}/${p.total} stocks, ${p.found.toLocaleString('en-IN')} projections${p.failed ? ` (${p.failed} skipped)` : ''}</div><div class="mg-bar"><i style="width:${(p.done / p.total) * 100}%"></i></div>`
            : p.phase === 'save' ? `<div>Saving projections… ${p.done}/${p.total}</div><div class="mg-bar"><i style="width:${(p.done / p.total) * 100}%"></i></div>`
            : `<div>Judging against real prices… ${p.resolved.toLocaleString('en-IN')} done</div>`),
        });
        show(`Done: ${r.projections.toLocaleString('en-IN')} projections replayed (${r.added.toLocaleString('en-IN')} new), ${r.resolved.toLocaleString('en-IN')} judged. MindGuru is now at generation ${r.generation}.`);
        setTimeout(() => renderPage(el), 1500);
      } catch (e) { show(`<span class="text-red">${esc(e.message)}</span>`); busy(false); }
    };

    const reset = async (scope, msg) => {
      if (!confirm(msg)) return;
      try { await api('reset', { scope }); await getBrain(true); renderPage(el); } catch (e) { show(`<span class="text-red">${esc(e.message)}</span>`); }
    };
    el.querySelector('#mg-reset-hist')?.addEventListener('click', () => reset('backtest', 'Delete all history-training results? Projections from real analyses are kept.'));
    el.querySelector('#mg-reset-all')?.addEventListener('click', () => reset('all', 'Delete EVERYTHING MindGuru has recorded and learned, including your real projections? This cannot be undone.'));
  }

  window.MindGuru = { getBrain, recordVerdict, learn, autoLearn, train, renderPage, projections };
})();

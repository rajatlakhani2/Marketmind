// MarketMind AI — Journal (admin): every trade with a note and mood tag, this month's scorecard in R vs the
// back-test, patterns in losses, tax summary for the financial year, and "what if I had held" for each exit.
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = v => (v == null || !isFinite(v) ? '—' : '₹' + Math.round(v).toLocaleString('en-IN'));
  const r2 = v => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
  const tone = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const TAGS = { '': '—', plan: 'Followed plan', calm: 'Calm', rushed: 'Rushed', fomo: 'Fear of missing out', revenge: 'Revenge' };
  const BACKTEST_R = 0.05; // Combined system, average R per trade over FY 2017-25 (research/README.md)
  async function j(url, body) {
    const o = { headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (body) Object.assign(o, { method: 'POST', body: JSON.stringify(body), headers: { ...o.headers, 'Content-Type': 'application/json', 'X-Requested-With': 'MarketMind' } });
    const r = await fetch(url, o); const x = await r.json().catch(() => null);
    if (!r.ok || !x) throw new Error((x && x.error) || `HTTP ${r.status}`); return x;
  }
  const istDay = s => (s ? new Date(Date.parse(s.replace(' ', 'T') + 'Z') + 5.5 * 3600e3).toISOString().slice(0, 10) : '');
  function rOf(t) {
    const e = +t.fill_price || +t.limit_price, risk = t.stop != null ? Math.abs(e - +t.stop) * +t.qty : 0;
    return t.pnl != null && risk > 0 ? +t.pnl / risk : null;
  }
  function fyStart() { const d = new Date(Date.now() + 5.5 * 3600e3), y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${y}-04-01`; }
  const group = (list, key) => { const m = new Map(); list.forEach(t => { const k = key(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }); return [...m]; };
  const avgR = l => { const v = l.map(rOf).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  async function whatIf(btn, t) {
    btn.disabled = true; btn.textContent = '…';
    try {
      const x = await j(`api/chart.php?symbol=${encodeURIComponent(t.symbol + (/^\d{6}$/.test(t.symbol) ? '.BO' : '.NS'))}&interval=1d&range=1y`), r = x.chart.result[0];
      const days = r.timestamp.map(s => new Date(s * 1000 + 5.5 * 3600e3).toISOString().slice(0, 10)), cl = r.indicators.quote[0].close;
      const k = days.findIndex(d => d > istDay(t.closed_at));
      const after = k >= 0 ? cl.slice(k, k + 20).filter(v => v != null) : [];
      if (!after.length) { btn.textContent = 'too recent'; return; }
      const end = after[after.length - 1], ex = +t.exit_price, ch = (end / ex - 1) * 100;
      btn.outerHTML = `<span class="${tone(ch)}" title="Price ${after.length} trading days after the exit, vs the exit price">${ch > 0 ? '+' : ''}${ch.toFixed(1)}% after ${after.length}d${ch > 3 ? ' · sold early' : ch < -3 ? ' · good exit' : ''}</span>`;
    } catch (e) { btn.textContent = 'n/a'; btn.title = e.message; }
  }

  // Trade autopsy: entry quality, how far it went for and against you, the exit, and what the tested exit rule would have made
  async function autopsy(tr, t) {
    const next = tr.nextElementSibling; if (next && next.classList.contains('autopsy-row')) { next.remove(); return; }
    const row = document.createElement('tr'); row.className = 'autopsy-row'; row.innerHTML = '<td colspan="8"><p class="muted">Reviewing the trade…</p></td>'; tr.after(row);
    const cell = row.firstElementChild;
    try {
      const x = await j(`api/chart.php?symbol=${encodeURIComponent(t.symbol + (/^\d{6}$/.test(t.symbol) ? '.BO' : '.NS'))}&interval=1d&range=2y`), r = x.chart.result[0], q = r.indicators.quote[0];
      const B = r.timestamp.map((s, i) => ({ d: new Date(s * 1000 + 5.5 * 3600e3).toISOString().slice(0, 10), h: q.high[i], l: q.low[i], c: q.close[i] })).filter(b => b.c != null);
      const eD = istDay(t.filled_at || t.created_at), xD = istDay(t.closed_at), ei = B.findIndex(b => b.d >= eD), xi = (() => { let k = -1; B.forEach((b, i) => { if (b.d <= xD) k = i; }); return k; })();
      if (ei < 0 || xi < ei) throw new Error('No price history for the trade dates');
      const entry = +t.fill_price || +t.limit_price, exit = +t.exit_price, stop = t.stop != null ? +t.stop : null, short = /sell|short/i.test(t.side || t.action || '');
      const sma = (i, n) => (i >= n - 1 ? B.slice(i - n + 1, i + 1).reduce((a, b) => a + b.c, 0) / n : null), pc = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
      const pts = [];
      // entry
      const s50 = sma(ei, 50), s200 = sma(ei, 200), s20 = sma(ei, 20), hi20 = ei >= 20 ? Math.max(...B.slice(ei - 20, ei).map(b => b.h)) : null;
      if (!short) {
        if (s200) pts.push([entry > s200 && (!s50 || entry > s50), entry > s200 && (!s50 || entry > s50) ? 'Entry was with the trend: above the 50-day and 200-day averages.' : entry > s200 ? 'Entry was below the 50-day average: a weak stock inside a longer uptrend.' : 'Entry was below the 200-day average: against the long-term trend.']);
        if (s20) { const ext = (entry / s20 - 1) * 100; pts.push([ext <= 8, ext > 8 ? `You bought ${ext.toFixed(0)}% above the 20-day average: chasing a stretched move.` : hi20 && entry >= hi20 ? 'You bought a breakout above the 20-day high, not stretched.' : `Entry was ${ext.toFixed(0)}% from the 20-day average: not stretched.`]); }
        pts.push([stop != null, stop != null ? `Stop was set at ₹${stop.toFixed(2)} (${((entry - stop) / entry * 100).toFixed(1)}% risk).` : 'No stop was recorded for this trade.']);
      }
      // during
      const seg = B.slice(ei, xi + 1), best = Math.max(...seg.map(b => b.h)), worst = Math.min(...seg.map(b => b.l)), sign = short ? -1 : 1;
      const mfe = sign * ((short ? worst : best) / entry - 1) * 100, mae = sign * ((short ? best : worst) / entry - 1) * 100, got = sign * (exit / entry - 1) * 100;
      pts.push([mfe <= 0 || got >= mfe * 0.5 || got < 0, `While you held (${seg.length} days) it was ${pc(mfe)} at best and ${pc(mae)} at worst; you took ${pc(got)}.${mfe > 3 && got > 0 && got < mfe * 0.5 ? ' You kept less than half of the best move.' : ''}`]);
      // exit
      const after = B.slice(xi + 1, xi + 21); if (after.length >= 5) { const ch = sign * (after[after.length - 1].c / exit - 1) * 100; pts.push([ch <= 3, `${after.length} days after your exit the price was ${pc(sign * ch)} from it: ${ch > 3 ? 'you left money on the table' : ch < -3 ? 'a good exit' : 'a fair exit'}.`]); }
      // tested rule
      let rule = '';
      if (!short && stop != null && stop < entry) {
        const R = entry - stop; let st = stop, out = null;
        for (let i = ei + 1; i < B.length && i <= ei + 60; i++) { if (B[i].l <= st) { out = [st, B[i].d]; break; } if (B[i].c >= entry + R && i >= 10) st = Math.max(st, Math.min(...B.slice(i - 10, i).map(b => b.l))); if (i === ei + 60) out = [B[i].c, B[i].d]; }
        const mine = (exit - entry) / R;
        rule = out ? `<p><b>Tested exit rule</b> (your stop, then trail the 10-day low once up 1R, 60 days at most): out at ₹${out[0].toFixed(2)} on ${out[1]} for <b class="${tone(out[0] - entry)}">${r2((out[0] - entry) / R)}</b>, against your <b class="${tone(mine)}">${r2(mine)}</b>. ${(out[0] - entry) / R > mine + 0.3 ? 'The rule would have done better.' : (out[0] - entry) / R < mine - 0.3 ? 'Your exit beat the rule this time.' : 'About the same.'}</p>` : '<p class="muted">The tested exit rule is still in the trade today, so there is nothing to compare yet.</p>';
      }
      cell.innerHTML = `<div class="autopsy"><b>Autopsy: ${esc(t.symbol)}</b><ul>${pts.map(([ok, txt]) => `<li class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '!'} ${esc(txt)}</li>`).join('')}</ul>${rule}<p class="citation">Daily prices from Yahoo; intraday fills can differ. One trade proves nothing: look for the same mark repeating across trades.</p></div>`;
    } catch (e) { cell.innerHTML = `<p class="home-empty">${esc(e.message)}</p>`; }
  }

  async function renderPage(el) {
    if (!el) return;
    if (!(root.Account && Account.isAdmin)) { el.innerHTML = '<p class="home-empty">The journal covers trades placed through MarketMind, which only the admin can do.</p>'; return; }
    el.innerHTML = '<p class="muted">Loading trades…</p>';
    let d; try { d = await j('api/trade.php?action=history'); } catch (e) { el.innerHTML = `<p class="home-empty">${esc(e.message)}</p>`; return; }
    const all = d.trades, closed = all.filter(t => t.status === 'closed' && t.pnl != null);
    const month = istDay(new Date().toISOString().replace('T', ' ').slice(0, 19)).slice(0, 7);
    const thisMonth = closed.filter(t => istDay(t.closed_at).startsWith(month));
    // This week's report card: what the scan suggested and what you did (week starts Monday, IST)
    const now = new Date(Date.now() + 5.5 * 3600e3), mon = new Date(now); mon.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7)); const wk = mon.toISOString().slice(0, 10);
    let sw = null; try { sw = await j('api/swing.php?action=latest'); } catch { /* scan not available */ }
    const sNew = sw && sw.open ? sw.open.filter(t => (t.signalDate || '') >= wk) : [], sCl = sw && sw.recentClosed ? sw.recentClosed.filter(t => (t.exitDate || '') >= wk) : [], sR = sCl.reduce((a, t) => a + (t.r || 0), 0);
    const myNew = all.filter(t => istDay(t.filled_at || t.created_at) >= wk), myCl = closed.filter(t => istDay(t.closed_at) >= wk), myP = myCl.reduce((a, t) => a + +t.pnl, 0), myR = myCl.map(rOf).filter(v => v != null).reduce((a, b) => a + b, 0);
    const took = myNew.filter(t => sw && sw.open && sw.open.some(o => o.sym === t.symbol)).length, planTag = myNew.filter(t => t.note_tag === 'plan').length;
    const week = `<section class="home-card"><div class="home-card-head"><h3>This week's report card</h3><span class="muted">since Mon ${esc(wk)}</span></div><div class="home-card-body">
      <div class="plan-stats"><div><span>App suggested</span><b>${sw ? sNew.length + ' buys' : '—'}</b></div><div><span>App's closed trades</span><b class="${tone(sR)}">${sw ? `${sCl.length} · ${r2(sR)}` : '—'}</b></div>
      <div><span>You opened</span><b>${myNew.length}</b><small>${took} from the scan</small></div><div><span>You closed</span><b class="${tone(myP)}">${myCl.length} · ${rs(myP)}</b><small>${myCl.length ? r2(myR) : ''}</small></div></div>
      <p>${!myNew.length && !myCl.length ? 'No trades of your own this week.' : `${planTag} of ${myNew.length} new trade${myNew.length === 1 ? '' : 's'} tagged "Followed plan".`}${sNew.length && !took && myNew.length ? ' None of your new trades came from the scan.' : ''}</p>
      <p class="citation">The app's figures are its paper trades from the evening scan. One week is too short to judge either side.</p></div></section>`;
    const wins = l => (l.length ? Math.round(l.filter(t => +t.pnl > 0).length / l.length * 100) : 0);
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    // Coach: plain-language findings from your own closed trades (needs 10 or more)
    const coach = (() => {
      if (closed.length < 10) return [`The coach needs 10 closed trades to find your patterns; you have ${closed.length}. Keep tagging the mood on each trade.`];
      const out = [], W = closed.filter(t => +t.pnl > 0), L = closed.filter(t => +t.pnl <= 0), days = t => Math.max(0, (Date.parse(t.closed_at) - Date.parse(t.filled_at || t.created_at)) / 864e5), avg = (l, f) => (l.length ? l.reduce((a, t) => a + f(t), 0) / l.length : 0);
      const aw = avg(W, t => +t.pnl), al = Math.abs(avg(L, t => +t.pnl));
      if (W.length && L.length) out.push(aw < al ? `Your average loss (${rs(al)}) is bigger than your average win (${rs(aw)}). Cut losers at the stop and let winners run.` : `Your average win (${rs(aw)}) is bigger than your average loss (${rs(al)}). Keep doing that.`);
      if (W.length && L.length && avg(L, days) > avg(W, days) * 1.3) out.push(`You hold losers longer (${avg(L, days).toFixed(1)} days) than winners (${avg(W, days).toFixed(1)} days): a sign of hoping instead of following the stop.`);
      const by = (f) => group(closed, f).filter(([, l]) => l.length >= 3).map(([k, l]) => [k, avgR(l), l.length]).filter(x => x[1] != null).sort((a, b) => a[1] - b[1]);
      const dw = by(t => DOW[new Date(istDay(t.filled_at || t.created_at) + 'T00:00:00').getDay()]); if (dw.length > 1 && dw[0][1] < 0) out.push(`${dw[0][0]} is your worst day to enter (${r2(dw[0][1])} over ${dw[0][2]} trades).`);
      const md = by(t => TAGS[t.note_tag || ''] || '').filter(x => x[0] && x[0] !== '—'); if (md.length && md[0][1] < 0) out.push(`Trades tagged "${md[0][0]}" lose on average (${r2(md[0][1])} over ${md[0][2]} trades). Skip trades in that state.`);
      let streak = 0, after = []; [...closed].sort((a, b) => a.closed_at.localeCompare(b.closed_at)).forEach(t => { if (streak >= 2) after.push(t); streak = +t.pnl <= 0 ? streak + 1 : 0; });
      if (after.length >= 3 && avgR(after) != null && avgR(after) < (avgR(closed) || 0)) out.push(`After two losses in a row your next trades do worse (${r2(avgR(after))} vs ${r2(avgR(closed))} overall). Take a break after two losses.`);
      return out.length ? out : ['No harmful pattern found in your trades so far.'];
    })();
    // Patterns
    const pat = (title, rows) => `<h4>${title}</h4><table class="screener-table"><tbody>${rows.map(([k, l]) => `<tr><td>${esc(k)}</td><td>${l.length} trades</td><td>${wins(l)}% wins</td><td class="${tone(avgR(l))}">${r2(avgR(l))}</td></tr>`).join('')}</tbody></table>`;
    // Tax: trades closed this financial year (delivery: short-term if held under a year; intraday is speculative income)
    const fy = closed.filter(t => istDay(t.closed_at) >= fyStart());
    const kind = t => (t.product === 'mis' ? 'Intraday (speculative)' : ['option', 'future'].includes(t.product) ? 'F&O (business income)' : (Date.parse(t.closed_at) - Date.parse(t.filled_at || t.created_at)) / 864e5 >= 365 ? 'Long-term gains' : 'Short-term gains');
    const tax = group(fy, kind).map(([k, l]) => [k, l.reduce((a, t) => a + +t.pnl, 0), l.length]);
    el.innerHTML = `
      <div class="home-grid">
        ${week}
        <section class="home-card"><div class="home-card-head"><h3>This month's scorecard</h3></div><div class="home-card-body">
          <div class="money-total"><div><span>Closed trades</span><b>${thisMonth.length}</b></div><div><span>Wins</span><b>${wins(thisMonth)}%</b></div>
          <div><span>Average</span><b class="${tone(avgR(thisMonth))}">${r2(avgR(thisMonth))}</b></div></div>
          <p class="citation">Back-test expectation for the combined system: ${r2(BACKTEST_R)} a trade. ${thisMonth.length < 10 ? 'Fewer than 10 trades this month, so this is mostly luck either way.' : avgR(thisMonth) >= BACKTEST_R ? 'At or above expectation.' : 'Below expectation.'} All time: ${closed.length} trades, ${wins(closed)}% wins, ${r2(avgR(closed))}.</p></div></section>
        <section class="home-card"><div class="home-card-head"><h3>Your coach</h3></div><div class="home-card-body"><ul class="coach-list">${coach.map(c => `<li>${esc(c)}</li>`).join('')}</ul><p class="citation">From your own closed trades in MarketMind. Small samples mislead; treat these as prompts, not rules.</p></div></section>
        <section class="home-card"><div class="home-card-head"><h3>Patterns</h3></div><div class="home-card-body">
          ${closed.length ? pat('By mood', group(closed, t => TAGS[t.note_tag || ''] || '—')) + pat('By weekday', group(closed, t => DOW[new Date(istDay(t.filled_at || t.created_at) + 'T00:00:00').getDay()])) + pat('By product', group(closed, t => t.product)) : '<p class="home-empty">Patterns show after the first closed trades.</p>'}</div></section>
        <section class="home-card"><div class="home-card-head"><h3>Tax view · FY from ${new Date(fyStart() + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</h3></div><div class="home-card-body">
          ${tax.length ? `<table class="screener-table"><tbody>${tax.map(([k, v, n]) => `<tr><td>${esc(k)}</td><td>${n} trades</td><td class="${tone(v)}"><b>${rs(v)}</b></td></tr>`).join('')}</tbody></table>` : '<p class="home-empty">No trades closed this financial year.</p>'}
          <p class="citation">Only trades placed through MarketMind, before charges. Not tax advice; your broker's tax P&amp;L statement is the one to file with.</p></div></section>
      </div>
      <h3 style="margin:18px 0 8px">Trades</h3>
      ${all.length ? `<div class="fno-tablewrap"><table class="screener-table fno-table"><thead><tr><th>Closed</th><th>Stock</th><th>Entry → exit</th><th>P&amp;L</th><th>R</th><th>Review</th><th>Mood</th><th>Note</th></tr></thead><tbody>
        ${all.map(t => `<tr data-id="${t.id}"><td>${esc(istDay(t.closed_at) || 'open')}</td><td><b data-sym="${esc(t.symbol)}">${esc(t.symbol)}</b><br><small class="muted">${esc(t.product)} · ${esc(t.mode)}</small></td>
          <td>${(+t.fill_price || +t.limit_price).toFixed(2)} → ${t.exit_price != null ? (+t.exit_price).toFixed(2) : '—'}</td><td class="${tone(+t.pnl)}">${t.pnl != null ? rs(+t.pnl) : '—'}</td><td class="${tone(rOf(t))}">${r2(rOf(t))}</td>
          <td>${t.status === 'closed' && t.exit_price != null ? '<button class="link-btn" data-autopsy>Autopsy</button>' : '—'}</td>
          <td><select data-tag>${Object.entries(TAGS).map(([k, v]) => `<option value="${k}" ${k === (t.note_tag || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
          <td><textarea data-note rows="1" maxlength="2000" placeholder="Why I entered, what I learned">${esc(t.note || '')}</textarea></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="home-empty">No trades yet. Trades approved on the Orders page show here.</p>'}`;
    el.querySelectorAll('tr[data-id]').forEach(tr => {
      const t = all.find(x => String(x.id) === tr.dataset.id);
      const save = () => j('api/trade.php?action=note', { id: +t.id, note: tr.querySelector('[data-note]').value, tag: tr.querySelector('[data-tag]').value }).then(() => { tr.classList.add('flash-up'); }).catch(e => root.app && app.ui._toast(e.message, 'error'));
      tr.querySelector('[data-note]').onchange = save; tr.querySelector('[data-tag]').onchange = save;
      const w = tr.querySelector('[data-autopsy]'); if (w) w.onclick = () => autopsy(tr, t);
    });
  }
  root.Journal = { renderPage };
})(typeof window !== 'undefined' ? window : globalThis);

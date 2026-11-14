// MarketMind AI — Kundli: turns the Stock page into a full report card (verdict with confidence, fundamentals,
// ownership, F&O picture, risk flags, your own rules, track record), the rule builder, and the Fund kundli.
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }));
  const rs = v => (v == null || !isFinite(v) ? '—' : '₹' + num(v));
  const cr = v => (v == null || !isFinite(v) ? '—' : `₹${Math.round(v / 1e7).toLocaleString('en-IN')} cr`);
  const pct = (v, d = 1) => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
  const tone = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const toast = (m, t) => root.app && app.ui && app.ui._toast(m, t || 'info');
  async function j(url, body) {
    const o = { headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (body) Object.assign(o, { method: 'POST', body: JSON.stringify(body), headers: { ...o.headers, 'Content-Type': 'application/json', 'X-Requested-With': 'MarketMind' } });
    const r = await fetch(url, o); const x = await r.json().catch(() => null);
    if (!r.ok || !x) throw new Error((x && x.error) || `HTTP ${r.status}`); return x;
  }
  const put = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
  const sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((s, v) => s + v, 0) / n : null);
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ---------- metrics used by the verdict and by your rules ----------
  const FIELDS = {
    trendTemplate: 'Trend template (1 = yes)', breakout20: 'Above 20-day high (1 = yes)', sma150: '150-day average',
    price: 'Price ₹', rsi: 'RSI (14)', sma50: '50-day average', sma200: '200-day average', chg1m: '1-month change %', chg3m: '3-month change %',
    from52h: '% from 52-week high', volRatio: 'Volume ÷ 20-day average', pe: 'P/E', roe: 'ROE %', de: 'Debt ÷ equity',
    profitGrowth: 'Profit growth YoY %', promoter: 'Promoter holding %', pledge: 'Pledged %', delivery: 'Delivery %',
  };
  function metrics(md, fund, deliv) {
    const h = (md && md.priceHistory) || [], c = h.map(x => x.close), v = h.map(x => x.volume || 0), p = c[c.length - 1];
    const back = n => (c.length > n ? (p / c[c.length - 1 - n] - 1) * 100 : null);
    const hi = c.length ? Math.max(...c.slice(-252)) : null;
    const q = (fund && fund.q) || [], lastQ = q[q.length - 1], yearAgo = q[q.length - 5];
    const s150 = sma(c, 150), s200ago = c.length > 220 ? sma(c.slice(0, -20), 200) : null, lo = c.length ? Math.min(...c.slice(-252)) : null;
    const hi20 = h.length > 21 ? Math.max(...h.slice(-21, -1).map(x => x.high)) : null;
    return {
      trendTemplate: !!(s150 && sma(c, 200) && s200ago && p > s150 && s150 > sma(c, 200) && sma(c, 200) > s200ago && sma(c, 50) > s150 && lo && p > 1.3 * lo && hi && p > 0.75 * hi) ? 1 : 0,
      breakout20: hi20 && p > hi20 ? 1 : 0, sma150: s150,
      price: p, rsi: root.MarketData && c.length > 15 ? MarketData.rsi(c, 14) : null, sma50: sma(c, 50), sma200: sma(c, 200),
      chg1m: back(21), chg3m: back(63), from52h: hi ? (p / hi - 1) * 100 : null,
      volRatio: v.length > 21 && sma(v.slice(0, -1), 20) ? v[v.length - 1] / sma(v.slice(0, -1), 20) : null,
      pe: fund ? fund.pe : null, roe: fund ? fund.roe : null, de: fund ? fund.de : null,
      profitGrowth: lastQ && yearAgo && lastQ.profit != null && yearAgo.profit ? (lastQ.profit / Math.abs(yearAgo.profit) - Math.sign(yearAgo.profit)) * 100 : null,
      promoter: fund && fund.holding && fund.holding[0] ? fund.holding[0].promoter : null,
      pledge: fund && fund.pledge ? fund.pledge.pct : null, delivery: deliv ? deliv.pct : null,
    };
  }

  // ---------- your rules ----------
  const TEMPLATES = [
    { name: 'Trend template breakout (best in research)', conds: [{ f: 'trendTemplate', op: '>', v: 0.5 }, { f: 'breakout20', op: '>', v: 0.5 }] },
    { name: '52-week high breakout', conds: [{ f: 'from52h', op: '>', v: -3 }, { f: 'volRatio', op: '>', v: 1.5 }, { f: 'price', op: '>', v: 'sma200' }] },
    { name: 'Strong trend pullback', conds: [{ f: 'price', op: '>', v: 'sma200' }, { f: 'sma50', op: '>', v: 'sma200' }, { f: 'rsi', op: '<', v: 45 }] },
    { name: 'Value + momentum', conds: [{ f: 'pe', op: '<', v: 25 }, { f: 'roe', op: '>', v: 15 }, { f: 'chg3m', op: '>', v: 0 }] },
    { name: 'Oversold quality', conds: [{ f: 'rsi', op: '<', v: 30 }, { f: 'roe', op: '>', v: 15 }, { f: 'de', op: '<', v: 1 }] },
  ];
  let RULES = null;
  async function loadRules() {
    if (RULES) return RULES;
    try { RULES = ((await j('api/auth.php?action=settings')).settings || {}).my_rules || []; } catch { RULES = []; }
    return RULES;
  }
  async function saveRules(list) { RULES = list; await j('api/auth.php?action=save_setting', { key: 'my_rules', value: list }); }
  function evalRule(rule, m) {
    const parts = rule.conds.map(c => {
      const a = m[c.f], b = typeof c.v === 'string' ? m[c.v] : +c.v;
      const ok = a == null || b == null ? null : c.op === '>' ? a > b : a < b;
      return { c, a, b, ok };
    });
    const known = parts.filter(p => p.ok !== null);
    return { parts, pass: known.length === parts.length && known.every(p => p.ok), missing: parts.length - known.length };
  }
  const condText = (c, p) => `${FIELDS[c.f] || c.f} ${c.op} ${typeof c.v === 'string' ? (FIELDS[c.v] || c.v) : c.v}${p ? ` <span class="muted">(${p.a == null ? 'no data' : num(p.a)}${typeof c.v === 'string' && p.b != null ? ' vs ' + num(p.b) : ''})</span>` : ''}`;

  // ---------- test a rule: 5 years, 100 stocks, NIFTY above its 200-day; exit like the research's best strategy ----------
  const FUND_FIELDS = ['pe', 'roe', 'de', 'profitGrowth', 'promoter', 'pledge', 'delivery'];
  async function testRule(rule, progress) {
    const conds = rule.conds.filter(c => !FUND_FIELDS.includes(c.f) && !(typeof c.v === 'string' && FUND_FIELDS.includes(c.v)));
    const skipped = rule.conds.length - conds.length;
    if (!conds.length) throw new Error('This rule only uses fundamentals, which have no daily history to test against.');
    const syms = root.Backtest && Backtest.universe ? Backtest.universe() : [];
    const parse = x => MarketData.parseYahooChart(x).candles;
    const nifty = parse(await j('api/chart.php?symbol=%5ENSEI&interval=1d&range=5y'));
    const nUp = new Map(); nifty.forEach((b, i) => { const s2 = i >= 199 ? nifty.slice(i - 199, i + 1).reduce((a, x) => a + x.close, 0) / 200 : null; nUp.set(new Date(b.time).toISOString().slice(0, 10), s2 != null && b.close > s2); });
    const trades = []; let done = 0;
    const one = async sym => {
      let h; try { h = parse(await j(`api/chart.php?symbol=${encodeURIComponent(sym + '.NS')}&interval=1d&range=5y`)); } catch { return; }
      let busy = -1;
      for (let i = 260; i < h.length - 1; i += 1) {
        if (i <= busy) continue;
        const dkey = new Date(h[i].time).toISOString().slice(0, 10);
        if (!nUp.get(dkey)) continue;
        const win = h.slice(Math.max(0, i - 299), i + 1), m = metrics({ priceHistory: win }, null, null);
        if (!conds.every(c => { const a = m[c.f], b = typeof c.v === 'string' ? m[c.v] : +c.v; return a != null && b != null && (c.op === '>' ? a > b : a < b); })) continue;
        // ATR(14), entry next open, stop 2 ATR, trail 10-day low once +1R, max 60 days, 0.25% costs
        let atr = 0; for (let k = i - 13; k <= i; k++) atr += Math.max(h[k].high - h[k].low, Math.abs(h[k].high - h[k - 1].close), Math.abs(h[k].low - h[k - 1].close)); atr /= 14;
        const f = i + 1, fill = h[f].open, risk = 2 * atr; let stop = fill - risk, armed = false, exit = null, e = Math.min(h.length - 1, f + 60);
        for (let k = f; k <= Math.min(h.length - 1, f + 60); k++) {
          if (k > f && armed) stop = Math.max(stop, Math.min(...h.slice(k - 10, k).map(x => x.low)));
          if (h[k].low <= stop) { exit = Math.min(k === f ? fill : h[k].open, stop); e = k; break; }
          if (h[k].high >= fill + risk) armed = true;
        }
        if (exit == null) exit = h[e].close;
        busy = e;
        trades.push({ sym, d: dkey, r: (exit - fill) / risk - 0.0025 * fill / risk, ret: (exit / fill - 1) * 100 - 0.25 });
      }
    };
    const queue = [...syms];
    await Promise.all([1, 2, 3, 4].map(async () => { while (queue.length) { await one(queue.shift()); progress && progress(++done, syms.length); } }));
    const fy = d => { const y = +d.slice(0, 4), mo = +d.slice(5, 7), s0 = mo >= 4 ? y : y - 1; return `FY ${String(s0).slice(2)}-${String(s0 + 1).slice(2)}`; };
    const by = {}; trades.forEach(t => (by[fy(t.d)] = by[fy(t.d)] || []).push(t));
    const st = l => ({ n: l.length, win: l.length ? l.filter(t => t.r > 0).length / l.length * 100 : 0, avg: l.length ? l.reduce((a, t) => a + t.r, 0) / l.length : 0, ret: l.length ? l.reduce((a, t) => a + t.ret, 0) / l.length : 0 });
    return { all: st(trades), years: Object.entries(by).sort().map(([k, l]) => [k, st(l)]), skipped, stocks: syms.length };
  }

  function openRules(onDone) {
    const ov = document.getElementById('modal-overlay');
    let list = (RULES || []).map(r => JSON.parse(JSON.stringify(r))), edit = null;
    const fieldSel = (name, val, withNum) => `<select data-${name}>${withNum ? '<option value="#">a number</option>' : ''}${Object.entries(FIELDS).map(([k, l]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const draw = () => {
      ov.innerHTML = `<div class="modal modal-wide"><button class="modal-close" data-x>&times;</button><h3>My rules</h3>
        <p class="auth-text">A rule is a set of conditions that must all be true. Every kundli shows whether each of your rules passes for that stock.</p>
        ${edit ? `<div class="rule-edit"><label>Rule name <input data-rname value="${esc(edit.name)}" maxlength="60"></label>
          ${edit.conds.map((c, i) => `<div class="rule-row" data-i="${i}">${fieldSel('f', c.f)}<select data-op><option ${c.op === '>' ? 'selected' : ''}>&gt;</option><option ${c.op === '<' ? 'selected' : ''}>&lt;</option></select>
            ${fieldSel('vf', typeof c.v === 'string' ? c.v : '#', true)}<input type="number" step="any" data-vn value="${typeof c.v === 'string' ? '' : esc(c.v)}" ${typeof c.v === 'string' ? 'hidden' : ''}><button class="btn-secondary btn-small" data-rm="${i}">✕</button></div>`).join('')}
          <button class="btn-secondary btn-small" data-addc>+ Condition</button> <button class="btn-primary btn-small" data-save>Save rule</button> <button class="btn-secondary btn-small" data-cancel>Cancel</button></div>`
        : `<ul class="users-list">${list.map((r, i) => `<li class="user-row"><div class="user-main"><b>${esc(r.name)}</b><div class="text-muted user-meta">${r.conds.map(c => condText(c)).join(' · ')}</div></div>
            <div class="user-actions"><button class="btn-primary btn-small" data-test="${i}">Test</button><button class="btn-secondary btn-small" data-ed="${i}">Edit</button><button class="btn-danger btn-small" data-del="${i}">Delete</button></div></li>`).join('') || '<p class="home-empty">No rules yet.</p>'}</ul>
          <p><button class="btn-primary btn-small" data-new>+ New rule</button> <select data-tpl><option value="">Start from a template…</option>${TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('')}</select></p>`}
        <button class="btn-secondary" data-x>Close</button></div>`;
      ov.querySelectorAll('[data-x]').forEach(b => (b.onclick = () => { ov.classList.add('hidden'); ov.innerHTML = ''; onDone && onDone(); }));
      if (edit) {
        const sync = () => ov.querySelectorAll('.rule-row').forEach(r => {
          const c = edit.conds[+r.dataset.i]; c.f = r.querySelector('[data-f]').value; c.op = r.querySelector('[data-op]').value;
          const vf = r.querySelector('[data-vf]').value; c.v = vf === '#' ? +r.querySelector('[data-vn]').value : vf;
        });
        ov.querySelectorAll('[data-vf]').forEach(s => (s.onchange = () => { sync(); draw(); }));
        ov.querySelector('[data-addc]').onclick = () => { sync(); edit.conds.push({ f: 'rsi', op: '<', v: 30 }); draw(); };
        ov.querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => { sync(); edit.conds.splice(+b.dataset.rm, 1); draw(); }));
        ov.querySelector('[data-cancel]').onclick = () => { edit = null; draw(); };
        ov.querySelector('[data-save]').onclick = async () => {
          sync(); edit.name = ov.querySelector('[data-rname]').value.trim() || 'My rule';
          if (!edit.conds.length) return toast('Add at least one condition', 'warning');
          if (edit.i == null) list.push(edit); else list[edit.i] = edit;
          delete edit.i; edit = null;
          try { await saveRules(list.slice(0, 20)); toast('Rule saved', 'success'); } catch (e) { toast(e.message, 'error'); }
          draw();
        };
      } else {
        ov.querySelector('[data-new]').onclick = () => { edit = { name: '', conds: [{ f: 'price', op: '>', v: 'sma200' }] }; draw(); };
        ov.querySelector('[data-tpl]').onchange = e => { if (e.target.value !== '') { edit = JSON.parse(JSON.stringify(TEMPLATES[+e.target.value])); draw(); } };
        ov.querySelectorAll('[data-ed]').forEach(b => (b.onclick = () => { edit = { ...JSON.parse(JSON.stringify(list[+b.dataset.ed])), i: +b.dataset.ed }; draw(); }));
        ov.querySelectorAll('[data-test]').forEach(b => (b.onclick = async () => {
          const r = list[+b.dataset.test], row = b.closest('li'), out = document.createElement('div');
          out.className = 'rule-test'; row.after(out); b.disabled = true;
          try {
            const res = await testRule(r, (n, t) => { out.innerHTML = `<p class="muted">Testing on ${t} stocks, 5 years… ${n}/${t}</p>`; });
            const a = res.all, verdict = a.n < 30 ? 'Too few trades to judge.' : a.avg >= 0.1 && res.years.filter(([, y]) => y.avg > 0).length >= res.years.length * 0.6 ? 'Promising: positive on average and in most years.' : a.avg > 0 ? 'Small edge: positive overall but weak or uneven.' : 'No edge: this rule lost money on average.';
            out.innerHTML = `<p><b>${a.n} trades · ${a.win.toFixed(0)}% winners · average ${a.avg >= 0 ? '+' : ''}${a.avg.toFixed(2)}R (${a.ret >= 0 ? '+' : ''}${a.ret.toFixed(2)}% a trade)</b> — ${verdict}</p>
              <table class="screener-table"><tbody>${res.years.map(([k, y]) => `<tr><td>${k}</td><td>${y.n} trades</td><td>${y.win.toFixed(0)}% win</td><td class="${y.avg > 0 ? 'up' : 'down'}">${y.avg >= 0 ? '+' : ''}${y.avg.toFixed(2)}R</td></tr>`).join('')}</tbody></table>
              <p class="citation">Rules: only while NIFTY is above its 200-day average; buy next day's open; stop 2× ATR; once up 1R the stop trails the 10-day low; out after 60 days; 0.25% costs. ${res.skipped ? `${res.skipped} fundamentals condition(s) left out (no history). ` : ''}For comparison, MarketMind's best researched strategy averaged about +0.10R a trade. Past results don't guarantee future ones.</p>`;
          } catch (e) { out.innerHTML = `<p class="auth-error">${esc(e.message)}</p>`; }
          b.disabled = false;
        }));
        ov.querySelectorAll('[data-del]').forEach(b => (b.onclick = async () => { list.splice(+b.dataset.del, 1); try { await saveRules(list); } catch (e) { toast(e.message, 'error'); } draw(); }));
      }
    };
    ov.classList.remove('hidden'); draw();
  }

  // ---------- F&O picture for stocks and indices with F&O ----------
  async function foPicture(sym) {
    let meta; try { meta = (await j('api/breeze.php?action=fo_meta')).underlyings; } catch (e) { return { err: e.message }; }
    const u = meta.find(x => x.symbol === sym || x.isec === sym);
    if (!u) return null;
    const e = u.options[0], q = `api/breeze.php?action=option_chain&isec=${encodeURIComponent(u.isec)}&expiry=${e}`;
    const [c, p, sp, fut] = await Promise.all([j(q + '&right=call'), j(q + '&right=put'), j(`api/breeze.php?action=fo_spot&isec=${encodeURIComponent(u.isec)}`).catch(() => ({})),
      u.futures[0] ? j(`api/breeze.php?action=futures&isec=${encodeURIComponent(u.isec)}&expiry=${u.futures[0]}`).catch(() => null) : null]);
    const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const strikes = [...new Set([...c.rows, ...p.rows].map(r => r.strike))].sort((a, b) => a - b);
    const co = new Map(c.rows.map(r => [r.strike, r])), po = new Map(p.rows.map(r => [r.strike, r]));
    let pain = null, best = Infinity;
    for (const k of strikes) { let v = 0; for (const s of strikes) v += ((co.get(s) || {}).oi || 0) * Math.max(0, k - s) + ((po.get(s) || {}).oi || 0) * Math.max(0, s - k); if (v < best) { best = v; pain = k; } }
    const top = rows => [...rows].sort((a, b) => (b.oi || 0) - (a.oi || 0))[0] || {};
    const spot = sp.spot, atm = spot ? strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), strikes[0]) : null;
    const ce = co.get(atm) || {}, pe = po.get(atm) || {};
    // Implied volatility of the ATM straddle (Brenner-Subrahmanyam approximation: straddle ≈ 0.8 × S × σ × √T)
    const days = Math.max(1, (Date.parse(e) - Date.now()) / 864e5), straddle = (ce.ltp || 0) + (pe.ltp || 0);
    const iv = spot && straddle ? straddle / (0.8 * spot * Math.sqrt(days / 365)) * 100 : null;
    return { u, expiry: e, pcr: sum(p.rows, 'oi') / (sum(c.rows, 'oi') || 1), pcrChg: sum(p.rows, 'oiChange') / (sum(c.rows, 'oiChange') || 1), pain, callWall: top(c.rows).strike, putWall: top(p.rows).strike,
      spot, atm, ce, pe, straddle, iv, fut, premium: fut && fut.ltp && spot ? (fut.ltp / spot - 1) * 100 : null, futExp: u.futures[0] };
  }

  // ---------- the kundli on the Stock page ----------
  async function enrich(sym, token) {
    const live = () => root.Stock && Stock.state().token === token;
    const [fund, deliv, rec, ev, fo] = await Promise.all([
      j(`api/kundli.php?action=fundamentals&symbol=${encodeURIComponent(sym)}`).catch(e => ({ err: e.message })),
      j(`api/kundli.php?action=delivery&symbol=${encodeURIComponent(sym)}`).catch(() => null),
      j(`api/mindguru.php?action=symbol&symbol=${encodeURIComponent(sym)}`).catch(() => null),
      j(`api/events.php?action=stock&symbol=${encodeURIComponent(sym)}`).catch(() => null),
      foPicture(sym).catch(e => ({ err: e.message })),
      loadRules(),
    ]);
    j('api/swing.php?action=latest').then(d => {
      const hit = d && d.signals && d.signals.find(x => x.sym === sym), open = d && d.open && d.open.find(x => x.sym === sym), near = d && d.near && d.near.find(x => x.sym === sym);
      const msg = hit ? `📈 Today's trend-template breakout (scan ${d.date}): stop ₹${hit.stop}, ${hit.qty} shares for ₹500 risk.` : open ? `📈 In the swing paper record since ${open.signalDate}${open.r != null ? `, now ${open.r > 0 ? '+' : ''}${open.r.toFixed(2)}R` : ''}.` : near ? `👀 Within ${near.gap}% of a trend-template breakout (above ₹${near.trigger}).` : '';
      if (msg && live()) put('kd-swing', `<p class="kd-swing">${msg}</p>`);
    }).catch(() => {});
    if (!live()) return;
    drawFund(fund);
    drawFo(fo);
    drawRecord(rec);
    // the daily/weekly analysis comes from the Stock page itself
    let st = Stock.state();
    for (let i = 0; i < 60 && live() && !(st.md['1d'] && st.calls['1d'] && st.calls['1w'] && st.cs !== undefined); i++) { await wait(500); st = Stock.state(); }
    if (!live()) return;
    const m = metrics(st.md['1d'], fund && !fund.err ? fund : null, deliv);
    drawRules(m);
    const risk = riskFlags(m, fund, deliv, ev);
    drawRisk(risk);
    drawVerdict(verdict(st, m, risk), m);
  }

  function riskFlags(m, fund, deliv, ev) {
    const f = [];
    const next = ev && ev.next; // { date, purpose }
    if (next && next.date) { const d = (Date.parse(next.date) - Date.now()) / 864e5; if (d >= -1 && d <= 4) f.push(['red', `Results / board meeting on ${new Date(next.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}: prices can jump either way`]); }
    if (m.pledge != null && m.pledge > 10) f.push([m.pledge > 25 ? 'red' : 'amber', `${num(m.pledge, 1)}% of promoter shares pledged`]);
    if (deliv && deliv.turnoverLakh != null && deliv.turnoverLakh < 500) f.push(['red', `Thinly traded: only ₹${num(deliv.turnoverLakh / 100, 1)} cr traded on ${esc(deliv.date)}`]);
    if (m.de != null && m.de > 2) f.push(['amber', `High debt: debt is ${num(m.de, 1)}× equity (normal for banks and NBFCs)`]);
    if (m.promoter != null && fund.holding && fund.holding[1] && fund.holding[1].promoter != null && m.promoter < fund.holding[1].promoter - 1) f.push(['amber', `Promoters cut their holding from ${num(fund.holding[1].promoter, 1)}% to ${num(m.promoter, 1)}%`]);
    if (m.profitGrowth != null && m.profitGrowth < -20) f.push(['amber', `Profit fell ${num(-m.profitGrowth, 0)}% year on year in the latest quarter`]);
    return f;
  }

  function verdict(st, m, risk) {
    const c = st.cs && st.cs.conclusion, d = st.calls['1d'] || {}, w = st.calls['1w'] || {}, mk = root.Tiers && Tiers.market ? Tiers.market() : null;
    const checks = [
      ['A tested strategy (Proven / Watch) gives a buy signal', c ? c.tone === 'long' : null],
      ['Daily trend is up', d.trend ? d.trend === 'Bullish' : null],
      ['Weekly trend is up', w.trend ? w.trend === 'Bullish' : null],
      ['Price is above its 200-day average', m.sma200 ? m.price > m.sma200 : null],
      ['Strong uptrend (trend template: 50 > 150 > 200-day, near 52-week high)', m.sma150 ? m.trendTemplate === 1 : null],
      ['Not inside a daily sell (supply) zone', d.action ? d.action !== 'SELL' : null],
      ['RSI is not overbought (below 70)', m.rsi != null ? m.rsi < 70 : null],
      ['NIFTY is above its 200-day average', mk ? mk.above200 : null],
      ['Profit is growing year on year', m.profitGrowth != null ? m.profitGrowth > 0 : null],
      ['Delivery is 40% or more (real buying)', m.delivery != null ? m.delivery >= 40 : null],
    ];
    const known = checks.filter(x => x[1] !== null), pass = known.filter(x => x[1]).length, score = known.length ? pass / known.length : 0;
    const red = risk.filter(r => r[0] === 'red');
    let call, why;
    if ((c && c.tone === 'short') || (d.action === 'SELL' && d.trend === 'Bearish' && w.trend === 'Bearish')) { call = 'SELL'; why = 'Downtrend on daily and weekly, or a tested sell signal: exit or avoid.'; }
    else if (c && c.tone === 'long' && !red.length && score >= 0.6) { call = 'BUY'; why = score >= 0.8 ? 'A tested strategy says buy and most checks agree.' : 'A tested strategy says buy; some checks disagree, so use a smaller size.'; }
    else if (c && c.tone === 'long' && red.length) { call = 'WAIT'; why = 'A tested strategy says buy, but a red risk flag says wait.'; }
    else { call = 'WAIT'; why = c && c.tone !== 'long' ? 'No tested strategy has a buy signal today.' : 'Not enough checks agree.'; }
    const strength = call === 'WAIT' ? '' : score >= 0.8 ? 'strong' : score >= 0.6 ? 'medium' : 'weak';
    const lv = c && c.tone === 'long' ? { entry: c.buyLow === c.buyHigh ? rs(c.buyLow) : `${rs(c.buyLow)}–${rs(c.buyHigh)}`, stop: c.stop, target: c.sell1 } : d.action === 'BUY' ? { entry: rs(d.entry), stop: d.stop, target: d.target } : null;
    return { call, why, strength, checks, pass, total: known.length, lv };
  }

  function drawVerdict(v, m) {
    const mode = (() => { try { return localStorage.getItem('kd_mode') || 'simple'; } catch { return 'simple'; } })();
    const cls = v.call === 'BUY' ? 'buy' : v.call === 'SELL' ? 'sell' : 'wait';
    const top = [...v.checks.filter(x => x[1] === (v.call !== 'BUY' ? false : true)), ...v.checks.filter(x => x[1] === (v.call !== 'BUY'))].filter(x => x[1] !== null).slice(0, 3);
    put('kd-verdict', `<div class="kd-v ${cls}"><div class="kd-call"><b>${v.call}</b>${v.strength ? `<span>${v.strength}</span>` : ''}</div>
      <div class="kd-why"><p><b>${v.pass} of ${v.total} checks pass.</b> ${esc(v.why)}</p>
      ${v.lv ? `<p class="kd-lv">Entry ${v.lv.entry} · Stop ${rs(v.lv.stop)} · Target ${rs(v.lv.target)}${v.lv.stop && m.price ? ` · risk ${pct((v.lv.stop / m.price - 1) * 100)}` : ''}</p>` : ''}
      <ul class="kd-checks">${(mode === 'expert' ? v.checks : top).map(([t, ok]) => `<li class="${ok === null ? 'muted' : ok ? 'up' : 'down'}">${ok === null ? '–' : ok ? '✓' : '✗'} ${esc(t)}</li>`).join('')}</ul>
      <button class="link-btn" data-kdmode>${mode === 'expert' ? 'Simple view' : 'Show all checks (expert)'}</button></div></div>
      <p class="citation">For information, not investment advice. The verdict combines the back-tested strategies with trend, valuation, ownership and risk checks.</p>`);
    const b = document.querySelector('[data-kdmode]');
    if (b) b.onclick = () => { try { localStorage.setItem('kd_mode', mode === 'expert' ? 'simple' : 'expert'); } catch { /* ignore */ } drawVerdict(v, m); };
  }

  function drawFund(f) {
    if (!f || f.err) return put('kd-fund', `<p class="muted">Fundamentals not available${f && f.err ? ': ' + esc(f.err) : ''}.</p>`);
    const q = (f.q || []).slice(-8), maxR = Math.max(...q.map(x => Math.abs(x.revenue || 0)), 1);
    const bars = q.map(x => `<div class="kd-bar" title="${esc(x.period)}: revenue ${cr(x.revenue)}, profit ${cr(x.profit)}"><i style="height:${Math.max(2, (x.revenue || 0) / maxR * 100)}%"></i><i class="p ${x.profit < 0 ? 'neg' : ''}" style="height:${Math.max(2, Math.abs(x.profit || 0) / maxR * 100)}%"></i><small>${new Date(x.period).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })}</small></div>`).join('');
    const h = f.holding || [];
    put('kd-fund', `<div class="money-total"><div><span>P/E</span><b>${f.pe != null ? num(f.pe, 1) : '—'}</b></div><div><span>ROE</span><b>${f.roe != null ? num(f.roe, 1) + '%' : '—'}</b></div><div><span>Debt ÷ equity</span><b>${f.de != null ? num(f.de, 2) : '—'}</b></div></div>
      ${q.length ? `<div class="kd-bars">${bars}</div><p class="muted small"><span class="kd-key"></span> revenue <span class="kd-key p"></span> profit · last ${q.length} quarters (consolidated)</p>` : ''}
      <h4>Ownership</h4>${h.length ? `<table class="screener-table"><thead><tr><th>Quarter</th><th>Promoters</th><th>Public</th></tr></thead><tbody>${h.slice(0, 4).map(x => `<tr><td>${esc(x.date)}</td><td>${x.promoter != null ? num(x.promoter, 2) + '%' : '—'}</td><td>${x.public != null ? num(x.public, 2) + '%' : '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Shareholding not available.</p>'}
      <p class="muted small">Pledged by promoters: ${f.pledge ? (f.pledge.none ? 'none reported' : f.pledge.pct != null ? num(f.pledge.pct, 2) + '%' : 'reported (see NSE)') : 'not available'}. P/E uses the last four quarters' EPS; sources Yahoo Finance and NSE.</p>`);
  }

  function drawFo(fo) {
    const card = document.getElementById('kd-fo-card');
    if (!card) return;
    if (!fo) { card.hidden = true; return; }
    card.hidden = false;
    if (fo.err) return put('kd-fo', `<p class="muted">Needs ICICI logged in today (${esc(fo.err)}).</p>`);
    put('kd-fo', `<div class="money-total"><div><span>PCR (OI)</span><b class="${fo.pcr > 1.2 ? 'up' : fo.pcr < 0.7 ? 'down' : ''}">${num(fo.pcr, 2)}</b></div><div><span>Max pain</span><b>${fo.pain ?? '—'}</b></div><div><span>ATM IV (approx.)</span><b>${fo.iv ? num(fo.iv, 0) + '%' : '—'}</b></div></div>
      <p>Resistance (most call OI) <b>${fo.callWall ?? '—'}</b> · support (most put OI) <b>${fo.putWall ?? '—'}</b></p>
      <p>ATM ${fo.atm ?? '—'}: call ${rs(fo.ce.ltp)} · put ${rs(fo.pe.ltp)} · straddle ${rs(fo.straddle)}${fo.spot && fo.straddle ? ` (move priced in ±${num(fo.straddle / fo.spot * 100, 1)}% by expiry)` : ''}</p>
      ${fo.fut ? `<p>Futures (${esc(fo.futExp)}): ${rs(fo.fut.ltp)} · premium ${pct(fo.premium, 2)} · OI change ${fo.fut.oiChange != null ? num(fo.fut.oiChange, 0) : '—'}</p>` : ''}
      <p class="muted small">Expiry ${esc(fo.expiry)} · lot ${fo.u.lot}. Today's OI change: PCR ${num(fo.pcrChg, 2)} (above 1 = more puts written today, usually supportive). <a href="#" data-gofno>Open option chain</a></p>`);
    const g = document.querySelector('[data-gofno]'); if (g) g.onclick = e => { e.preventDefault(); root.Nav && Nav.go('fno'); };
  }

  function drawRecord(r) {
    if (!r || !r.all || !r.all.n) return put('kd-record', '<p class="muted">MarketMind has no judged calls on this stock yet. Each call it makes is checked automatically once its time has passed.</p>');
    const line = (n, x) => (x.n ? `<li><b>${n}</b>: ${x.n} calls, ${x.wins} worked (${Math.round(x.wins / x.n * 100)}%), average ${x.avgR > 0 ? '+' : ''}${x.avgR}R</li>` : '');
    put('kd-record', `<ul class="kd-rec">${line('Live calls', r.live)}${line('Back-test', r.backtest)}</ul>
      <table class="screener-table"><tbody>${r.recent.map(x => `<tr><td>${esc(x.signal_date)}</td><td>${esc(x.strategy_name)}</td><td>${esc(x.side)}</td><td class="${tone(+x.r_multiple)}">${(+x.r_multiple > 0 ? '+' : '') + (+x.r_multiple).toFixed(2)}R</td></tr>`).join('')}</tbody></table>`);
  }

  function drawRisk(f) {
    put('kd-risk', f.length ? `<ul class="kd-risk">${f.map(([lvl, t]) => `<li class="${lvl}">${lvl === 'red' ? '⛔' : '⚠️'} ${t}</li>`).join('')}</ul><p class="muted small">A red flag turns a buy into WAIT.</p>` : '<p class="up">✓ No risk flags found.</p><p class="muted small">Checked: results date, pledged shares, trading volume, debt, promoter selling, profit fall.</p>');
  }

  function drawRules(m) {
    const list = RULES || [];
    put('kd-rules', `${list.length ? `<ul class="kd-rules">${list.map(r => { const e = evalRule(r, m); return `<li><b class="${e.pass ? 'up' : 'down'}">${e.pass ? '✓ Pass' : e.missing ? '– Incomplete' : '✗ Fail'}</b> ${esc(r.name)}<ul>${e.parts.map(p => `<li class="${p.ok === null ? 'muted' : p.ok ? 'up' : 'down'}">${condText(p.c, p)}</li>`).join('')}</ul></li>`; }).join('')}</ul>` : '<p class="muted">No rules yet. Create one, or start from a template such as "52-week high breakout".</p>'}
      <button class="btn-secondary btn-small" data-kdrules>Manage my rules</button>`);
    const b = document.querySelector('[data-kdrules]'); if (b) b.onclick = () => openRules(() => drawRules(m));
  }

  // ---------- Fund kundli (mutual funds) ----------
  const FS = { code: null };
  function cagr(nav, years) {
    if (!nav.length) return null;
    const end = nav[nav.length - 1], target = new Date(Date.parse(end[0]) - years * 365.25 * 864e5).toISOString().slice(0, 10);
    const start = nav.find(x => x[0] >= target);
    if (!start || Date.parse(nav[0][0]) > Date.parse(target) + 10 * 864e5) return null;
    return (Math.pow(end[1] / start[1], 1 / years) - 1) * 100;
  }
  function navChart(nav, bench) {
    const W = 640, H = 220, P = 30, a = nav[0][1];
    const ys = nav.map(x => x[1] / a), bs = bench ? bench.map(x => x / bench[0]) : [];
    const lo = Math.min(...ys, ...(bs.length ? bs : [1])), hi = Math.max(...ys, ...(bs.length ? bs : [1]));
    const X = (i, n) => P + i / (n - 1) * (W - 2 * P), Y = v => H - P - (v - lo) / (hi - lo || 1) * (H - 2 * P);
    const line = (arr, col) => `<polyline fill="none" stroke="${col}" stroke-width="2" points="${arr.map((v, i) => `${X(i, arr.length).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" class="rot">${bs.length ? line(bs, 'var(--text-muted)') : ''}${line(ys, 'var(--accent)')}
      <text x="${P}" y="${P - 10}" class="rot-l">₹1 invested → ₹${ys[ys.length - 1].toFixed(2)}${bs.length ? ` · NIFTY 50 → ₹${bs[bs.length - 1].toFixed(2)}` : ''}</text>
      <text x="${P}" y="${H - 8}" class="rot-t" style="text-anchor:start">${esc(nav[0][0])}</text><text x="${W - P}" y="${H - 8}" class="rot-t" style="text-anchor:end">${esc(nav[nav.length - 1][0])}</text></svg>`;
  }
  async function renderFund(el, range) {
    el.innerHTML = '<p class="muted">Loading fund…</p>';
    let d; try { d = await j(`api/kundli.php?action=mf&code=${FS.code}`); } catch (e) { el.innerHTML = `<p class="home-empty">${esc(e.message)}</p>`; return; }
    const all = d.nav, meta = d.meta || {}, isDebt = /debt|liquid|money market|gilt|bond|overnight|income/i.test(meta.scheme_category || '');
    const yrs = { '1y': 1, '3y': 3, '5y': 5, all: 99 }[range || '3y'];
    const cut = new Date(Date.now() - yrs * 365.25 * 864e5).toISOString().slice(0, 10), nav = all.filter(x => x[0] >= cut);
    // NIFTY for the same days
    let bench = null, nifty3 = null;
    try {
      const c = (await j('api/chart.php?symbol=%5ENSEI&interval=1d&range=10y')).chart.result[0];
      const days = c.timestamp.map(t => new Date(t * 1000 + 5.5 * 3600e3).toISOString().slice(0, 10)), cl = c.indicators.quote[0].close;
      const map = new Map(); days.forEach((dd, i) => cl[i] && map.set(dd, cl[i]));
      let lastv = null; bench = nav.map(x => { if (map.has(x[0])) lastv = map.get(x[0]); return lastv; });
      if (bench.some(v => v == null)) { const f = bench.find(v => v != null); bench = bench.map(v => v ?? f); }
      const series = days.map((dd, i) => [dd, cl[i]]).filter(x => x[1]); nifty3 = cagr(series, 3);
    } catch { bench = null; }
    // Max fall, 1-year rolling consistency
    let peak = 0, mdd = 0; all.forEach(x => { peak = Math.max(peak, x[1]); mdd = Math.min(mdd, x[1] / peak - 1); });
    const roll = []; for (let i = 0; i < all.length; i += 5) { const t = new Date(Date.parse(all[i][0]) + 365 * 864e5).toISOString().slice(0, 10); const k = all.findIndex(x => x[0] >= t); if (k < 0) break; roll.push(all[k][1] / all[i][1] - 1); }
    const posShare = roll.length ? roll.filter(v => v > 0).length / roll.length * 100 : null;
    const c1 = cagr(all, 1), c3 = cagr(all, 3), c5 = cagr(all, 5);
    let call, why;
    if (c3 == null) { call = 'TOO NEW'; why = 'Less than 3 years of history: judge it again later.'; }
    else if (isDebt) { call = c3 >= 6.5 ? 'KEEP' : 'REVIEW'; why = c3 >= 6.5 ? 'Steady debt-fund returns above a typical fixed deposit.' : 'Returns trail a typical fixed deposit (about 6.5–7%).'; }
    else if (nifty3 != null && c3 >= nifty3 - 1 && (posShare == null || posShare >= 70)) { call = 'KEEP'; why = `3-year return ${num(c3, 1)}% a year vs NIFTY ${num(nifty3, 1)}%, and positive in ${num(posShare, 0)}% of 1-year periods.`; }
    else if (nifty3 != null && c3 < nifty3 - 2) { call = 'REVIEW'; why = `Lagging NIFTY by ${num(nifty3 - c3, 1)}% a year over 3 years: a low-cost NIFTY index fund did better.`; }
    else { call = 'HOLD'; why = 'Close to the market; keep watching.'; }
    el.innerHTML = `<div class="st-head card"><div class="st-id"><h2>${esc(meta.scheme_name || 'Fund')}</h2><p>${esc(meta.fund_house || '')} · ${esc(meta.scheme_category || '')}</p></div>
        <div class="st-px"><b>₹${num(all[all.length - 1][1], 4)}</b><span class="muted">NAV ${esc(all[all.length - 1][0])}</span></div></div>
      <div class="kd-v ${call === 'KEEP' ? 'buy' : call === 'REVIEW' ? 'sell' : 'wait'}"><div class="kd-call"><b>${call}</b></div><div class="kd-why"><p>${esc(why)}</p></div></div>
      <section class="card st-card"><div class="st-card-head"><h3>Growth of ₹1</h3><div class="chips">${['1y', '3y', '5y', 'all'].map(r => `<button data-r="${r}" class="${r === (range || '3y') ? 'active' : ''}">${r === 'all' ? 'All' : r.toUpperCase()}</button>`).join('')}</div></div>
        ${nav.length > 2 ? navChart(nav, isDebt ? null : bench) : '<p class="muted">Not enough history for this range.</p>'}</section>
      <div class="money-total kd-mf"><div><span>1 year</span><b class="${tone(c1)}">${pct(c1)}</b></div><div><span>3 years (a year)</span><b class="${tone(c3)}">${pct(c3)}</b></div><div><span>5 years (a year)</span><b class="${tone(c5)}">${pct(c5)}</b></div>
        <div><span>Worst fall</span><b class="down">${pct(mdd * 100)}</b></div><div><span>Positive 1-year periods</span><b>${posShare != null ? num(posShare, 0) + '%' : '—'}</b></div>${!isDebt ? `<div><span>NIFTY 50, 3 years</span><b>${pct(nifty3)}</b></div>` : ''}</div>
      <p class="citation">NAV from AMFI via mfapi.in. Expense ratio and holdings are not in this free source; check the fund's factsheet. For information, not investment advice.</p>`;
    el.querySelectorAll('[data-r]').forEach(b => (b.onclick = () => renderFund(el, b.dataset.r)));
  }
  async function renderFundPage(container) {
    if (!container) return;
    container.innerHTML = `<div class="kd-fsearch card"><input type="search" id="kd-fq" placeholder="Search a mutual fund, e.g. Parag Parikh Flexi Cap Direct Growth" autocomplete="off"><ul id="kd-flist" class="kd-flist"></ul></div><div id="kd-fund-body"></div>`;
    const q = container.querySelector('#kd-fq'), list = container.querySelector('#kd-flist'), body = container.querySelector('#kd-fund-body');
    let t = null;
    q.oninput = () => { clearTimeout(t); t = setTimeout(async () => {
      if (q.value.trim().length < 3) { list.innerHTML = ''; return; }
      try {
        const r = await j(`api/kundli.php?action=mf_search&q=${encodeURIComponent(q.value.trim())}`);
        const sorted = r.funds.sort((a, b) => (/direct/i.test(b.name) && /growth/i.test(b.name)) - (/direct/i.test(a.name) && /growth/i.test(a.name)));
        list.innerHTML = sorted.map(f => `<li data-code="${f.code}">${esc(f.name)}</li>`).join('') || '<li class="muted">No fund found</li>';
        list.querySelectorAll('[data-code]').forEach(li => (li.onclick = () => { FS.code = +li.dataset.code; list.innerHTML = ''; q.value = li.textContent; try { localStorage.setItem('kd_fund', FS.code); } catch { /* ignore */ } renderFund(body); }));
      } catch (e) { list.innerHTML = `<li class="muted">${esc(e.message)}</li>`; }
    }, 350); };
    if (!FS.code) { try { FS.code = +localStorage.getItem('kd_fund') || null; } catch { /* none */ } }
    if (FS.code) renderFund(body); else body.innerHTML = '<p class="home-empty">Search for a fund to see its kundli: growth vs NIFTY, returns, worst fall, consistency and a Keep / Review call.</p>';
  }

  root.Kundli = { enrich, openRules, renderFundPage, metrics, FIELDS };
})(typeof window !== 'undefined' ? window : globalThis);

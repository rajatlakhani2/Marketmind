// MarketMind AI — Home market overview.
// Index tiles · the four size groups (NIFTY 50, Next 50, Midcap 150, Smallcap 250) with breadth · a heat map of
// every share in a group, filterable by sector · sector table with a BUY / BUY ON DIP / WAIT / AVOID call per sector.
//
// How a sector call is made (decided 11 Nov 2026):
//   1. Tested strategies on the sector index (daily): Proven count in full, Watch half, Not proven not at all.
//   2. Demand / supply zones on the sector index (daily, weekly, monthly).
//   3. Breadth: share of the sector's stocks above their 50-day and 200-day averages.
//   4. News: Google News headlines scored with a word list. Context only: it adds a "News caution" or
//      "News supportive" flag but never changes the call.
// Sectors with no index history on Yahoo (Capital Goods, Chemicals, Cement, Consumer Durables, Media, Services,
// Telecom, Textiles, Diversified) are called from breadth alone, tagged "Breadth only".
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (v, d = 2) => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
  const tone = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const avg = a => { const b = a.filter(v => v != null && isFinite(v)); return b.length ? b.reduce((x, y) => x + y, 0) / b.length : null; };
  const share = (a, k) => { const b = a.filter(r => r[k] != null); return b.length ? Math.round(b.filter(r => r[k] === 1).length / b.length * 100) : null; };

  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }

  const GROUPS = [['A', 'All 500'], ['L', 'NIFTY 50'], ['N', 'Next 50'], ['M', 'Midcap 150'], ['S', 'Smallcap 250']];
  const PERIODS = [['d1', 'Today'], ['w1', '1 week'], ['m1', '1 month'], ['m3', '3 months']];
  const S = { data: null, news: null, scan: null, group: 'A', period: 'd1', sector: '', idx: {}, open: null, el: null };

  // rows from the server: [sym, g, i, last, d1, w1, m1, m3, a50, a200]
  const rowObj = r => ({ sym: r[0], g: r[1], i: r[2], last: r[3], d1: r[4], w1: r[5], m1: r[6], m3: r[7], a50: r[8], a200: r[9] });
  const rows = () => (S.data ? S.data.rows.map(rowObj) : []);
  const inGroup = r => S.group === 'A' || r.g === S.group;

  function stats(list) {
    return { n: list.length, adv: list.filter(r => r.d1 > 0).length, dec: list.filter(r => r.d1 < 0).length,
      d1: avg(list.map(r => r.d1)), w1: avg(list.map(r => r.w1)), m1: avg(list.map(r => r.m1)), m3: avg(list.map(r => r.m3)),
      a50: share(list, 'a50'), a200: share(list, 'a200') };
  }

  // ---------- layout ----------
  function render(el) {
    S.el = el;
    el.innerHTML = `
      <div class="ov-tiles" id="ov-tiles">${'<div class="idx"><span>&nbsp;</span><b class="skeleton-text">—</b><small>&nbsp;</small></div>'.repeat(4)}</div>
      <section class="home-card ov-card" id="ov-groups"><div class="home-card-head"><h3>Large, mid and small caps</h3><small class="muted" id="ov-at"></small></div><div class="home-card-body"><div class="skeleton"></div><div class="skeleton short"></div></div></section>
      <section class="home-card ov-card" id="ov-sectors"><div class="home-card-head"><h3>Sectors · calls</h3><small class="muted">strategies + demand/supply + breadth · news as context</small></div><div class="home-card-body"><div class="skeleton"></div><div class="skeleton short"></div></div></section>
      <section class="home-card ov-card" id="ov-map"><div class="home-card-head"><h3>Shares</h3></div><div class="home-card-body"><div class="skeleton"></div></div></section>`;
    load();
  }

  async function load() {
    try {
      S.data = await getJSON('api/overview.php?action=market');
    } catch (e) {
      ['ov-groups', 'ov-sectors', 'ov-map'].forEach(id => fill(id, `<p class="home-empty">Market overview not available: ${esc(e.message)}</p>`));
      return;
    }
    tiles(); groups(); sectors(); heat();
    // slower extras: news, last scan, sector index analysis
    getJSON('api/overview.php?action=news').then(j => { S.news = j; sectors(); }).catch(() => { S.news = { error: true }; sectors(); });
    getJSON('api/scan.php?action=latest').then(j => { S.scan = j.rows || []; sectors(); }).catch(() => {});
    analyzeIndices();
  }

  const fill = (id, html) => { const b = S.el && S.el.querySelector(`#${id} .home-card-body`); if (b) b.innerHTML = html; };

  function tiles() {
    const el = S.el.querySelector('#ov-tiles');
    const t = S.data.tiles.filter(x => x.last != null);
    el.innerHTML = t.map(x => `<div class="idx" title="1 month ${pct(x.m1)}"><span>${esc(x.name)}</span><b>${num(x.last)}</b><small class="${x.sym === '^INDIAVIX' ? tone(-x.d1) : tone(x.d1)}">${pct(x.d1)}</small></div>`).join('');
    const at = new Date(S.data.at * 1000);
    const a = S.el.querySelector('#ov-at');
    if (a) a.textContent = `Yahoo, ~15 min delayed · ${at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  }

  function groups() {
    const all = rows();
    const tileOf = sym => S.data.tiles.find(t => t.sym === sym) || {};
    const line = (g, name, list, idxSym) => {
      const s = stats(list), t = idxSym ? tileOf(idxSym) : {};
      return `<tr data-g="${g}" class="${S.group === g ? 'sel' : ''}"><td><b>${esc(name)}</b>${t.last ? `<small class="muted"> ${num(t.last, 0)}</small>` : ''}</td>
        <td class="${tone(t.d1 ?? s.d1)}">${pct(t.d1 ?? s.d1)}</td><td class="${tone(t.m1 ?? s.m1)} hide-xs">${pct(t.m1 ?? s.m1, 1)}</td>
        <td class="hide-xs"><span class="up">${s.adv}</span>/<span class="down">${s.dec}</span></td><td>${bar(s.a50)}</td><td class="hide-xs">${bar(s.a200)}</td></tr>`;
    };
    fill('ov-groups', `<div class="tbl-wrap"><table class="ov-table"><thead><tr><th>Group</th><th>Today</th><th class="hide-xs">1 month</th><th class="hide-xs">Up/Down</th><th>&gt; 50-day</th><th class="hide-xs">&gt; 200-day</th></tr></thead><tbody>
      ${Object.entries(S.data.groups).map(([g, m]) => line(g, m.name, all.filter(r => r.g === g), m.index)).join('')}
      ${line('A', 'NIFTY 500', all, '^CRSLDX')}
      </tbody></table></div>
      <p class="muted small">${breadthSay(stats(all))} Tap a group to see its shares and sectors.</p>`);
    S.el.querySelectorAll('#ov-groups tr[data-g]').forEach(tr => { tr.onclick = () => { S.group = tr.dataset.g; groups(); sectors(); heat(); }; });
  }

  const bar = v => v == null ? '—' : `<span class="ov-bar"><i style="width:${v}%" class="${v >= 60 ? 'up' : v < 40 ? 'down' : ''}"></i></span><small>${v}%</small>`;
  function breadthSay(s) {
    if (s.a50 == null) return '';
    return s.a50 >= 65 ? `Broad strength: ${s.a50}% of shares are above their 50-day average.`
      : s.a50 >= 50 ? `Mildly positive: ${s.a50}% of shares are above their 50-day average.`
      : s.a50 >= 35 ? `Mixed: only ${s.a50}% of shares are above their 50-day average.`
      : `Weak: just ${s.a50}% of shares are above their 50-day average.`;
  }

  // ---------- sector index analysis (daily, weekly, monthly) ----------
  async function analyzeIndices() {
    const k = root.app && root.app.analysis && root.app.analysis.knowledge;
    if (!k || !root.Consensus || !root.KS001) return;
    if (root.Tiers) await Tiers.ready().catch(() => {});
    const brain = root.MindGuru ? await MindGuru.getBrain().catch(() => null) : null;
    const syms = [...new Set(Object.values(S.data.sectors).map(s => s.index).filter(Boolean))];
    for (const sym of syms) {
      try {
        const j = await getJSON(`api/chart.php?symbol=${encodeURIComponent(sym)}&interval=1d&range=2y`);
        const { candles, meta } = MarketData.parseYahooChart(j);
        const hist = candles.filter(c => c && isFinite(c.close));
        if (hist.length < 120) throw new Error('not enough history');
        const md = MarketData.buildMarketData({ symbol: sym, timeframe: '1d', candles: hist, meta, source: 'Yahoo' });
        const ks = KS001.analyze({ price: md.price, ltf: { tf: '1d', candles: hist }, itf: { tf: '1w', candles: MarketData.aggregateByPeriod(hist, 'week') }, htf: { tf: '1mo', candles: MarketData.aggregateByPeriod(hist, 'month') } });
        const cs = Consensus.run({ md, ks, strategies: k.strategies, check: (c, d) => k.checkConditionDetail(c, d), learned: brain ? brain.strategies : null });
        S.idx[sym] = { md, ks, cs };
      } catch (e) { S.idx[sym] = { error: e.message }; }
      sectors();
    }
  }

  // ---------- the call ----------
  function sectorCall(i, list) {
    const sec = S.data.sectors[i], s = stats(list);
    const A = sec.index ? S.idx[sec.index] : null;
    const why = [];
    let action = 'WAIT', tn = 'wait', tag = '', level = null;
    const bOk = s.a50 != null && s.a50 >= 50, bWeak = s.a50 != null && s.a50 < 35;
    if (A && A.md) {
      const { md, ks, cs } = A, c = cs.conclusion, p = md.price;
      const D = ks.nearestDemand[0] || null, Z = ks.nearestSupply[0] || null;
      const inD = D && p <= D.proximal * 1.003 && p >= D.distal, inS = Z && p >= Z.proximal * 0.997 && p <= Z.distal;
      const htf = ks.trends.htf.trend, up200 = md.ma200 != null ? p > md.ma200 : null;
      const counted = c.tone === 'long' && (c.score || 0) >= 0.4 && htf !== 'Bearish';
      why.push(`Index ${up200 == null ? '' : up200 ? 'above' : 'below'} its 200-day average; monthly trend ${String(htf).toLowerCase()}.`);
      if (counted) why.push(`Tested strategies on the index: ${c.supporting.join(', ')}.`);
      else if ((c.notCounted || []).length) why.push(`Signals on the index that are not proven (not counted): ${c.notCounted.slice(0, 3).join(', ')}.`);
      if (inD) why.push(`Index is in a demand zone (${num(D.distal, 0)}–${num(D.proximal, 0)}).`);
      else if (D) why.push(`Nearest demand zone ${num(D.proximal, 0)} (${pct((D.proximal / p - 1) * 100, 1)}).`);
      if (inS) why.push(`Index is in a supply zone (${num(Z.proximal, 0)}–${num(Z.distal, 0)}).`);
      else if (Z) why.push(`Nearest supply zone ${num(Z.proximal, 0)} (${pct((Z.proximal / p - 1) * 100, 1)}).`);
      if (inS || (bWeak && up200 === false)) { action = 'AVOID'; tn = 'sell'; tag = 'zone'; why.unshift(inS ? 'At supply: book profits, avoid new buys.' : 'Weak breadth and the index is below its 200-day average.'); }
      else if (counted && bOk) { action = 'BUY'; tn = 'buy'; tag = c.backing; level = { buy: c.buyLow, stop: c.stop, t1: c.sell1 }; }
      else if (up200 && bOk && D && (inD || D.proximal / p > 0.96)) { action = 'BUY ON DIP'; tn = 'dip'; tag = 'zone'; level = { buy: D.proximal, stop: D.stop }; why.unshift(`Uptrend with good breadth: buy near the demand zone at ${num(D.proximal, 0)}.`); }
    } else {
      tag = 'breadth';
      if (sec.index && A && A.error) why.push(`Index data not available (${A.error}); using breadth only.`);
      else if (sec.index && !A) why.push('Index analysis loading…');
      else why.push('No sector index history on Yahoo: called from the breadth of its shares only.');
      if (bWeak && s.a200 != null && s.a200 < 40) { action = 'AVOID'; tn = 'sell'; }
      else if (s.a50 >= 60 && s.a200 >= 60 && s.m1 > 0) { action = 'BUY ON DIP'; tn = 'dip'; why.unshift('Broad uptrend across its shares: buy strong shares on dips.'); }
    }
    why.push(`${s.a50 ?? '—'}% of its ${s.n} shares are above the 50-day average, ${s.a200 ?? '—'}% above the 200-day.`);
    const nw = S.news && S.news.sectors ? S.news.sectors[i] : null;
    let flag = '';
    if (nw && nw.score <= -3 && (action === 'BUY' || action === 'BUY ON DIP')) flag = '<span class="tier tier-caution">News caution</span>';
    else if (nw && nw.score >= 3 && action !== 'AVOID') flag = '<span class="tier tier-proven">News supportive</span>';
    return { i, sec, s, action, tn, tag, level, why, nw, flag };
  }

  const tagHtml = t => t === 'proven' ? '<span class="tier tier-proven">Proven</span>' : t === 'watch' ? '<span class="tier tier-watch">Watch</span>'
    : t === 'zone' ? '<span class="tier tier-unproven">Zone · not proven</span>' : t === 'breadth' ? '<span class="tier tier-unproven">Breadth only</span>' : '';
  const ORDER = { BUY: 0, 'BUY ON DIP': 1, WAIT: 2, AVOID: 3 };

  function sectors() {
    if (!S.data) return;
    const all = rows().filter(inGroup);
    const calls = Object.keys(S.data.sectors).map(Number)
      .map(i => ({ i, list: all.filter(r => r.i === i) })).filter(x => x.list.length >= 2)
      .map(x => sectorCall(x.i, x.list))
      .sort((a, b) => ORDER[a.action] - ORDER[b.action] || (b.s.m1 ?? -99) - (a.s.m1 ?? -99));
    const gName = GROUPS.find(g => g[0] === S.group)[1];
    fill('ov-sectors', `<p class="muted small">Sectors in <b>${esc(gName)}</b> · tap a sector for the reasons, its best shares and the news.${S.news && S.news.error ? ' News not available right now.' : ''}</p>
      <div class="tbl-wrap"><table class="ov-table ov-sec"><thead><tr><th>Sector</th><th>Call</th><th>Today</th><th class="hide-xs">1 month</th><th>Breadth</th><th class="hide-xs">News</th></tr></thead><tbody>
      ${calls.map(c => `<tr data-sec="${c.i}" class="${S.open === c.i ? 'sel' : ''}"><td><b>${esc(c.sec.short)}</b><small class="muted"> ${c.s.n}</small></td>
        <td><span class="wl-call ${c.tn}">${c.action}</span></td>
        <td class="${tone(c.sec.d1 ?? c.s.d1)}">${pct(c.sec.d1 ?? c.s.d1)}</td><td class="hide-xs ${tone(c.sec.m1 ?? c.s.m1)}">${pct(c.sec.m1 ?? c.s.m1, 1)}</td>
        <td>${bar(c.s.a50)}</td><td class="hide-xs">${c.nw ? `<span class="${tone(c.nw.score)}">${c.nw.score > 0 ? '+' : ''}${c.nw.score}</span>` : '…'}</td></tr>
        ${S.open === c.i ? `<tr class="ov-detail"><td colspan="6">${detail(c, all)}</td></tr>` : ''}`).join('')}
      </tbody></table></div>`);
    S.el.querySelectorAll('#ov-sectors tr[data-sec]').forEach(tr => {
      tr.onclick = () => { const i = +tr.dataset.sec; S.open = S.open === i ? null : i; sectors(); };
    });
    S.el.querySelectorAll('#ov-sectors [data-sym]').forEach(b => { b.onclick = e => { e.stopPropagation(); root.Stock && Stock.open(b.dataset.sym); }; });
    S.el.querySelectorAll('#ov-sectors [data-filter]').forEach(b => { b.onclick = e => { e.stopPropagation(); S.sector = b.dataset.filter; heat(); S.el.querySelector('#ov-map').scrollIntoView({ behavior: 'smooth' }); }; });
  }

  function detail(c, all) {
    const members = all.filter(r => r.i === c.i && r.last != null);
    const strongScan = new Set((S.scan || []).filter(r => r.verdict === 'Buy' && (root.Tiers ? Tiers.isStrong(r) : r.agree >= 2)).map(r => r.symbol));
    const best = members.filter(r => r.a50 === 1).sort((a, b) => (b.m1 ?? -99) - (a.m1 ?? -99)).slice(0, 6);
    const weak = members.filter(r => r.a50 === 0).sort((a, b) => (a.m1 ?? 99) - (b.m1 ?? 99)).slice(0, 4);
    const chip = r => `<button type="button" class="ov-chip" data-sym="${esc(r.sym)}"><b>${esc(r.sym)}</b> <span class="${tone(r.m1)}">${pct(r.m1, 1)}</span>${strongScan.has(r.sym) ? ' <span class="tier tier-proven sm">Strong buy</span>' : ''}</button>`;
    const lv = c.level ? `<p><b>Index levels:</b> buy ${num(c.level.buy, 0)} · stop ${num(c.level.stop, 0)}${c.level.t1 ? ` · target ${num(c.level.t1, 0)}` : ''}</p>` : '';
    const nw = c.nw;
    return `<div class="ov-why">
      <p><span class="wl-call ${c.tn}">${c.action}</span>${tagHtml(c.tag)}${c.flag}${c.sec.index ? ` <small class="muted">index ${esc(c.sec.index)}${c.sec.last ? ' ' + num(c.sec.last, 0) : ''}</small>` : ''}</p>
      <ul>${c.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>${lv}
      ${best.length ? `<p class="small"><b>Strongest shares</b> (above 50-day, best 1 month):</p><div class="ov-chips">${best.map(chip).join('')}</div>` : ''}
      ${weak.length ? `<p class="small"><b>Weakest</b>:</p><div class="ov-chips">${weak.map(chip).join('')}</div>` : ''}
      <p><button type="button" class="link-btn" data-filter="${c.i}">All ${members.length} shares on the heat map ›</button></p>
      ${nw && nw.items && nw.items.length ? `<p class="small"><b>News, last 3 days</b> (score ${nw.score > 0 ? '+' : ''}${nw.score}: ${nw.pos} positive, ${nw.neg} negative headlines; context only)</p>
        <ul class="ov-news">${nw.items.slice(0, 6).map(n => `<li><span class="${n.s > 0 ? 'up' : n.s < 0 ? 'down' : 'muted'}">${n.s > 0 ? '▲' : n.s < 0 ? '▼' : '•'}</span> <a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a> <small class="muted">${esc(n.source)}</small></li>`).join('')}</ul>`
        : `<p class="muted small">${S.news ? 'No sector headlines in the last 3 days.' : 'News loading…'}</p>`}
    </div>`;
  }

  // ---------- heat map of shares ----------
  function heat() {
    if (!S.data) return;
    const secs = S.data.sectors;
    let list = rows().filter(inGroup).filter(r => r.last != null);
    if (S.sector !== '') list = list.filter(r => r.i === +S.sector);
    const k = S.period;
    list.sort((a, b) => (b[k] ?? -999) - (a[k] ?? -999));
    const scale = { d1: 3, w1: 6, m1: 12, m3: 20 }[k];
    const color = v => {
      if (v == null) return 'var(--bg-hover)';
      const a = Math.min(1, Math.abs(v) / scale) * 0.85 + 0.12;
      return v >= 0 ? `rgba(22,163,74,${a.toFixed(2)})` : `rgba(220,38,38,${a.toFixed(2)})`;
    };
    const top = list.slice(0, 5), bottom = list.slice(-5).reverse();
    const gName = GROUPS.find(g => g[0] === S.group)[1];
    const S2 = stats(list);
    fill('ov-map', `
      <div class="ov-ctrl">
        <select id="ov-g">${GROUPS.map(([g, n]) => `<option value="${g}"${S.group === g ? ' selected' : ''}>${n}</option>`).join('')}</select>
        <select id="ov-s"><option value="">All sectors</option>${Object.entries(secs).map(([i, s]) => `<option value="${i}"${S.sector === i ? ' selected' : ''}>${esc(s.short)}</option>`).join('')}</select>
        <select id="ov-p">${PERIODS.map(([p, n]) => `<option value="${p}"${S.period === p ? ' selected' : ''}>${n}</option>`).join('')}</select>
      </div>
      <p class="muted small">${esc(gName)}${S.sector !== '' ? ' · ' + esc(secs[S.sector].short) : ''}: ${list.length} shares, average ${pct(S2[k])}, ${S2.adv} up / ${S2.dec} down today. Tap a share to open it.</p>
      <div class="ov-heat">${list.map(r => `<button type="button" data-sym="${esc(r.sym)}" style="background:${color(r[k])}" title="${esc(r.sym)} · ${esc(secs[r.i].short)} · ₹${num(r.last)}"><b>${esc(r.sym)}</b><small>${pct(r[k], 1)}</small></button>`).join('')}</div>
      ${list.length > 10 ? `<div class="ov-tops"><div><h4>Top</h4>${top.map(r => `<p data-sym="${esc(r.sym)}"><b>${esc(r.sym)}</b> <span class="up">${pct(r[k])}</span></p>`).join('')}</div>
        <div><h4>Bottom</h4>${bottom.map(r => `<p data-sym="${esc(r.sym)}"><b>${esc(r.sym)}</b> <span class="down">${pct(r[k])}</span></p>`).join('')}</div></div>` : ''}
      ${S.data.missing ? `<p class="muted small">${S.data.missing} shares had no price from Yahoo.</p>` : ''}`);
    const el = S.el.querySelector('#ov-map');
    el.querySelector('#ov-g').onchange = e => { S.group = e.target.value; groups(); sectors(); heat(); };
    el.querySelector('#ov-s').onchange = e => { S.sector = e.target.value; heat(); };
    el.querySelector('#ov-p').onchange = e => { S.period = e.target.value; heat(); };
    el.querySelectorAll('[data-sym]').forEach(b => { b.onclick = () => root.Stock && Stock.open(b.dataset.sym); });
  }

  root.Overview = { render, _sectorCall: sectorCall, _state: S };
})(typeof window !== 'undefined' ? window : globalThis);

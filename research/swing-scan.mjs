// Daily swing scan (GitHub Actions, trading days after the close): NIFTY 500 trend-template + 20-day-high breakouts,
// and a paper record of every signal with the research's rules, so the strategy proves itself (or not) going forward.
//   entry next day's open · stop 2×ATR(14) · once up 1R the stop trails the 10-day low · out after 60 days · 0.25% costs
//   new signals only while NIFTY is above its 200-day average; one trade per stock at a time
// Usage: node research/swing-scan.mjs <state.json> <out swing.json>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [statePath, outPath] = process.argv.slice(2);
const IST = 5.5 * 3600e3, dkey = s => new Date(s * 1000 + IST).toISOString().slice(0, 10);

// NIFTY 500 from assets/api/lib/universe.php
const php = readFileSync(new URL('../assets/api/lib/universe.php', import.meta.url), 'utf8');
const inds = [...php.match(/const MM_INDUSTRIES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
const U = {};
for (const m of php.matchAll(/'([LNMS])' => '([^']+)'/g)) for (const part of m[2].split('|')) { const [i, syms] = part.split(':'); for (const s of syms.trim().split(/\s+/)) if (s) U[s] = { g: m[1], ind: inds[+i] || '' }; }

async function chart(sym) {
  if (process.env.DATA_DIR) { // offline test with the research-data branch (99 stocks)
    const { gunzipSync } = await import('node:zlib'); const { join } = await import('node:path');
    try { const res = JSON.parse(gunzipSync(readFileSync(join(process.env.DATA_DIR, sym.replace(/[^A-Za-z0-9&.-]/g, '_') + '.json.gz')))).chart.result[0], q = res.indicators.quote[0], out = [];
      res.timestamp.forEach((t, i) => { const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i]; if ([o, h, l, c].every(v => v != null && v > 0)) out.push({ d: dkey(t), o, h, l, c, v: q.volume[i] || 0 }); });
      return out.slice(-500); } catch { return null; }
  }
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], out = [];
      res.timestamp.forEach((t, i) => { const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i]; if ([o, h, l, c].every(v => v != null && v > 0)) out.push({ d: dkey(t), o, h, l, c, v: q.volume[i] || 0 }); });
      return out;
    } catch { await new Promise(r => setTimeout(r, 1200)); }
  }
  return null;
}
const sma = (a, n, i) => (i + 1 >= n ? a.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n : null);
const atrAt = (b, i) => { let s = 0; for (let k = i - 13; k <= i; k++) s += Math.max(b[k].h - b[k].l, Math.abs(b[k].h - b[k - 1].c), Math.abs(b[k].l - b[k - 1].c)); return s / 14; };
function setup(b, i) {
  const c = b.map(x => x.c), p = c[i];
  const s50 = sma(c, 50, i), s150 = sma(c, 150, i), s200 = sma(c, 200, i), s200a = sma(c, 200, i - 20);
  if (!s200a) return null;
  const w = c.slice(Math.max(0, i - 251), i + 1), hi = Math.max(...w), lo = Math.min(...w), hi20 = Math.max(...b.slice(i - 20, i).map(x => x.h));
  const trend = p > s150 && s150 > s200 && s200 > s200a && s50 > s150 && p > 1.3 * lo && p > 0.75 * hi;
  return { trend, breakout: p > hi20, hi20, gap: (hi20 / p - 1) * 100, s50, s200 };
}
// Replays one paper trade from its signal day over the bars we have
function replay(t, b) {
  const si = b.findIndex(x => x.d === t.signalDate); if (si < 0) return t;
  const f = si + 1; if (f >= b.length) return { ...t, status: 'pending' };
  const fill = b[f].o, risk = 2 * t.atr; let stop = fill - risk, armed = false;
  for (let k = f; k < b.length; k++) {
    if (k > f && armed) stop = Math.max(stop, Math.min(...b.slice(k - 10, k).map(x => x.l)));
    const exitAt = (px, why) => ({ ...t, entryDate: b[f].d, entry: +fill.toFixed(2), stop: +stop.toFixed(2), status: 'closed', why, exitDate: b[k].d, exit: +px.toFixed(2),
      r: +((px - fill) / risk - 0.0025 * fill / risk).toFixed(3), ret: +((px / fill - 1) * 100 - 0.25).toFixed(2), days: k - f });
    if (b[k].l <= stop) return exitAt(Math.min(k === f ? fill : b[k].o, stop), armed && stop > fill - risk ? 'trailing stop' : 'stop');
    if (b[k].h >= fill + risk) armed = true;
    if (k - f >= 60) return exitAt(b[k].c, '60 days');
  }
  const last = b[b.length - 1];
  return { ...t, entryDate: b[f].d, entry: +fill.toFixed(2), stop: +Math.max(stop, armed ? Math.min(...b.slice(-10).map(x => x.l)) : stop).toFixed(2), status: 'open', armed,
    last: +last.c.toFixed(2), r: +((last.c - fill) / risk).toFixed(3), ret: +((last.c / fill - 1) * 100).toFixed(2), days: b.length - 1 - f };
}

const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { start: null, trades: [] };
const nifty = await chart('^NSEI');
const ni = nifty.length - 1, nc = nifty.map(x => x.c), n200 = sma(nc, 200, ni), today = nifty[ni].d;
const marketUp = nifty[ni].c > n200;
const bars = {}, syms = Object.keys(U), queue = [...syms];
await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) { const s = queue.shift(); bars[s] = await chart(s + '.NS'); } }));
const fetched = Object.values(bars).filter(Boolean).length;

// 0) first run: backfill this financial year's signals (marked backfill) so the record starts with real out-of-sample trades
if (!state.start) {
  const from = '2026-04-01', nUp = new Map(nifty.map((x, i) => [x.d, i >= 199 && x.c > sma(nc, 200, i)]));
  for (const s of syms) {
    const b = bars[s]; if (!b || b.length < 260) continue;
    let freeFrom = 0;
    for (let i = 252; i < b.length; i++) {
      if (b[i].d < from || i < freeFrom || !nUp.get(b[i].d)) continue;
      const st = setup(b, i); if (!st || !st.trend || !st.breakout) continue;
      const t = replay({ sym: s, ind: U[s].ind, signalDate: b[i].d, signalClose: +b[i].c.toFixed(2), atr: +atrAt(b, i).toFixed(2), backfill: true }, b);
      state.trades.push(t);
      if (t.status !== 'closed') break; // still open: no new trade on this stock
      freeFrom = b.findIndex(x => x.d === t.exitDate) + 1;
    }
  }
  state.start = from;
}
// 1) update every paper trade that is not closed
state.trades = state.trades.map(t => (t.status === 'closed' || !bars[t.sym] ? t : replay(t, bars[t.sym])));
// 2) today's signals (only when today's bar exists for the stock)
const signals = [], near = [];
const busy = new Set(state.trades.filter(t => t.status !== 'closed').map(t => t.sym));
for (const s of syms) {
  const b = bars[s]; if (!b || b.length < 260 || b[b.length - 1].d !== today) continue;
  const i = b.length - 1, st = setup(b, i); if (!st || !st.trend) continue;
  const atr = atrAt(b, i), close = b[i].c;
  const row = { sym: s, g: U[s].g, ind: U[s].ind, close: +close.toFixed(2), atr: +atr.toFixed(2), stop: +(close - 2 * atr).toFixed(2), riskPct: +(2 * atr / close * 100).toFixed(1), qty: Math.max(0, Math.floor(500 / (2 * atr))) };
  if (st.breakout) signals.push(row); else if (st.gap <= 2) near.push({ ...row, trigger: +st.hi20.toFixed(2), gap: +st.gap.toFixed(1) });
}
if (marketUp && signals.length && !state.trades.some(t => t.signalDate === today)) {
  for (const x of signals) if (!busy.has(x.sym)) state.trades.push({ sym: x.sym, ind: x.ind, signalDate: today, signalClose: x.close, atr: x.atr, status: 'pending' });
}
state.start = state.start || today;
state.updated = today;
writeFileSync(statePath, JSON.stringify(state));

const closed = state.trades.filter(t => t.status === 'closed'), sum = closed.reduce((a, t) => a + t.r, 0);
const out = {
  date: today, at: Math.floor(Date.now() / 1000), fetched, universe: syms.length, start: state.start,
  market: { nifty: +nifty[ni].c.toFixed(2), ma200: +n200.toFixed(2), up: marketUp },
  signals: signals.sort((a, b) => a.riskPct - b.riskPct), near: near.sort((a, b) => a.gap - b.gap).slice(0, 20),
  open: state.trades.filter(t => t.status === 'open' || t.status === 'pending').sort((a, b) => (b.signalDate || '').localeCompare(a.signalDate || '')),
  closedStats: { n: closed.length, wins: closed.filter(t => t.r > 0).length, sumR: +sum.toFixed(2), avgR: closed.length ? +(sum / closed.length).toFixed(3) : null, avgRet: closed.length ? +(closed.reduce((a, t) => a + t.ret, 0) / closed.length).toFixed(2) : null },
  recentClosed: closed.sort((a, b) => b.exitDate.localeCompare(a.exitDate)).slice(0, 20),
  rules: 'NIFTY 500 stocks in a strong uptrend (price > 150-day > 200-day average, 200-day rising for a month, 50-day above 150-day, at least 30% above the 52-week low and within 25% of the high) closing above their 20-day high, while NIFTY is above its 200-day average. Paper trade: buy next open, stop 2×ATR, trail the 10-day low once up 1R, exit after 60 days, 0.25% costs. Quantity = ₹500 risk (0.5% of ₹1 lakh).',
};
writeFileSync(outPath, JSON.stringify(out));

// Today's figures for every stock (for "my rules" scans, peers and compare in the app)
const rsi14 = c => { if (c.length < 16) return null; let g = 0, l = 0; for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; d > 0 ? (g += d) : (l -= d); } g /= 14; l /= 14;
  for (let i = 15; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); };
const rows = {};
for (const s of syms) {
  const b = bars[s]; if (!b || b.length < 30) continue;
  const i = b.length - 1, c = b.map(x => x.c), v = b.map(x => x.v), p = c[i], st = b.length >= 260 ? setup(b, i) : null;
  const r1 = x => (x == null || !isFinite(x) ? null : +x.toFixed(2));
  const v20 = v.length > 21 ? v.slice(-21, -1).reduce((a, x) => a + x, 0) / 20 : null;
  rows[s] = [r1(p), r1(rsi14(c.slice(-120))), r1(sma(c, 50, i)), r1(sma(c, 150, i)), r1(sma(c, 200, i)), r1(i >= 21 ? (p / c[i - 21] - 1) * 100 : null), r1(i >= 63 ? (p / c[i - 63] - 1) * 100 : null),
    r1((p / Math.max(...c.slice(-252)) - 1) * 100), r1(v20 ? v[i] / v20 : null), st && st.trend ? 1 : 0, st && st.breakout ? 1 : 0, U[s].g, U[s].ind, b[i].d, r1(b.length > 20 ? atrAt(b, i) : null), r1(i >= 10 ? Math.min(...b.slice(i - 10, i).map(x => x.l)) : null)];
}
writeFileSync(outPath.replace(/swing\.json$/, 'metrics.json'), JSON.stringify({ date: today, cols: ['price', 'rsi', 'sma50', 'sma150', 'sma200', 'chg1m', 'chg3m', 'from52h', 'volRatio', 'trendTemplate', 'breakout20', 'g', 'ind', 'd', 'atr', 'lo10'], rows }));
console.log(`${today}: fetched ${fetched}/${syms.length}, market ${marketUp ? 'up' : 'down'}, ${signals.length} signals, ${near.length} near, ${out.open.length} open, ${closed.length} closed (${out.closedStats.avgR ?? '—'}R avg)`);

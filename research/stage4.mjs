// Stage 4: breadth filter, relative-strength ranking and a trend pullback, on top of entry C. Same mechanics as strategies.mjs.
// Usage: node research/stage4.mjs <data-dir>
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { SYMBOLS, INDICES } from './universe.mjs';

const dir = process.argv[2];
const IST = 5.5 * 3600e3, day = ms => new Date(ms + IST).toISOString().slice(0, 10);
const fyOf = d => { const y = +d.slice(0, 4), m = +d.slice(5, 7), s = m >= 4 ? y : y - 1; return `${s}-${String(s + 1).slice(2)}`; };
function load(y) {
  const j = JSON.parse(gunzipSync(readFileSync(join(dir, y.replace(/[^A-Za-z0-9&.-]/g, '_') + '.json.gz'))));
  const r = j.chart.result[0], q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((t, i) => { const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i]; if ([o, h, l, c].every(x => x != null && isFinite(x) && x > 0)) out.push({ d: day(t * 1000), o, h, l, c, v: v || 0 }); });
  return out;
}
// indicators per stock
function prep(b) {
  const n = b.length, c = b.map(x => x.c);
  const sma = (k, i) => { if (i + 1 < k) return null; let s = 0; for (let j = i - k + 1; j <= i; j++) s += c[j]; return s / k; };
  const atr = new Array(n).fill(null); let a = null;
  for (let i = 1; i < n; i++) { const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - c[i - 1]), Math.abs(b[i].l - c[i - 1])); a = a == null ? tr : (a * 13 + tr) / 14; if (i >= 14) atr[i] = a; }
  const rsi2 = new Array(n).fill(null); let g = 0, l = 0;
  for (let i = 1; i < n; i++) { const d = c[i] - c[i - 1]; g = (g * 1 + Math.max(d, 0)) / 2; l = (l * 1 + Math.max(-d, 0)) / 2; if (i > 3) rsi2[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return b.map((x, i) => ({ ...x, s20: sma(20, i), s50: sma(50, i), s150: sma(150, i), s200: sma(200, i), s200ago: i >= 20 ? sma(200, i - 20) : null, atr: atr[i], rsi2: rsi2[i],
    hi252: i >= 252 ? Math.max(...c.slice(i - 252, i)) : null, lo252: i >= 252 ? Math.min(...c.slice(i - 252, i)) : null,
    hi20: i >= 20 ? Math.max(...b.slice(i - 20, i).map(y => y.h)) : null, lo20: i >= 20 ? Math.min(...b.slice(i - 20, i).map(y => y.l)) : null, lo10: i >= 10 ? Math.min(...b.slice(i - 10, i).map(y => y.l)) : null,
    v50: i >= 50 ? b.slice(i - 50, i).reduce((s, y) => s + y.v, 0) / 50 : null, r126: i >= 147 ? c[i - 21] / c[i - 147] - 1 : null,
    atr10: null }));
}
const nb = load(INDICES.NIFTY), nmap = new Map(); { const p = prep(nb); p.forEach(x => nmap.set(x.d, x)); }
const niftyAt = d => nmap.get(d);
const STOCKS = {}; for (const s of SYMBOLS) { try { STOCKS[s] = prep(load(s + '.NS')); } catch { /* missing */ } }

// ---------- exits ----------
// stop = fixed initial stop; trailing: chandelier k×ATR after +1R (or 'lo10' = lowest low of 10 days), max hold days
function trade(b, i, stop0, ex) {
  const f = i + 1; if (f >= b.length) return null;
  const fill = b[f].o, risk = fill - stop0; if (!(risk > 0) || risk / fill > 0.15) return null;
  let stop = stop0, hh = fill, armed = false, exitP = null, ei = Math.min(b.length - 1, f + ex.hold);
  for (let j = f; j <= Math.min(b.length - 1, f + ex.hold); j++) {
    const x = b[j], open = j === f ? fill : x.o;
    if (j > f) {
      if (ex.trail === 'lo10' && b[j].lo10 != null) stop = Math.max(stop, armed ? b[j].lo10 : stop);
      else if (armed && ex.k) stop = Math.max(stop, hh - ex.k * b[f].atr);
    }
    if (x.l <= stop) { exitP = Math.min(open, stop); ei = j; break; }
    if (ex.target && x.h >= fill + ex.target * risk) { exitP = Math.max(open, fill + ex.target * risk); ei = j; break; }
    if (ex.exitAbove5 && j > f && x.c > (b[j].s5 ?? Infinity)) { exitP = x.c; ei = j; break; }
    hh = Math.max(hh, x.h);
    if (!armed && x.h >= fill + risk * (ex.armAt ?? 1)) armed = true;
  }
  if (exitP == null) exitP = b[ei].c;
  for (let j = Math.max(1, f - 1); j <= ei; j++) if (Math.abs(b[j].o / b[j - 1].c - 1) > 0.25) return null;
  return { r: (exitP - fill) / risk - 0.0025 * fill / risk, ret: exitP / fill - 1 - 0.0025, ei, days: ei - f, d: b[i].d, exitD: b[ei].d };
}

// ---------- entry ideas (all long; market filter: NIFTY above its 200-day) ----------
const mktUp = x => { const n = niftyAt(x.d); return n && n.s200 && n.c > n.s200; };
const IDEAS = {
  'A 52-week-high breakout on volume': (b, i) => { const x = b[i]; return x.hi252 && x.c > x.hi252 && x.v50 && x.v > 1.5 * x.v50 && x.s50 > x.s200 ? x.c - 2 * x.atr : null; },
  'B Tight range breakout (VCP-like)': (b, i) => { const x = b[i]; if (!x.hi20 || !x.s200) return null; const range = (x.hi20 - x.lo20) / x.c; return range < 0.08 && x.c > x.hi20 && x.c > x.s50 && x.s50 > x.s200 && x.v > 1.3 * (x.v50 || Infinity) ? Math.max(x.lo20, x.c - 2.5 * x.atr) : null; },
  'C Trend template + 20-day high': (b, i) => { const x = b[i]; return x.s200 && x.s150 && x.c > x.s150 && x.s150 > x.s200 && x.s200 > x.s200ago && x.s50 > x.s150 && x.lo252 && x.c > 1.3 * x.lo252 && x.c > 0.75 * x.hi252 && x.hi20 && x.c > x.hi20 ? x.c - 2 * x.atr : null; },
  'D Pullback in uptrend (RSI-2 < 10)': (b, i) => { const x = b[i]; return x.s200 && x.c > x.s200 && x.s50 > x.s200 && x.rsi2 != null && x.rsi2 < 10 ? x.c - 2.5 * x.atr : null; },
};
const EXITS = {
  'trail 3×ATR after +1R, 60d': { k: 3, hold: 60 },
  'trail 10-day low after +1R, 60d': { trail: 'lo10', hold: 60 },
  'target 2R, 30d': { target: 2, hold: 30 },
  'exit on close > 5-day avg, 10d (for D)': { exitAbove5: true, hold: 10 },
};
// 5-day average for exit D
for (const b of Object.values(STOCKS)) b.forEach((x, i) => { x.s5 = i >= 4 ? (b[i].c + b[i - 1].c + b[i - 2].c + b[i - 3].c + b[i - 4].c) / 5 : null; });

function run(entry, ex, filt = mktUp) {
  const out = [];
  for (const [s, b] of Object.entries(STOCKS)) {
    let busy = -1;
    for (let i = 260; i < b.length - 1; i++) {
      if (i <= busy || !filt(b[i])) continue;
      const stop = entry(b, i); if (stop == null) continue;
      const t = trade(b, i, stop, ex); if (!t) continue;
      busy = t.ei; out.push({ s, ...t, fy: fyOf(b[i].d) });
    }
  }
  return out;
}
function stats(t) {
  if (!t.length) return { n: 0 };
  const s = t.reduce((a, x) => a + x.r, 0); return { n: t.length, avg: s / t.length, win: t.filter(x => x.r > 0).length / t.length, ret: t.reduce((a, x) => a + x.ret, 0) / t.length * 100 };
}
function portfolio(t, max) {
  const all = [...t].sort((a, b) => a.d.localeCompare(b.d)), open = [], took = [];
  for (const x of all) { for (let k = open.length - 1; k >= 0; k--) if (open[k] < x.d) open.splice(k, 1); if (open.length >= max) continue; open.push(x.exitD); took.push(x); }
  let eq = 0, pk = 0, dd = 0; for (const x of [...took].sort((a, b) => a.exitD.localeCompare(b.exitD))) { eq += x.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const fys = {}; took.forEach(x => (fys[x.fy] = (fys[x.fy] || 0) + x.r));
  return { n: took.length, total: eq, dd, avg: took.length ? eq / took.length : 0, fys, posYears: Object.values(fys).filter(v => v > 0).length, years: Object.keys(fys).length };
}
const f2 = v => (v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(2));
const TRAIN = x => x.d < '2025-04-01';

// ---------- breadth: share of the 99 stocks above their own 200-day, per date ----------
const BR = new Map(); { const cnt = new Map();
  for (const b of Object.values(STOCKS)) for (const x of b) if (x.s200) { const c = cnt.get(x.d) || [0, 0, 0]; c[0]++; if (x.c > x.s200) c[1]++; if (x.s50 && x.c > x.s50) c[2]++; cnt.set(x.d, c); }
  for (const [d, c] of cnt) BR.set(d, { b200: c[1] / c[0], b50: c[2] / c[0] }); }
// relative-strength percentile (6-month return, skip last month) per date
const RS = new Map(); { const by = new Map();
  for (const [s, b] of Object.entries(STOCKS)) for (const x of b) if (x.r126 != null) { (by.get(x.d) || by.set(x.d, []).get(x.d)).push([s, x.r126]); }
  for (const [d, a] of by) { a.sort((p, q) => p[1] - q[1]); const m = new Map(); a.forEach(([s], k) => m.set(s, k / Math.max(1, a.length - 1))); RS.set(d, m); } }
const trend = x => x.s200 && x.s150 && x.c > x.s150 && x.s150 > x.s200 && x.s200 > x.s200ago && x.s50 > x.s150 && x.lo252 && x.c > 1.3 * x.lo252 && x.c > 0.75 * x.hi252;
const C = (b, i) => (trend(b[i]) && b[i].hi20 && b[i].c > b[i].hi20 ? b[i].c - 2 * b[i].atr : null);
// pullback inside a trend-template stock: low touched the 20-day average in the last 3 days, today closes above yesterday's high
const P = (b, i) => { const x = b[i]; if (!trend(x) || !x.s20 || i < 3) return null; const touched = [0, 1, 2].some(k => b[i - k].l <= b[i - k].s20 * 1.005); return touched && x.c > b[i - 1].h && x.c > x.s20 ? Math.min(x.l, b[i - 1].l, b[i - 2].l) - 0.2 * x.atr : null; };
const EX = { trail: 'lo10', hold: 60 };
function runS(entry, filt, rsMin = 0) {
  const out = [];
  for (const [s, b] of Object.entries(STOCKS)) { let busy = -1;
    for (let i = 260; i < b.length - 1; i++) { if (i <= busy || !filt(b[i])) continue; const rs = RS.get(b[i].d)?.get(s) ?? 0; if (rs < rsMin) continue;
      const stop = entry(b, i); if (stop == null) continue; const t = trade(b, i, stop, EX); if (!t) continue; busy = t.ei; out.push({ s, rs, ...t, fy: fyOf(b[i].d) }); } }
  return out;
}
function portR(t, max, ranked) { // same as portfolio(), but same-day signals taken strongest first when ranked
  const all = [...t].sort((a, b) => a.d.localeCompare(b.d) || (ranked ? b.rs - a.rs : 0)), open = [], took = [];
  for (const x of all) { for (let k = open.length - 1; k >= 0; k--) if (open[k] < x.d) open.splice(k, 1); if (open.length >= max) continue; open.push(x.exitD); took.push(x); }
  let eq = 0, pk = 0, dd = 0; for (const x of [...took].sort((a, b) => a.exitD.localeCompare(b.exitD))) { eq += x.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const fys = {}; took.forEach(x => (fys[x.fy] = (fys[x.fy] || 0) + x.r));
  return { total: eq, dd, fys, pos: Object.values(fys).filter(v => v > 0).length, years: Object.keys(fys).length, n: took.length };
}
const br = (k, v) => x => mktUp(x) && (BR.get(x.d)?.[k] ?? 0) >= v;
const V = {
  'C baseline (NIFTY > 200-day)': [C, mktUp, 0],
  'C + breadth200 >= 50%': [C, br('b200', .5), 0], 'C + breadth200 >= 60%': [C, br('b200', .6), 0], 'C + breadth200 >= 70%': [C, br('b200', .7), 0],
  'C + breadth50 >= 50%': [C, br('b50', .5), 0], 'C + breadth50 >= 60%': [C, br('b50', .6), 0],
  'C + RS top 50%': [C, mktUp, .5], 'C + RS top 30%': [C, mktUp, .7], 'C + RS top 20%': [C, mktUp, .8],
  'C + breadth200 >= 60% + RS top 50%': [C, br('b200', .6), .5], 'C + breadth200 >= 60% + RS top 30%': [C, br('b200', .6), .7],
  'C + breadth50 >= 50% + RS top 30%': [C, br('b50', .5), .7],
  'P pullback to 20-day in trend': [P, mktUp, 0], 'P + breadth200 >= 60%': [P, br('b200', .6), 0], 'P + RS top 30%': [P, mktUp, .7], 'P + breadth200 >= 60% + RS top 30%': [P, br('b200', .6), .7],
};
console.log('variant'.padEnd(40) + 'train | 25-26 | 26-27 |  n tr/te | win | port 5 open ranked: total, dd, +yrs | by FY');
for (const [n, [e, f, r]] of Object.entries(V)) {
  const t = runS(e, f, r), a = stats(t.filter(TRAIN)), b = stats(t.filter(z => z.fy === '2025-26')), c = stats(t.filter(z => z.fy === '2026-27')), p = portR(t, 5, true);
  console.log(`${n.padEnd(40)}${f2(a.avg)} | ${f2(b.avg)} | ${f2(c.avg)} | ${String(a.n).padStart(4)}/${String((b.n || 0) + (c.n || 0)).padStart(3)} | ${a.n ? (a.win * 100).toFixed(0) : '-'}% | ${p.total.toFixed(0)}R, dd ${p.dd.toFixed(0)}R, ${p.pos}/${p.years} | ${Object.entries(p.fys).sort().map(([k, v]) => k.slice(2, 4) + ':' + v.toFixed(0)).join(' ')}`);
}

// ---------- strategy health: take new trades only while the last N closed signals (all stocks) average above a floor ----------
{ const all = runS(C, mktUp, 0), byExit = [...all].sort((a, b) => a.exitD.localeCompare(b.exitD));
  console.log('\nHealth switch on C (skip new trades while the last N closed signals average below the floor)');
  for (const [N, floor] of [[20, 0], [30, 0], [40, 0], [30, -0.1], [50, 0], [30, -0.2]]) {
    const t = all.filter(x => { const past = byExit.filter(y => y.exitD < x.d).slice(-N); return past.length < N || past.reduce((s, y) => s + y.r, 0) / N >= floor; });
    const a = stats(t.filter(TRAIN)), b = stats(t.filter(z => z.fy === '2025-26')), c = stats(t.filter(z => z.fy === '2026-27')), p = portR(t, 5, false);
    console.log(`last ${N}, floor ${floor}`.padEnd(40) + `${f2(a.avg)} | ${f2(b.avg)} | ${f2(c.avg)} | ${String(a.n).padStart(4)}/${String((b.n || 0) + (c.n || 0)).padStart(3)} | ${p.total.toFixed(0)}R, dd ${p.dd.toFixed(0)}R, ${p.pos}/${p.years} | ${Object.entries(p.fys).sort().map(([k, v]) => k.slice(2, 4) + ':' + v.toFixed(0)).join(' ')}`);
  } }

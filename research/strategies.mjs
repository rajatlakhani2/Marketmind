// Stage 3: new swing-entry ideas tested on raw daily bars (not the app's existing signals).
// Same mechanics as backtest.mjs: next-day open fill, stop checked first, 0.25% round-trip cost, one trade per stock,
// split/bonus jumps dropped. Train = signals before 1 Apr 2025, test = FY 2025-26 and 2026-27 (never used to choose).
// Also a portfolio view (max N open, first come first served) and a monthly momentum rotation vs NIFTY.
// Usage: node research/strategies.mjs <data-dir>
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

console.log('avg R per trade · train FY17-25 | FY25-26 | FY26-27 | n train/test | win% train | portfolio (max 5 open, whole period): total R, deepest drop, positive years\n');
const best = [];
for (const [en, e] of Object.entries(IDEAS)) {
  console.log(en);
  for (const [xn, x] of Object.entries(EXITS)) {
    if (!!x.exitAbove5 !== en.startsWith('D')) continue;
    const t = run(e, x), a = stats(t.filter(TRAIN)), b = stats(t.filter(z => z.fy === '2025-26')), c = stats(t.filter(z => z.fy === '2026-27')), p = portfolio(t, 5);
    console.log(`   ${xn.padEnd(36)} ${f2(a.avg)} | ${f2(b.avg)} | ${f2(c.avg)} | ${String(a.n).padStart(4)}/${String(b.n + c.n).padStart(3)} | ${a.n ? (a.win * 100).toFixed(0) : '-'}% | port ${p.total.toFixed(0)}R, dd ${p.dd.toFixed(0)}R, ${p.posYears}/${p.years} yrs`);
    best.push({ en, xn, a, b, c, p });
  }
}

// ---------- monthly momentum rotation: top 5 by 6-month return (skip last month), above 200-day, NIFTY above 200-day ----------
{
  const months = [...new Set(nb.map(x => x.d.slice(0, 7)))].filter(m => m >= '2017-04');
  let eq = 1, peq = 1, peak = 1, dd = 0, nEq = 1; const fy = {}, nfy = {};
  for (let k = 0; k < months.length - 1; k++) {
    const m = months[k], next = months[k + 1];
    const d0 = nb.find(x => x.d.slice(0, 7) === m)?.d, d1 = nb.find(x => x.d.slice(0, 7) === next)?.d;
    const n0 = niftyAt(d0), n1 = niftyAt(d1); if (!n0 || !n1) continue;
    const niftyR = n1.c / n0.c - 1; nEq *= 1 + niftyR;
    let r = 0;
    if (n0.s200 && n0.c > n0.s200) {
      const cands = [];
      for (const [s, b] of Object.entries(STOCKS)) { const i = b.findIndex(x => x.d >= d0), j = b.findIndex(x => x.d >= d1); if (i < 1 || j < 0) continue; const x = b[i - 1]; if (x.r126 != null && x.s200 && x.c > x.s200) cands.push([s, x.r126, b[i].o, b[j].o]); }
      const top = cands.sort((a, b) => b[1] - a[1]).slice(0, 5);
      r = top.length ? top.reduce((a, t) => a + (t[3] / t[2] - 1), 0) / top.length - 0.005 : 0;
    }
    eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
    const f = fyOf(d0); fy[f] = (fy[f] || 1) * (1 + r); nfy[f] = (nfy[f] || 1) * (1 + niftyR);
  }
  console.log('\nE Monthly momentum rotation (top 5 of 99 by 6-month return, cash when NIFTY < 200-DMA, 0.5% cost a month)');
  console.log('   FY: ' + Object.keys(fy).map(f => `${f.slice(2)} ${((fy[f] - 1) * 100).toFixed(0)}% vs NIFTY ${((nfy[f] - 1) * 100).toFixed(0)}%`).join(' · '));
  const yrs = months.length / 12; console.log(`   whole period: ${((Math.pow(eq, 1 / yrs) - 1) * 100).toFixed(1)}% a year vs NIFTY ${((Math.pow(nEq, 1 / yrs) - 1) * 100).toFixed(1)}%, deepest fall ${(dd * 100).toFixed(0)}%`);
}

// ---------- robustness of C: small changes to its settings should not change the answer much ----------
if (process.argv[3] === 'c') {
  const trend = x => x.s200 && x.s150 && x.c > x.s150 && x.s150 > x.s200 && x.s200 > x.s200ago && x.s50 > x.s150 && x.lo252 && x.c > 1.3 * x.lo252 && x.c > 0.75 * x.hi252;
  const hiN = (b, i, n) => (i >= n ? Math.max(...b.slice(i - n, i).map(y => y.h)) : null);
  const strongMkt = x => { const n = niftyAt(x.d); return n && n.s200 && n.c > n.s200 && n.s50 > n.s200; };
  const V = {
    'C as tested (20-day high, stop 2 ATR)': [(b, i) => (trend(b[i]) && b[i].c > b[i].hi20 ? b[i].c - 2 * b[i].atr : null), mktUp],
    'C with 10-day high': [(b, i) => { const h = hiN(b, i, 10); return trend(b[i]) && h && b[i].c > h ? b[i].c - 2 * b[i].atr : null; }, mktUp],
    'C with 50-day high': [(b, i) => { const h = hiN(b, i, 50); return trend(b[i]) && h && b[i].c > h ? b[i].c - 2 * b[i].atr : null; }, mktUp],
    'C with stop 1.5 ATR': [(b, i) => (trend(b[i]) && b[i].c > b[i].hi20 ? b[i].c - 1.5 * b[i].atr : null), mktUp],
    'C with stop 3 ATR': [(b, i) => (trend(b[i]) && b[i].c > b[i].hi20 ? b[i].c - 3 * b[i].atr : null), mktUp],
    'C + volume 1.3x': [(b, i) => (trend(b[i]) && b[i].c > b[i].hi20 && b[i].v > 1.3 * (b[i].v50 || Infinity) ? b[i].c - 2 * b[i].atr : null), mktUp],
    'C + NIFTY 50-DMA above 200-DMA': [(b, i) => (trend(b[i]) && b[i].c > b[i].hi20 ? b[i].c - 2 * b[i].atr : null), strongMkt],
    'C, no market filter': [(b, i) => (trend(b[i]) && b[i].c > b[i].hi20 ? b[i].c - 2 * b[i].atr : null), () => true],
  };
  console.log('\nRobustness of C (exit: trail 10-day low after +1R, 60d)  train | 25-26 | 26-27 | n | port 5 open: total, dd, +years');
  for (const [n, [e, f]] of Object.entries(V)) {
    const t = run(e, { trail: 'lo10', hold: 60 }, f), a = stats(t.filter(TRAIN)), b = stats(t.filter(z => z.fy === '2025-26')), c = stats(t.filter(z => z.fy === '2026-27')), p = portfolio(t, 5);
    console.log(`   ${n.padEnd(38)} ${f2(a.avg)} | ${f2(b.avg)} | ${f2(c.avg)} | ${a.n}/${b.n + c.n} | ${p.total.toFixed(0)}R, dd ${p.dd.toFixed(0)}R, ${p.posYears}/${p.years}`);
  }
  const t = run(V['C as tested (20-day high, stop 2 ATR)'][0], { trail: 'lo10', hold: 60 }), p = portfolio(t, 5);
  console.log('\nC portfolio by FY (R, max 5 open): ' + Object.entries(p.fys).sort().map(([k, v]) => `${k.slice(2)} ${v >= 0 ? '+' : ''}${v.toFixed(0)}`).join(' · '));
  const all = stats(t); console.log(`C all trades: ${all.n}, win ${(all.win * 100).toFixed(0)}%, avg ${f2(all.avg)}R, avg return a trade ${all.ret.toFixed(2)}%`);
}

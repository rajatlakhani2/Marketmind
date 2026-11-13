// Stage 2: simulate the Combined Proven system (Golden Cross / Supertrend buy) with different market, stock and
// sector filters and exit rules. Same trade mechanics as assets/js/backtest.js: next-bar open fill, stop checked
// before target, 0.25% round-trip cost, one open trade per stock, split/bonus jumps dropped.
// Train = signals before 1 Apr 2025, Test = FY 2025-26 and FY 2026-27 to date (untouched while choosing rules).
// Usage: node research/backtest.mjs <data-dir> <signals.json>
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { SYMBOLS, SECTOR, INDICES } from './universe.mjs';

const [dataDir, sigFile] = process.argv.slice(2);
const SIG = JSON.parse(readFileSync(sigFile, 'utf8'));
const IST = 5.5 * 3600e3;
const day = ms => new Date(ms + IST).toISOString().slice(0, 10);
const fyOf = d => { const y = +d.slice(0, 4), m = +d.slice(5, 7); const s = m >= 4 ? y : y - 1; return `${s}-${String(s + 1).slice(2)}`; };
function load(y) {
  const j = JSON.parse(gunzipSync(readFileSync(join(dataDir, y.replace(/[^A-Za-z0-9&.-]/g, '_') + '.json.gz'))));
  const r = j.chart.result[0], q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((t, i) => { const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i]; if ([o, h, l, c].every(v => v != null && isFinite(v))) out.push({ time: t * 1000, d: day(t * 1000), open: o, high: h, low: l, close: c }); });
  return out;
}
const smaAt = (bars, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += bars[k].close; return s / n; };

// Daily index state by date: close, 50/200 DMA, 200 DMA 20 days ago, 63/126-day returns
function indexState(bars) {
  const m = new Map();
  bars.forEach((b, i) => m.set(b.d, {
    c: b.close, s50: smaAt(bars, i, 50), s200: smaAt(bars, i, 200), s200ago: i >= 20 ? smaAt(bars, i - 20, 200) : null,
    r63: i >= 63 ? b.close / bars[i - 63].close - 1 : null, r126: i >= 126 ? b.close / bars[i - 126].close - 1 : null,
  }));
  const dates = [...m.keys()].sort();
  return d => { if (m.has(d)) return m.get(d); let lo = 0, hi = dates.length - 1, k = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid] <= d) { k = mid; lo = mid + 1; } else hi = mid - 1; } return k >= 0 ? m.get(dates[k]) : null; };
}
const nifty = indexState(load(INDICES.NIFTY));
const sectors = {};
for (const [k, y] of Object.entries(INDICES)) if (k !== 'NIFTY') { try { sectors[k] = indexState(load(y)); } catch { /* missing */ } }

const STOCKS = {};
for (const s of SYMBOLS) { try { STOCKS[s] = load(s + '.NS'); } catch { /* missing */ } }
// Cross-sectional 6-month return rank by date (0 = weakest, 1 = strongest)
const rankByDate = new Map();
{
  const by = new Map();
  for (const [s, bars] of Object.entries(STOCKS)) bars.forEach((b, i) => { if (i >= 126) { const r = b.close / bars[i - 126].close - 1; (by.get(b.d) || by.set(b.d, []).get(b.d)).push([s, r]); } });
  for (const [d, arr] of by) { arr.sort((a, b) => a[1] - b[1]); const m = new Map(); arr.forEach(([s], i) => m.set(s, arr.length > 1 ? i / (arr.length - 1) : 0.5)); rankByDate.set(d, m); }
}

// ---------- filters ----------
const F = {
  base: () => true,
  regime: ({ n }) => n.s50 != null && n.s50 > n.s200 && n.s200ago != null && n.s200 > n.s200ago,
  rs: ({ bars, t, n }) => t >= 126 && n.r126 != null && bars[t].close / bars[t - 126].close - 1 > n.r126,
  rank30: ({ sym, d }) => (rankByDate.get(d)?.get(sym) ?? 0) >= 0.7,
  sector: ({ sym, d, n }) => { const f = sectors[SECTOR[sym]]; const s = f && f(d); return !s || (s.s50 != null && s.c > s.s50 && s.r63 != null && n.r63 != null && s.r63 > n.r63); },
};
const and = (...ks) => x => ks.every(k => F[k](x));

// ---------- exits ----------
// kind: 'partial' (half at +1R, rest to breakeven, target 3R, 30 bars), 'fixed2' (all at 2R, 30 bars),
// 'trail' (chandelier: highest high since entry − k×ATR, no target), 'partialTrail' (half at +1R, rest trailed),
// 'trailAfter1R' (initial stop until +1R, then chandelier)
function simulate(bars, from, entryAtr, ex) {
  const fill = bars[from].open, atr = entryAtr;
  let stop = fill - 2 * atr; const risk = fill - stop;
  if (!(risk > 0)) return null;
  const hold = ex.hold || 30, end = Math.min(bars.length - 1, from + hold);
  let half = null, hh = fill, armed = ex.kind === 'trail', exit = null, ei = end, why = 'time';
  const target = ex.kind === 'partial' ? fill + 3 * risk : ex.kind === 'fixed2' ? fill + 2 * risk : Infinity;
  const halfAt = ex.kind === 'partial' || ex.kind === 'partialTrail' ? fill + risk : null;
  for (let j = from; j <= end; j++) {
    const b = bars[j], open = j === from ? fill : b.open;
    if (j > from && armed) stop = Math.max(stop, hh - ex.k * atr);           // trail from highs up to the previous bar
    if (b.low <= stop) { exit = Math.min(open, stop); ei = j; why = half != null || stop >= fill ? 'trail/be' : 'stop'; break; }
    if (halfAt != null && half == null && b.high >= halfAt) { half = Math.max(open, halfAt); stop = Math.max(stop, fill); if (ex.kind === 'partialTrail') armed = true; }
    if (ex.kind === 'trailAfter1R' && !armed && b.high >= fill + risk) armed = true;
    if (b.high >= target) { exit = Math.max(open, target); ei = j; why = 'target'; break; }
    hh = Math.max(hh, b.high);
  }
  if (exit == null) exit = bars[ei].close;
  for (let j = Math.max(1, from - 1); j <= ei; j++) if (Math.abs(bars[j].open / bars[j - 1].close - 1) > 0.25) return null;
  const full = (exit - fill) / risk;
  const gross = half != null ? 0.5 * (half - fill) / risk + 0.5 * full : full;
  return { r: gross - (0.25 / 100) * fill / risk, ei, why, bars: ei - from };
}

function runVariant(filter, ex) {
  const trades = [];
  for (const [sym, sigs] of Object.entries(SIG)) {
    const bars = STOCKS[sym]; if (!bars) continue;
    let busyTill = -1;
    for (const s of sigs) {
      const t = s.t; if (t <= busyTill || t + 1 >= bars.length) continue;
      const d = bars[t].d, n = nifty(d);
      if (!n || n.s200 == null || !(n.c > n.s200)) continue;                   // baseline market filter
      if (s.ma200 == null || !(s.price > s.ma200)) continue;                    // stock above its 200-day
      if (!filter({ sym, bars, t, d, n })) continue;
      const tr = simulate(bars, t + 1, s.atr, ex); if (!tr) continue;
      busyTill = tr.ei;
      trades.push({ sym, d, fy: fyOf(d), exitAt: bars[tr.ei].time, ...tr });
    }
  }
  return trades;
}

function stats(tr) {
  if (!tr.length) return { n: 0 };
  const s = tr.reduce((a, x) => a + x.r, 0);
  const sorted = [...tr].sort((a, b) => a.exitAt - b.exitAt);
  let eq = 0, pk = 0, dd = 0; for (const x of sorted) { eq += x.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  return { n: tr.length, avg: s / tr.length, win: tr.filter(x => x.r > 0).length / tr.length, total: s, dd, hold: tr.reduce((a, x) => a + x.bars, 0) / tr.length };
}
const f2 = v => (v == null ? '   —  ' : (v >= 0 ? '+' : '') + v.toFixed(2));
const TRAIN = x => x.d < '2025-04-01';
const FYS = ['2017-18', '2018-19', '2019-20', '2020-21', '2021-22', '2022-23', '2023-24', '2024-25', '2025-26', '2026-27'];

const FILTERS = {
  'Baseline (NIFTY & stock > 200-DMA)': F.base,
  '+ Market trend (NIFTY 50>200, 200 rising)': F.regime,
  '+ Strong stock (beats NIFTY over 6m)': F.rs,
  '+ Strong stock (top 30% of 6m return)': F.rank30,
  '+ Strong sector (above 50-DMA, beats NIFTY 3m)': F.sector,
  '+ Market trend + strong stock': and('regime', 'rs'),
  '+ Market trend + strong sector': and('regime', 'sector'),
  '+ Strong stock + strong sector': and('rs', 'sector'),
  '+ All three (trend, stock, sector)': and('regime', 'rs', 'sector'),
  '+ Trend + top-30% stock + sector': and('regime', 'rank30', 'sector'),
};
const EXITS = {
  'Half at 1R, rest 3R / 30d (current)': { kind: 'partial' },
  'All at 2R / 30d': { kind: 'fixed2' },
  'Trailing 3×ATR, max 60d': { kind: 'trail', k: 3, hold: 60 },
  'Trailing 3×ATR after +1R, max 60d': { kind: 'trailAfter1R', k: 3, hold: 60 },
  'Half at 1R, rest trailed 3×ATR, 60d': { kind: 'partialTrail', k: 3, hold: 60 },
  'Trailing 4×ATR after +1R, max 90d': { kind: 'trailAfter1R', k: 4, hold: 90 },
};

const mode = process.argv[4] || 'grid';
if (mode === 'grid') {
  console.log('avg R per trade — Train (FY17-18..24-25) | Test FY25-26 | FY26-27 to date | trades train/test | max drawdown (R, whole period)\n');
  for (const [fn, f] of Object.entries(FILTERS)) {
    console.log(fn);
    for (const [en, e] of Object.entries(EXITS)) {
      const tr = runVariant(f, e);
      const a = stats(tr.filter(TRAIN)), b = stats(tr.filter(x => x.fy === '2025-26')), c = stats(tr.filter(x => x.fy === '2026-27')), all = stats(tr);
      console.log(`   ${en.padEnd(38)} train ${f2(a.avg)} | 25-26 ${f2(b.avg)} | 26-27 ${f2(c.avg)} | n ${String(a.n).padStart(4)}/${String(b.n + c.n).padStart(3)} | dd ${all.dd?.toFixed(1)} | hold ${all.hold?.toFixed(0)}d`);
    }
  }
} else if (!mode.startsWith('port:')) {
  const [fk, ek] = mode.split('|');
  const tr = runVariant(FILTERS[fk], EXITS[ek]);
  for (const fy of FYS) { const s = stats(tr.filter(x => x.fy === fy)); console.log(fy, s.n, f2(s.avg), s.n ? (s.win * 100).toFixed(0) + '%' : '', s.total?.toFixed(1)); }
  console.log('all', JSON.stringify(stats(tr)));
}

// Portfolio view: at most `maxOpen` trades open at once, signals taken in date order (first come, first served).
export function portfolio(tr, maxOpen) {
  const all = [...tr].sort((a, b) => a.d.localeCompare(b.d));
  const open = []; const taken = [];
  for (const x of all) {
    const t0 = Date.parse(x.d);
    for (let i = open.length - 1; i >= 0; i--) if (open[i] <= t0) open.splice(i, 1);
    if (open.length >= maxOpen) continue;
    open.push(x.exitAt); taken.push(x);
  }
  return taken;
}
if (mode.startsWith('port:')) {
  const [, max, fk, ek] = mode.split(/[:|]/);
  const tr = portfolio(runVariant(FILTERS[fk], EXITS[ek]), +max);
  const parts = FYS.map(fy => { const s = stats(tr.filter(x => x.fy === fy)); return `${fy.slice(2)} ${s.n ? f2(s.total) : '0'}R/${s.n || 0}`; });
  const s = stats(tr);
  console.log(`max ${max} open: avg ${f2(s.avg)}R, ${s.n} trades, total ${s.total.toFixed(1)}R, deepest drop ${s.dd.toFixed(1)}R\n   ${parts.join(' · ')}`);
}

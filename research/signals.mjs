// Stage 1: replay the app's own Golden Cross and Supertrend Flip checks (Conditions.check + library conditions)
// on every 2nd daily bar, exactly as assets/js/backtest.js does, and save the signals.
// Usage: node research/signals.mjs <data-dir> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SYMBOLS } from './universe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [dataDir, outFile] = process.argv.slice(2);
const ctx = { console, Math, Date, JSON, isFinite, Number, String, Array, Object, Map, Set };
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['marketdata.js', 'conditions.js', 'library.js', 'plain.js', 'consensus.js'])
  vm.runInContext(readFileSync(join(here, '../assets/js', f), 'utf8'), ctx, { filename: f });
const { MarketData, Conditions, MarketMindLibrary, Consensus } = ctx;

const IDS = ['lib_s_golden_cross', 'lib_s_supertrend_flip'];
const strategies = MarketMindLibrary.STRATEGIES.filter(s => IDS.includes(s.id));
if (strategies.length !== 2) throw new Error('strategies not found');
const load = y => MarketData.parseYahooChart(JSON.parse(gunzipSync(readFileSync(join(dataDir, y.replace(/[^A-Za-z0-9&.-]/g, '_') + '.json.gz')))));

const out = {};
for (const sym of SYMBOLS) {
  let daily;
  try { daily = load(sym + '.NS').candles; } catch (e) { console.log(sym, 'no data'); continue; }
  const sig = [];
  for (let t = 260; t <= daily.length - 2; t += 2) {
    const window = daily.slice(Math.max(0, t - 399), t + 1);
    const md = MarketData.buildMarketData({ symbol: sym, timeframe: '1d', candles: window, meta: null, source: 'History' });
    const a = Consensus.atr(window) || md.price * 0.02;
    const hits = [];
    for (const s of strategies) {
      const rs = s.conditions.map(c => Conditions.check(c, md));
      const checkable = rs.filter(Boolean);
      if (!checkable.length || !checkable.every(r => r.met)) continue;
      let plan = null; try { plan = Consensus.LEVELS[s.id]({ md, ks: null, c: window, a }); } catch { plan = null; }
      if (plan && plan.side === 'long') hits.push(s.id === IDS[0] ? 'GC' : 'ST');
    }
    if (hits.length) sig.push({ t, hits, price: md.price, ma200: md.ma200, atr: Consensus.atr(window) });
  }
  out[sym] = sig;
  console.log(sym, daily.length, 'bars', sig.length, 'signal days');
}
writeFileSync(outFile, JSON.stringify(out));

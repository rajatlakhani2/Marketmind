// Downloads ~10 years of daily Yahoo prices for the back-test universe, NIFTY and the NSE sector indices.
// Output: data/<symbol>.json.gz (Yahoo chart response). Used by research/backtest.mjs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { SYMBOLS, INDICES } from './universe.mjs';
mkdirSync('data', { recursive: true });
const all = [...SYMBOLS.map(s => s + '.NS'), ...Object.values(INDICES)];
let ok = 0;
for (const y of all) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=10y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      writeFileSync(`data/${y.replace(/[^A-Za-z0-9&.-]/g, '_')}.json.gz`, gzipSync(t));
      ok++; break;
    } catch (e) { console.log(y, e.message); await new Promise(r => setTimeout(r, 1500)); }
  }
}
console.log(`fetched ${ok} of ${all.length}`);

import { defineConfig } from 'vite';

// During `npm run dev`, answer api/chart.php in Node so live market data
// works without PHP. In production the real assets/api/chart.php is used.
const INTERVALS = new Set(['5m', '15m', '30m', '60m', '1d', '1wk', '1mo']);
const RANGES = new Set(['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']);

function marketDataDevProxy() {
  return {
    name: 'marketmind-data-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.endsWith('/api/chart.php')) return next();
        const send = (code, body) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
        const interval = url.searchParams.get('interval') || '1d';
        const range = url.searchParams.get('range') || '1y';
        if (!/^\^?[A-Z0-9&-]{1,20}(\.(NS|BO))?$/.test(symbol)) return send(400, { error: 'Invalid symbol' });
        if (!INTERVALS.has(interval)) return send(400, { error: 'Invalid interval' });
        if (!RANGES.has(range)) return send(400, { error: 'Invalid range' });
        try {
          const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
          const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (MarketMind AI)', Accept: 'application/json' } });
          send(r.status, await r.text());
        } catch (err) {
          send(502, { error: 'Could not reach market data source: ' + err.message });
        }
      });
    },
  };
}

export default defineConfig({
  root: '.',
  base: './',
  publicDir: 'assets',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 3000,
    open: true,
  },
  plugins: [marketDataDevProxy()],
});

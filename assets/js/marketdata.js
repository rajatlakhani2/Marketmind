// ============================================================
// MarketMind AI — Market data layer
// Fetches real OHLC candles through the app's own proxy
// (api/chart.php: Vite middleware in dev, PHP on the host),
// computes indicators, and falls back to clearly-labelled
// simulated data only when live data can't be reached.
// ============================================================
(function (root) {
  'use strict';

  // Yahoo interval + range to request for each app timeframe.
  // 4h isn't offered by Yahoo, so it is built from 1h bars.
  const TF_REQUEST = {
    '5m':  { interval: '5m',  range: '1mo' },
    '15m': { interval: '15m', range: '1mo' },
    '30m': { interval: '30m', range: '1mo' },
    '1h':  { interval: '60m', range: '6mo' },
    '4h':  { interval: '60m', range: '1y', aggregate: 4 },
    '1d':  { interval: '1d',  range: '2y' },
    '1w':  { interval: '1wk', range: '10y' },
    '1mo': { interval: '1mo', range: 'max' },
  };

  const API_URL = 'api/chart.php';
  const CACHE_MS = 60 * 1000;
  const cache = new Map();

  function toYahooSymbol(symbol) {
    const s = String(symbol || '').trim().toUpperCase();
    if (!s) return s;
    if (s.startsWith('^') || s.includes('.')) return s; // index or already suffixed
    return s + '.NS';
  }

  // ---------- Parsing ----------
  function parseYahooChart(json) {
    const res = json && json.chart && json.chart.result && json.chart.result[0];
    if (!res) {
      const msg = json && json.chart && json.chart.error && json.chart.error.description;
      throw new Error(msg || 'No chart data returned');
    }
    const ts = res.timestamp || [];
    const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
      if ([o, h, l, c].some(v => v == null || !isFinite(v))) continue; // skip empty bars
      candles.push({ time: ts[i] * 1000, date: new Date(ts[i] * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: (q.volume && q.volume[i]) || 0 });
    }
    if (!candles.length) throw new Error('Chart data was empty');
    return { meta: res.meta || {}, candles };
  }

  // Group 1h bars into 4-bar blocks within each trading day (IST).
  function aggregateCandles(candles, size) {
    const out = [];
    let dayKey = null, bucket = [];
    const flush = () => {
      if (!bucket.length) return;
      out.push({
        time: bucket[0].time, date: bucket[0].date,
        open: bucket[0].open, close: bucket[bucket.length - 1].close,
        high: Math.max(...bucket.map(b => b.high)), low: Math.min(...bucket.map(b => b.low)),
        volume: bucket.reduce((s, b) => s + b.volume, 0),
      });
      bucket = [];
    };
    for (const c of candles) {
      const key = new Date(c.time + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      if (key !== dayKey) { flush(); dayKey = key; }
      bucket.push(c);
      if (bucket.length === size) flush();
    }
    flush();
    return out;
  }

  // ---------- Indicators ----------
  function emaSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period - 1] = ema;
    for (let i = period; i < values.length; i++) { ema = values[i] * k + ema * (1 - k); out[i] = ema; }
    return out;
  }

  function sma(values, period) {
    if (values.length < period) return null;
    return values.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  function rsi(values, period = 14) {
    if (values.length <= period) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d > 0) gain += d; else loss -= d; }
    gain /= period; loss /= period;
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  }

  function macd(values) {
    const e12 = emaSeries(values, 12), e26 = emaSeries(values, 26);
    const line = values.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null)).filter(v => v != null);
    if (line.length < 9) return { macd: null, signal: null, hist: null };
    const sig = emaSeries(line, 9);
    const m = line[line.length - 1], s = sig[sig.length - 1];
    return { macd: m, signal: s, hist: m - s };
  }

  // Swing-based support/resistance: nearest pivot lows below / highs above price.
  function supportResistance(candles, price, lookback = 3) {
    const lows = [], highs = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
      const win = candles.slice(i - lookback, i + lookback + 1);
      if (candles[i].low === Math.min(...win.map(c => c.low))) lows.push(candles[i].low);
      if (candles[i].high === Math.max(...win.map(c => c.high))) highs.push(candles[i].high);
    }
    const support = lows.filter(v => v < price).sort((a, b) => b - a).slice(0, 2);
    const resistance = highs.filter(v => v > price).sort((a, b) => a - b).slice(0, 2);
    return { support, resistance };
  }

  const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

  function buildMarketData({ symbol, timeframe, candles, meta, source }) {
    const closes = candles.map(c => c.close);
    const last = candles[candles.length - 1];
    const price = meta && isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : last.close;
    // Day change: use the exchange's previous close when Yahoo provides it
    // (chartPreviousClose is the close before the whole range, so it isn't used).
    const metaPrev = meta && [meta.regularMarketPreviousClose, meta.previousClose].find(v => isFinite(v));
    const prevClose = metaPrev ?? (candles.length > 1 ? candles[candles.length - 2].close : last.open);
    const ema20 = emaSeries(closes, 20);
    const m = macd(closes);
    const sr = supportResistance(candles.slice(-150), price);
    const yr = candles.slice(-252);
    return {
      source, symbol, timeframe,
      name: (meta && (meta.longName || meta.shortName)) || symbol,
      currency: (meta && meta.currency) || 'INR',
      price: r2(price), open: r2(last.open), high: r2(last.high), low: r2(last.low),
      change: r2(price - prevClose),
      changePercent: prevClose ? r2((price - prevClose) / prevClose * 100) : 0,
      volume: last.volume,
      rsi: r2(rsi(closes)),
      macd: r2(m.macd), macdSignal: r2(m.signal), macdHist: r2(m.hist),
      ma50: r2(sma(closes, 50)), ma200: r2(sma(closes, 200)),
      ema20: r2(ema20[ema20.length - 1]),
      ema20Series: ema20,
      support: sr.support.map(r2), resistance: sr.resistance.map(r2),
      high52w: r2(Math.max(...yr.map(c => c.high))), low52w: r2(Math.min(...yr.map(c => c.low))),
      lastCandleTime: last.date,
      timestamp: new Date().toISOString(),
      priceHistory: candles,
    };
  }

  // ---------- Simulated fallback (clearly labelled) ----------
  function simulatedCandles(symbol, timeframe) {
    const seed = String(symbol || 'X').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    let s = seed * 9301 + 49297;
    const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; // deterministic per symbol
    const stepMs = { '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5, '1d': 864e5, '1w': 6048e5, '1mo': 2592e6 }[timeframe] || 864e5;
    const n = 300;
    let price = 100 + (seed % 1900);
    const vol = 0.012 + (seed % 20) / 1000;
    const candles = [];
    for (let i = 0; i < n; i++) {
      const open = price;
      const close = open * (1 + (rand() - 0.49) * 2 * vol);
      const high = Math.max(open, close) * (1 + rand() * vol * 0.5);
      const low = Math.min(open, close) * (1 - rand() * vol * 0.5);
      const t = Date.now() - (n - i) * stepMs;
      candles.push({ time: t, date: new Date(t).toISOString(), open, high, low, close, volume: Math.floor(5e4 + rand() * 5e6) });
      price = close;
    }
    return candles;
  }

  // ---------- ICICI Breeze (via api/breeze.php) ----------
  const BREEZE_URL = 'api/breeze.php';
  // Breeze offers 1minute / 5minute / 30minute / 1day; other timeframes are built from these.
  const BREEZE_TF = {
    '5m':  { interval: '5minute',  days: 14 },
    '15m': { interval: '5minute',  days: 28,   aggregate: 3 },
    '30m': { interval: '30minute', days: 100 },
    '1h':  { interval: '30minute', days: 150,  aggregate: 2 },
    '4h':  { interval: '30minute', days: 200,  aggregate: 8 },
    '1d':  { interval: '1day',     days: 1400 },
    '1w':  { interval: '1day',     days: 2800, period: 'week' },
    '1mo': { interval: '1day',     days: 4500, period: 'month' },
  };
  let breezeState = null; // { configured, loggedIn, checkedAt }

  async function getJSON(url) {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { throw Object.assign(new Error(resp.ok ? 'Data proxy returned non-JSON (is PHP enabled on the host?)' : `Data proxy error ${resp.status}`), { status: resp.status }); }
    if (!resp.ok || (json && json.error && !json.chart)) {
      if (json && json.needsLogin && breezeState) breezeState.loggedIn = false;
      if (json && json.authRequired) window.dispatchEvent(new CustomEvent('mm:auth-required'));
      throw Object.assign(new Error((json && json.error) || `HTTP ${resp.status}`), { status: resp.status, needsLogin: !!(json && json.needsLogin) });
    }
    return json;
  }

  async function breezeStatus(force) {
    if (!force && breezeState && Date.now() - breezeState.checkedAt < 60 * 1000) return breezeState;
    try {
      const s = await getJSON(`${BREEZE_URL}?action=status`);
      breezeState = { configured: !!s.configured, loggedIn: !!s.loggedIn, checkedAt: Date.now() };
    } catch {
      breezeState = { configured: false, loggedIn: false, unavailable: true, checkedAt: Date.now() };
    }
    return breezeState;
  }

  // Group daily candles into weeks (Mon-start) or calendar months.
  function aggregateByPeriod(candles, period) {
    const keyOf = (t) => {
      const d = new Date(t + 5.5 * 3600 * 1000); // IST calendar
      if (period === 'month') return d.toISOString().slice(0, 7);
      const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
      return new Date(d.getTime() - day * 86400000).toISOString().slice(0, 10);
    };
    const out = [];
    let cur = null, curKey = null;
    for (const c of candles) {
      const k = keyOf(c.time);
      if (k !== curKey) { if (cur) out.push(cur); cur = { ...c }; curKey = k; continue; }
      cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low);
      cur.close = c.close; cur.volume += c.volume;
    }
    if (cur) out.push(cur);
    return out;
  }

  async function fetchBreezeCandles(symbol, timeframe) {
    const req = BREEZE_TF[timeframe] || BREEZE_TF['1d'];
    const sym = String(symbol || '').trim().toUpperCase();
    const key = `breeze|${sym}|${timeframe}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const json = await getJSON(`${BREEZE_URL}?action=candles&symbol=${encodeURIComponent(sym)}&interval=${req.interval}&days=${req.days}`);
    let candles = (json.candles || []).map(r => ({ time: r[0] * 1000, date: new Date(r[0] * 1000).toISOString(), open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
    if (!candles.length) throw new Error('ICICI returned no candles');
    if (req.aggregate) candles = aggregateCandles(candles, req.aggregate);
    if (req.period) candles = aggregateByPeriod(candles, req.period);
    const data = { meta: { longName: json.name ? titleCase(json.name) : sym, currency: 'INR', isec: json.isec }, candles };
    cache.set(key, { at: Date.now(), data });
    return data;
  }

  function titleCase(s) {
    return String(s).toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase());
  }

  // Live quote (ICICI only): LTP, best bid/offer with quantities, day range.
  async function getQuote(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    return getJSON(`${BREEZE_URL}?action=quote&symbol=${encodeURIComponent(sym)}`);
  }

  // ---------- Yahoo Finance (via api/chart.php) ----------
  async function fetchCandles(symbol, timeframe) {
    const req = TF_REQUEST[timeframe] || TF_REQUEST['1d'];
    const ySym = toYahooSymbol(symbol);
    const key = `${ySym}|${req.interval}|${req.range}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const json = await getJSON(`${API_URL}?symbol=${encodeURIComponent(ySym)}&interval=${req.interval}&range=${req.range}`);
    const parsed = parseYahooChart(json);
    if (req.aggregate) parsed.candles = aggregateCandles(parsed.candles, req.aggregate);
    cache.set(key, { at: Date.now(), data: parsed });
    return parsed;
  }

  // ---------- Public API ----------
  // Returns market data for one symbol/timeframe. Never throws.
  // Source order: ICICI Breeze (when logged in) -> Yahoo Finance -> simulated.
  // md.live is true for real data; md.sourceNotes explains any fallback.
  async function getMarketData(symbol, timeframe, opts = {}) {
    const notes = [];
    const status = await breezeStatus();
    if (status.loggedIn) {
      try {
        const { meta, candles } = await fetchBreezeCandles(symbol, timeframe);
        const md = buildMarketData({ symbol, timeframe, candles, meta, source: 'ICICI Breeze' });
        md.live = true; md.sourceNotes = notes;
        return md;
      } catch (err) {
        notes.push('ICICI: ' + (err.message || err));
      }
    } else if (status.configured) {
      notes.push('ICICI: not logged in today');
    }
    try {
      const { meta, candles } = await fetchCandles(symbol, timeframe);
      const md = buildMarketData({ symbol, timeframe, candles, meta, source: 'Yahoo Finance' });
      md.live = true; md.sourceNotes = notes;
      return md;
    } catch (err) {
      notes.push('Yahoo: ' + (err.message || err));
      if (opts.noFallback) throw err;
      const md = buildMarketData({ symbol, timeframe, candles: simulatedCandles(symbol, timeframe), meta: null, source: 'Simulated' });
      md.live = false; md.sourceNotes = notes;
      md.liveError = notes.join(' · ');
      return md;
    }
  }

  const MarketData = { TF_REQUEST, BREEZE_TF, toYahooSymbol, parseYahooChart, aggregateCandles, aggregateByPeriod, emaSeries, sma, rsi, macd, buildMarketData, simulatedCandles, fetchCandles, fetchBreezeCandles, breezeStatus, getQuote, getMarketData };
  root.MarketData = MarketData;
})(typeof window !== 'undefined' ? window : globalThis);

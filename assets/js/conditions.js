// ============================================================
// MarketMind AI — strategy condition engine
// Turns plain-English strategy conditions into checks on candles.
//   Conditions.check("Price above 200-day SMA", data) -> { met, detail } | null
// null means "can't be checked from price data" (shown as "check manually").
// data = market data from MarketData (price, priceHistory, support, ...).
// ============================================================
(function (root) {
  'use strict';

  // ---------- indicator helpers (on arrays of candles) ----------
  const closes = c => c.map(x => x.close);
  function smaAt(values, period, endIdx) {
    if (endIdx + 1 < period || endIdx < 0) return null;
    let s = 0;
    for (let i = endIdx - period + 1; i <= endIdx; i++) s += values[i];
    return s / period;
  }
  function emaSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period - 1] = e;
    for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }
  function maSeries(values, period, type) {
    if (type === 'ema') return emaSeries(values, period);
    return values.map((_, i) => smaAt(values, period, i));
  }
  function rsiSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= period; l /= period;
    out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      g = (g * (period - 1) + Math.max(d, 0)) / period;
      l = (l * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }
  function macdHistSeries(values) {
    const e12 = emaSeries(values, 12), e26 = emaSeries(values, 26);
    const line = values.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
    const start = line.findIndex(v => v != null);
    const out = new Array(values.length).fill(null);
    if (start < 0) return { line, signal: out, hist: out };
    const sig = emaSeries(line.slice(start), 9);
    const signal = new Array(values.length).fill(null);
    sig.forEach((v, i) => { signal[start + i] = v; });
    const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
    return { line, signal, hist };
  }
  // Slow stochastic %K (14, 3): 3-period SMA of fast %K
  function stochSeries(candles, period = 14, smooth = 3) {
    const fast = candles.map((_, i) => {
      if (i + 1 < period) return null;
      const win = candles.slice(i - period + 1, i + 1);
      const hi = Math.max(...win.map(c => c.high)), lo = Math.min(...win.map(c => c.low));
      return hi === lo ? 50 : (candles[i].close - lo) / (hi - lo) * 100;
    });
    return fast.map((_, i) => {
      const w = fast.slice(Math.max(0, i - smooth + 1), i + 1);
      return w.length === smooth && w.every(v => v != null) ? w.reduce((a, b) => a + b, 0) / smooth : null;
    });
  }
  function bollinger(candles, period = 20, mult = 2, endIdx = candles.length - 1) {
    const v = closes(candles);
    const mid = smaAt(v, period, endIdx);
    if (mid == null) return null;
    let ss = 0;
    for (let i = endIdx - period + 1; i <= endIdx; i++) ss += (v[i] - mid) ** 2;
    const sd = Math.sqrt(ss / period);
    return { mid, upper: mid + mult * sd, lower: mid - mult * sd, width: (2 * mult * sd) / v[endIdx] };
  }

  // ---------- volatility and trend-strength helpers ----------
  // Wilder's smoothing (used by ATR, ADX and Supertrend)
  function wilder(values, period) {
    const out = new Array(values.length).fill(null);
    let start = values.findIndex(v => v != null);
    if (start < 0 || values.length - start < period) return out;
    let s = 0;
    for (let i = start; i < start + period; i++) s += values[i];
    let prev = s / period;
    out[start + period - 1] = prev;
    for (let i = start + period; i < values.length; i++) { prev = (prev * (period - 1) + values[i]) / period; out[i] = prev; }
    return out;
  }
  const trueRange = (c, i) => (i === 0 ? c[0].high - c[0].low : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  function atrSeries(c, period = 14) { return wilder(c.map((_, i) => trueRange(c, i)), period); }

  // ADX with +DI / -DI (Wilder, 14)
  function adxSeries(c, period = 14) {
    const n = c.length;
    const tr = [null], pdm = [null], mdm = [null];
    for (let i = 1; i < n; i++) {
      const up = c[i].high - c[i - 1].high, down = c[i - 1].low - c[i].low;
      tr.push(trueRange(c, i));
      pdm.push(up > down && up > 0 ? up : 0);
      mdm.push(down > up && down > 0 ? down : 0);
    }
    const sTr = wilder(tr, period), sP = wilder(pdm, period), sM = wilder(mdm, period);
    const plus = sTr.map((t, i) => (t ? 100 * sP[i] / t : null));
    const minus = sTr.map((t, i) => (t ? 100 * sM[i] / t : null));
    const dx = plus.map((p, i) => (p == null || minus[i] == null || p + minus[i] === 0 ? null : 100 * Math.abs(p - minus[i]) / (p + minus[i])));
    return { adx: wilder(dx, period), plus, minus };
  }

  // Supertrend (10, 3): returns the line and direction (+1 up, -1 down) per candle
  function supertrendSeries(c, period = 10, mult = 3) {
    const atr = atrSeries(c, period);
    const line = new Array(c.length).fill(null), dir = new Array(c.length).fill(null);
    let fu = null, fl = null, d = 1;
    for (let i = 0; i < c.length; i++) {
      if (atr[i] == null) continue;
      const mid = (c[i].high + c[i].low) / 2;
      const bu = mid + mult * atr[i], bl = mid - mult * atr[i];
      const prevClose = i > 0 ? c[i - 1].close : c[i].close;
      fu = fu == null || bu < fu || prevClose > fu ? bu : fu;
      fl = fl == null || bl > fl || prevClose < fl ? bl : fl;
      if (d === 1 && c[i].close < fl) d = -1;
      else if (d === -1 && c[i].close > fu) d = 1;
      dir[i] = d;
      line[i] = d === 1 ? fl : fu;
    }
    return { line, dir };
  }

  // Breakout-and-retest ("old resistance becomes support"): the top of the range price
  // broke out of in the last 15 bars. Returns { level, breakoutAgo } or null.
  function breakoutLevel(c) {
    const n = c.length;
    if (n < 70) return null;
    const range = c.slice(n - 60, n - 15);
    const level = Math.max(...range.map(x => x.high));
    for (let i = n - 15; i < n; i++) {
      if (c[i].close > level * 1.01) return { level, breakoutAgo: n - 1 - i };
    }
    return null;
  }

  // Swing points confirmed by 2 lower highs / higher lows on each side
  function swings(c, kind, from) {
    const out = [];
    for (let i = Math.max(2, from); i < c.length - 2; i++) {
      const v = kind === 'low' ? c[i].low : c[i].high;
      const better = (a) => (kind === 'low' ? a > v : a < v);
      const val = (j) => (kind === 'low' ? c[j].low : c[j].high);
      if (better(val(i - 1)) && better(val(i - 2)) && better(val(i + 1)) && better(val(i + 2))) out.push(i);
    }
    return out;
  }

  // ---------- candlestick shapes ----------
  const body = c => Math.abs(c.close - c.open);
  const rangeOf = c => c.high - c.low;
  const isGreen = c => c.close > c.open;
  const isRed = c => c.close < c.open;
  function isHammer(c) {
    const b = body(c), r = rangeOf(c);
    if (r <= 0) return false;
    const lower = Math.min(c.open, c.close) - c.low, upper = c.high - Math.max(c.open, c.close);
    return b > 0 && lower >= 2 * b && upper <= b * 0.5 && b / r <= 0.4;
  }
  function isShootingStar(c) {
    const b = body(c), r = rangeOf(c);
    if (r <= 0) return false;
    const lower = Math.min(c.open, c.close) - c.low, upper = c.high - Math.max(c.open, c.close);
    return b > 0 && upper >= 2 * b && lower <= b * 0.5 && b / r <= 0.4;
  }
  const isBullishEngulfing = (p, c) => isRed(p) && isGreen(c) && c.open <= p.close && c.close >= p.open && body(c) > body(p);
  const isBearishEngulfing = (p, c) => isGreen(p) && isRed(c) && c.open >= p.close && c.close <= p.open && body(c) > body(p);
  const isDoji = c => rangeOf(c) > 0 && body(c) / rangeOf(c) <= 0.1;
  const isBullishMarubozu = c => isGreen(c) && rangeOf(c) > 0 && body(c) / rangeOf(c) >= 0.9;
  const isBearishMarubozu = c => isRed(c) && rangeOf(c) > 0 && body(c) / rangeOf(c) >= 0.9;
  const avgBody = (c, n = 10) => c.slice(-n - 3, -3).reduce((a, x) => a + body(x), 0) / Math.max(1, Math.min(n, c.length - 3));
  function isMorningStar(c) {
    if (c.length < 13) return false;
    const [a, b, d] = c.slice(-3), ab = avgBody(c);
    return isRed(a) && body(a) >= ab && body(b) <= body(a) * 0.35 && Math.max(b.open, b.close) <= a.close + body(a) * 0.1
      && isGreen(d) && d.close > (a.open + a.close) / 2;
  }
  function isEveningStar(c) {
    if (c.length < 13) return false;
    const [a, b, d] = c.slice(-3), ab = avgBody(c);
    return isGreen(a) && body(a) >= ab && body(b) <= body(a) * 0.35 && Math.min(b.open, b.close) >= a.close - body(a) * 0.1
      && isRed(d) && d.close < (a.open + a.close) / 2;
  }
  const isBullishHarami = (p, l) => isRed(p) && isGreen(l) && body(l) < body(p) * 0.6 && l.close <= p.open && l.open >= p.close;
  const isBearishHarami = (p, l) => isGreen(p) && isRed(l) && body(l) < body(p) * 0.6 && l.open <= p.close && l.close >= p.open;
  function isThreeWhiteSoldiers(c) {
    if (c.length < 13) return false;
    const t = c.slice(-3), ab = avgBody(c);
    return t.every(x => isGreen(x) && body(x) >= ab * 0.8 && (x.high - x.close) <= body(x) * 0.4)
      && t[1].close > t[0].close && t[2].close > t[1].close
      && t[1].open >= t[0].open && t[1].open <= t[0].close * 1.005 && t[2].open >= t[1].open && t[2].open <= t[1].close * 1.005;
  }

  // ---------- parsing helpers ----------
  const num = (s, d) => { const m = s && s.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : d; };
  const fmt = v => (v == null || !isFinite(v) ? 'n/a' : Number(v).toFixed(2));
  const isBelow = s => /\b(below|under|less than)\b|</.test(s);
  const res = (met, detail) => ({ met: !!met, detail });
  // "in the last 5 days/candles/bars"
  const lookback = (s, d) => { const m = s.match(/(?:last|past|previous)\s+(\d+)\s*(?:days?|candles?|bars?|sessions?)/); return m ? parseInt(m[1], 10) : d; };
  const maType = s => (/\bema\b|exponential/.test(s) ? 'ema' : 'sma');
  const maLabel = (p, t) => `${p}-${t === 'ema' ? 'EMA' : 'SMA'}`;

  // Each matcher: [regex, fn(text, match, data, candles)] — first match wins.
  const MATCHERS = [
    // "Higher timeframe trend bullish" can't be judged from one timeframe's candles (the KS-001 report covers it)
    [/higher timeframe|\bhtf\b|weekly trend/, () => null],
    // "Supertrend bullish", "Supertrend turned bullish in the last 3 days"
    [/\bsupertrend\b/, (s, m, data, c) => {
      const { line, dir } = supertrendSeries(c);
      const d = dir[dir.length - 1];
      if (d == null) return null;
      const bear = /bear|down|sell|red/.test(s);
      const want = bear ? -1 : 1;
      const label = `Supertrend ${d === 1 ? 'bullish' : 'bearish'} (line ${fmt(line[line.length - 1])})`;
      if (/turn|flip|cross/.test(s)) {
        const n = lookback(s, 3);
        for (let i = dir.length - 1; i > dir.length - 1 - n && i > 0; i--) {
          if (dir[i] === want && dir[i - 1] === -want) return res(true, `${label}, turned ${dir.length - 1 - i} bars ago`);
        }
        return res(false, `${label}, no turn in last ${n} bars`);
      }
      return res(d === want, label);
    }],
    // "ADX above 25", "+DI above -DI"
    [/\badx\b|[+-]\s*di\b/, (s, m, data, c) => {
      const { adx, plus, minus } = adxSeries(c);
      const a = adx[adx.length - 1], p = plus[plus.length - 1], q = minus[minus.length - 1];
      if (a == null || p == null) return null;
      const label = `ADX ${a.toFixed(1)}, +DI ${p.toFixed(1)}, -DI ${q.toFixed(1)}`;
      if (/\badx\b/.test(s)) { const lvl = num(s.replace(/adx\s*\(\s*\d+\s*\)/, ''), 25); return res(isBelow(s) ? a < lvl : a > lvl, label); }
      const plusFirst = s.indexOf('+') < s.indexOf('-') || s.indexOf('-') < 0;
      return res(isBelow(s) === plusFirst ? p < q : p > q, label);
    }],
    // "Close at a 20-day high", "Close at a 20-day low", "Price within 5% of 52-week high"
    [/(\d+)\s*-?\s*(day|week)\s+(high|low)/, (s, m, data, c) => {
      const n = parseInt(m[1], 10) * (m[2] === 'week' ? 5 : 1);
      const high = m[3] === 'high';
      if (c.length < Math.min(n, 60) + 1) return null;
      const prior = c.slice(Math.max(0, c.length - 1 - n), -1);
      const lvl = high ? Math.max(...prior.map(x => x.high)) : Math.min(...prior.map(x => x.low));
      const within = s.match(/within\s+(\d+(?:\.\d+)?)\s*%/);
      const label = `price ${fmt(data.price)} vs ${m[1]}-${m[2]} ${m[3]} ${fmt(lvl)}`;
      if (within) {
        const pct = parseFloat(within[1]) / 100;
        return res(high ? data.price >= lvl * (1 - pct) : data.price <= lvl * (1 + pct), label);
      }
      return res(high ? data.price > lvl : data.price < lvl, label);
    }],
    // "Inside bar on the previous candle"
    [/inside bar/, (s, m, data, c) => {
      const idx = /previous|prior|yesterday/.test(s) ? c.length - 2 : c.length - 1;
      if (idx < 1) return null;
      const a = c[idx - 1], b = c[idx];
      const ok = b.high <= a.high && b.low >= a.low;
      return res(ok, ok ? `inside bar (${fmt(b.low)}–${fmt(b.high)} within ${fmt(a.low)}–${fmt(a.high)})` : 'no inside bar');
    }],
    // "Retest of breakout level within 3%"
    [/retest/, (s, m, data, c) => {
      const pct = num((s.match(/within\s+(\d+(?:\.\d+)?)\s*%/) || [])[1], 3);
      const b = breakoutLevel(c);
      if (!b) return res(false, 'no breakout above a range high in the last 15 bars');
      const d = (data.price - b.level) / b.level * 100;
      return res(d >= -1 && d <= pct, `broke out above ${fmt(b.level)} ${b.breakoutAgo} bars ago; price is ${d.toFixed(1)}% above it`);
    }],
    // "RSI bullish divergence in the last 30 days"
    [/divergence/, (s, m, data, c) => {
      const n = lookback(s, 30);
      const bull = !/bear/.test(s);
      const r = rsiSeries(closes(c), 14);
      const pts = swings(c, bull ? 'low' : 'high', c.length - n);
      if (pts.length < 2) return res(false, `fewer than two swing ${bull ? 'lows' : 'highs'} in last ${n} bars`);
      const i1 = pts[pts.length - 2], i2 = pts[pts.length - 1];
      if (r[i1] == null || r[i2] == null || i2 - i1 < 4) return res(false, 'swings too close together');
      const ok = bull ? c[i2].low < c[i1].low && r[i2] > r[i1] + 2 : c[i2].high > c[i1].high && r[i2] < r[i1] - 2;
      return res(ok, `swing ${bull ? 'lows' : 'highs'} ${fmt(bull ? c[i1].low : c[i1].high)} → ${fmt(bull ? c[i2].low : c[i2].high)}, RSI ${r[i1].toFixed(0)} → ${r[i2].toFixed(0)}`);
    }],
    // "Low touched lower Bollinger Band in the last 3 days"
    [/(touch|tag)\w*\s+(?:the\s+)?(lower|upper)\s+bollinger/, (s, m, data, c) => {
      const n = lookback(s, 3), lower = m[2] === 'lower';
      for (let i = c.length - 1; i >= c.length - n && i >= 20; i--) {
        const bb = bollinger(c, 20, 2, i);
        if (bb && (lower ? c[i].low <= bb.lower : c[i].high >= bb.upper)) return res(true, `${lower ? 'low' : 'high'} reached the ${m[2]} band ${c.length - 1 - i} bars ago`);
      }
      return res(false, `${m[2]} band not reached in last ${n} bars`);
    }],
    // Three-candle and harami patterns
    [/morning star|evening star|harami|three white soldiers/, (s, m, data, c) => {
      if (c.length < 13) return null;
      const p = c[c.length - 2], l = c[c.length - 1];
      const checks = [];
      if (/morning star/.test(s)) checks.push(['morning star', isMorningStar(c)]);
      if (/evening star/.test(s)) checks.push(['evening star', isEveningStar(c)]);
      if (/bullish harami/.test(s) || (/harami/.test(s) && !/bearish/.test(s))) checks.push(['bullish harami', isBullishHarami(p, l)]);
      if (/bearish harami/.test(s)) checks.push(['bearish harami', isBearishHarami(p, l)]);
      if (/three white soldiers/.test(s)) checks.push(['three white soldiers', isThreeWhiteSoldiers(c)]);
      const hit = checks.find(x => x[1]);
      return res(!!hit, hit ? `${hit[0]} on the last candles` : `no ${checks.map(x => x[0]).join(' / ')}`);
    }],
    // KS-001 zones: "qualifying demand zone within 3% below price"
    [/\b(demand|supply)\s+zone/, (s, m, data, c) => {
      if (!root.KS001) return null;
      const side = m[1];
      const pct = num((s.match(/within\s+(\d+(?:\.\d+)?)\s*%/) || [])[1], 3);
      const zones = root.KS001.detectZones(c);
      const scored = zones.map(z => root.KS001.scoreZone(z, { zones, candles: c }));
      const price = data.price;
      const pool = scored.filter(z => z.side === side && (side === 'demand' ? price >= z.distal : price <= z.distal))
        .filter(z => Math.abs(price - z.proximal) / price * 100 <= pct || (side === 'demand' ? price <= z.proximal : price >= z.proximal));
      const needQual = /qualif|score|7\+|fresh/.test(s);
      const hit = pool.filter(z => !needQual || (z.qualifies && (!/fresh/.test(s) || z.fresh)))
        .sort((a, b) => Math.abs(price - a.proximal) - Math.abs(price - b.proximal))[0];
      return hit ? res(true, `${hit.pattern} ${side} zone at ${fmt(hit.proximal)} (score ${hit.score.total}/10)`) : res(false, `no ${needQual ? 'qualifying ' : ''}${side} zone within ${pct}%`);
    }],
    // "20-day SMA above 150-day SMA", "50 EMA below 200 EMA"
    [/(\d+)\s*-?\s*(?:day|period|d)?\s*(sma|ema|dma|ma|moving average)\b.*\b(above|below|over|under)\b.*?(\d+)\s*-?\s*(?:day|period|d)?\s*(sma|ema|dma|ma|moving average)\b/, (s, m, data, c) => {
      const v = closes(c), a = parseInt(m[1], 10), b = parseInt(m[4], 10);
      const ta = m[2] === 'ema' ? 'ema' : 'sma', tb = m[5] === 'ema' ? 'ema' : 'sma';
      const sa = maSeries(v, a, ta), sb = maSeries(v, b, tb);
      const x = sa[sa.length - 1], y = sb[sb.length - 1];
      if (x == null || y == null) return null;
      const below = /below|under/.test(m[3]);
      return res(below ? x < y : x > y, `${maLabel(a, ta)} ${fmt(x)} vs ${maLabel(b, tb)} ${fmt(y)}`);
    }],
    // "golden cross in the last 20 days" / "death cross"
    [/golden cross|death cross/, (s, m, data, c) => {
      const v = closes(c), fast = maSeries(v, 50, 'sma'), slow = maSeries(v, 200, 'sma');
      if (slow[slow.length - 1] == null) return null;
      const n = lookback(s, 20), golden = /golden/.test(s);
      for (let i = v.length - 1; i >= Math.max(1, v.length - n); i--) {
        if (fast[i - 1] == null || slow[i - 1] == null) break;
        const up = fast[i] > slow[i] && fast[i - 1] <= slow[i - 1];
        const down = fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];
        if ((golden && up) || (!golden && down)) return res(true, `${golden ? 'golden' : 'death'} cross ${v.length - 1 - i} bars ago`);
      }
      return res(false, `no ${golden ? 'golden' : 'death'} cross in last ${n} bars`);
    }],
    // "Price within 3% of 50-day SMA"
    [/within\s+(\d+(?:\.\d+)?)\s*%\s+of\s+(?:the\s+)?(\d+)\s*-?\s*(?:day|period|d)?\s*(sma|ema|dma|ma|moving average)/, (s, m, data, c) => {
      const p = parseInt(m[2], 10), t = m[3] === 'ema' ? 'ema' : 'sma';
      const ma = maSeries(closes(c), p, t).pop();
      if (ma == null) return null;
      const d = Math.abs(data.price - ma) / ma * 100;
      return res(d <= parseFloat(m[1]), `${d.toFixed(1)}% from ${maLabel(p, t)} ${fmt(ma)}`);
    }],
    // "Price within 3% of nearest support/resistance"
    [/within\s+(\d+(?:\.\d+)?)\s*%\s+of\s+(?:the\s+)?(?:nearest\s+)?(support|resistance)/, (s, m, data) => {
      const lvl = data[m[2]] && data[m[2]][0];
      if (lvl == null) return res(false, `no ${m[2]} level found`);
      const d = Math.abs(data.price - lvl) / data.price * 100;
      return res(d <= parseFloat(m[1]), `${d.toFixed(1)}% from ${m[2]} ${fmt(lvl)}`);
    }],
    // "Price above rising 20 EMA", "Close below 5-day SMA", "Price above 200 DMA"
    [/(price|close)\b.*\b(above|below|over|under)\b.*?(rising|falling)?\s*(\d+)\s*-?\s*(?:day|period|d)?\s*(sma|ema|dma|ma|moving average)/, (s, m, data, c) => {
      const p = parseInt(m[4], 10), t = m[5] === 'ema' ? 'ema' : 'sma';
      const series = maSeries(closes(c), p, t);
      const ma = series[series.length - 1];
      if (ma == null) return null;
      const below = /below|under/.test(m[2]);
      let ok = below ? data.price < ma : data.price > ma;
      let slope = '';
      if (m[3]) {
        const prev = series[series.length - 6];
        if (prev == null) return null;
        const rising = ma > prev;
        ok = ok && (m[3] === 'rising' ? rising : !rising);
        slope = `, ${rising ? 'rising' : 'falling'}`;
      }
      return res(ok, `price ${fmt(data.price)} vs ${maLabel(p, t)} ${fmt(ma)}${slope}`);
    }],
    // "RSI(2) below 10", "RSI between 40 and 50", "RSI above 50", "RSI crossed above 50"
    [/\brsi\b/, (s, m, data, c) => {
      const pm = s.match(/rsi\s*\(\s*(\d+)\s*\)/);
      const period = pm ? parseInt(pm[1], 10) : 14;
      const rest = pm ? s.slice(s.indexOf(pm[0]) + pm[0].length) : s.slice(s.indexOf('rsi') + 3);
      const series = rsiSeries(closes(c), period);
      const r = series[series.length - 1];
      if (r == null) return null;
      const label = `RSI(${period}) ${r.toFixed(1)}`;
      const between = rest.match(/between\s+(\d+(?:\.\d+)?)\s+and\s+(\d+(?:\.\d+)?)/);
      if (between) { const lo = +between[1], hi = +between[2]; return res(r >= Math.min(lo, hi) && r <= Math.max(lo, hi), label); }
      if (/overbought/.test(rest)) return res(r > 70, label);
      if (/oversold/.test(rest)) return res(r < 30, label);
      const lvl = num(rest, 50);
      const n = lookback(rest, 1);
      const recent = series.slice(-n).filter(x => x != null);
      return res(isBelow(rest) ? recent.some(x => x < lvl) : recent.some(x => x > lvl), label);
    }],
    // "Stochastic below 20 in the last 5 days"
    [/stochastic/, (s, m, data, c) => {
      const st = stochSeries(c);
      const k = st[st.length - 1];
      if (k == null) return null;
      const lvl = num(s.replace(/last\s+\d+.*/, ''), isBelow(s) ? 20 : 80);
      const recent = st.slice(-lookback(s, 1)).filter(x => x != null);
      const met = isBelow(s) ? recent.some(x => x < lvl) : recent.some(x => x > lvl);
      return res(met, `%K now ${k.toFixed(1)}${recent.length > 1 ? `, range ${Math.min(...recent).toFixed(0)}–${Math.max(...recent).toFixed(0)} in last ${recent.length}` : ''}`);
    }],
    // "MACD histogram turned positive (last 3 days)", "MACD histogram positive", "MACD above zero"
    [/macd/, (s, m, data, c) => {
      const { line, signal, hist } = macdHistSeries(closes(c));
      const h = hist[hist.length - 1], L = line[line.length - 1], S = signal[signal.length - 1];
      if (h == null) return null;
      const neg = /negative|bearish|below/.test(s);
      if (/turn|cross/.test(s) && /hist|signal|cross/.test(s)) {
        const n = lookback(s, 3);
        for (let i = hist.length - 1; i >= hist.length - n && i > 0; i--) {
          if (hist[i - 1] == null) break;
          if (!neg && hist[i] > 0 && hist[i - 1] <= 0) return res(true, `histogram turned positive ${hist.length - 1 - i} bars ago`);
          if (neg && hist[i] < 0 && hist[i - 1] >= 0) return res(true, `histogram turned negative ${hist.length - 1 - i} bars ago`);
        }
        return res(false, `histogram ${h.toFixed(2)}, no ${neg ? 'negative' : 'positive'} turn in last ${n} bars`);
      }
      if (/zero|centre|center/.test(s)) return res(neg ? L < 0 : L > 0, `MACD ${L.toFixed(2)}`);
      return res(neg ? L < S : L > S, `MACD ${L.toFixed(2)} vs signal ${S.toFixed(2)}`);
    }],
    // Bollinger: squeeze / close above upper / below lower band
    [/bollinger|bandwidth|squeeze/, (s, m, data, c) => {
      const bb = bollinger(c);
      if (!bb) return null;
      if (/squeeze|bandwidth/.test(s)) {
        const pct = num((s.match(/(\d+(?:\.\d+)?)\s*%/) || [])[1], 4);
        const widths = [];
        for (let i = Math.max(19, c.length - 126); i < c.length; i++) { const b = bollinger(c, 20, 2, i); if (b) widths.push(b.width); }
        const minW = Math.min(...widths);
        const nearLow = bb.width <= minW * 1.1;
        return res(bb.width * 100 < pct || nearLow, `BandWidth ${(bb.width * 100).toFixed(1)}% of price${nearLow ? ' (near 6-month low)' : ''}`);
      }
      if (/upper/.test(s)) return res(data.price > bb.upper, `price ${fmt(data.price)} vs upper band ${fmt(bb.upper)}`);
      if (/lower/.test(s)) return res(isBelow(s) || /under/.test(s) ? data.price < bb.lower : data.price > bb.lower, `price ${fmt(data.price)} vs lower band ${fmt(bb.lower)}`);
      return null;
    }],
    // "NR7 on the previous candle"
    [/\bnr7\b|narrow range/, (s, m, data, c) => {
      const idx = /previous|prior|yesterday/.test(s) ? c.length - 2 : c.length - 1;
      if (idx < 6) return null;
      const win = c.slice(idx - 6, idx + 1).map(rangeOf);
      const ok = win[6] < Math.min(...win.slice(0, 6));
      return res(ok, ok ? 'narrowest range of last 7' : 'not the narrowest range of last 7');
    }],
    // "Close above previous candle high" / "below previous candle low"
    [/(previous|prior)\s+(candle|day|bar)('s)?\s+(high|low)/, (s, m, data, c) => {
      if (c.length < 2) return null;
      const p = c[c.length - 2];
      const lvl = m[4] === 'high' ? p.high : p.low;
      const below = isBelow(s);
      return res(below ? data.price < lvl : data.price > lvl, `price ${fmt(data.price)} vs previous ${m[4]} ${fmt(lvl)}`);
    }],
    // Candlestick patterns on the last candle(s)
    [/engulfing|hammer|shooting star|doji|marubozu|bullish candle|bearish candle/, (s, m, data, c) => {
      if (c.length < 2) return null;
      const p = c[c.length - 2], l = c[c.length - 1];
      const checks = [];
      if (/bullish engulfing/.test(s)) checks.push(['bullish engulfing', isBullishEngulfing(p, l)]);
      if (/bearish engulfing/.test(s)) checks.push(['bearish engulfing', isBearishEngulfing(p, l)]);
      if (/hammer/.test(s)) checks.push(['hammer', isHammer(l)]);
      if (/shooting star/.test(s)) checks.push(['shooting star', isShootingStar(l)]);
      if (/doji/.test(s)) checks.push(['doji', isDoji(l)]);
      if (/bullish marubozu/.test(s)) checks.push(['bullish marubozu', isBullishMarubozu(l)]);
      if (/bearish marubozu/.test(s)) checks.push(['bearish marubozu', isBearishMarubozu(l)]);
      if (/bullish candle/.test(s)) checks.push(['bullish reversal candle', isHammer(l) || isBullishEngulfing(p, l) || isBullishMarubozu(l)]);
      if (/bearish candle/.test(s)) checks.push(['bearish reversal candle', isShootingStar(l) || isBearishEngulfing(p, l) || isBearishMarubozu(l)]);
      if (!checks.length) return null;
      const hit = checks.find(x => x[1]);
      return res(!!hit, hit ? `${hit[0]} on last candle` : `no ${checks.map(x => x[0]).join(' / ')} on last candle`);
    }],
    // "Prior downtrend over the last 5 candles"
    [/prior\s+(downtrend|uptrend)|(down|up)trend\s+(?:over|in)\s+the\s+last/, (s, m, data, c) => {
      const n = lookback(s, 5);
      if (c.length < n + 2) return null;
      const start = c[c.length - 2 - n].close, end = c[c.length - 2].close; // before the signal candle
      const down = /down/.test(m[0]);
      return res(down ? end < start : end > start, `${n}-bar move ${((end - start) / start * 100).toFixed(1)}% before the last candle`);
    }],
    // "Volume above 10-day average"
    [/volume/, (s, m, data, c) => {
      const n = num((s.match(/(\d+)\s*-?\s*(?:day|period|bar)/) || [])[1], 20);
      if (c.length < n + 1) return null;
      const avg = c.slice(-n - 1, -1).reduce((a, x) => a + x.volume, 0) / n;
      const v = c[c.length - 1].volume;
      if (!avg) return null;
      const mult = (s.match(/(\d+(?:\.\d+)?)\s*x/) || [])[1];
      const need = mult ? avg * parseFloat(mult) : avg;
      return res(isBelow(s) ? v < need : v > need, `volume ${(v / avg).toFixed(2)}× its ${n}-day average`);
    }],
  ];

  function check(condition, data) {
    const s = String(condition || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const c = (data && data.priceHistory) || [];
    if (!s || c.length < 2) return null;
    for (const [re, fn] of MATCHERS) {
      const m = s.match(re);
      if (m) {
        try { return fn(s, m, data, c); } catch (e) { return null; }
      }
    }
    return null;
  }

  root.Conditions = { check, atrSeries, adxSeries, supertrendSeries, breakoutLevel, swings, isMorningStar, isEveningStar, isThreeWhiteSoldiers, rsiSeries, stochSeries, macdHistSeries, bollinger, maSeries, isHammer, isShootingStar, isBullishEngulfing, isBearishEngulfing, isDoji };
})(typeof window !== 'undefined' ? window : globalThis);

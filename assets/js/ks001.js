// ============================================================
// MarketMind AI — KS-001 Demand & Supply engine
//
// Zones are found as  leg-in -> base (1-6 candles) -> leg-out.
//   Base candle:     body <= 50% of the candle's range
//   Leg (exciting):  body  > 50% of the candle's range
//   Demand: RBR (rally-base-rally), DBR (drop-base-rally)
//   Supply: RBD (rally-base-drop),  DBD (drop-base-drop)
//   Demand: proximal = highest base body, distal = lowest low (base + first leg-out)
//   Supply: proximal = lowest base body,  distal = highest high (base + first leg-out)
// A zone is removed once a candle closes beyond its distal line.
// Score (out of 10): leg-out strength 3 + base 2 + freshness 3 + risk/reward 2.
// Only zones scoring 7+ AND offering at least 1:2 risk/reward qualify for a trade plan.
// Trend per timeframe uses the 20 EMA (price side + EMA slope).
// ============================================================
(function (root) {
  'use strict';

  const DEFAULTS = {
    baseBodyRatio: 0.5,   // body/range at or below this = base candle
    maxBaseCandles: 6,
    minScore: 7,
    minRR: 2,            // hard gate: reward to the first target must be at least 2x risk
    stopBufferRatio: 0.1, // stop = distal -/+ 10% of zone height
    emaPeriod: 20,
    slopeLookback: 5,
  };

  // Higher timeframes used for each analysis (LTF) timeframe: [ITF, HTF]
  const TF_LADDER = {
    '5m': ['1h', '1d'], '15m': ['1h', '1d'], '30m': ['4h', '1d'],
    '1h': ['1d', '1w'], '4h': ['1d', '1w'], '1d': ['1w', '1mo'],
    '1w': ['1mo', '1mo'], '1mo': ['1mo', '1mo'],
  };

  const body = c => Math.abs(c.close - c.open);
  const range = c => c.high - c.low;
  const isBase = (c, ratio) => range(c) > 0 && body(c) / range(c) <= ratio;
  const dir = c => (c.close >= c.open ? 1 : -1);

  // ---------- Trend (20 EMA) ----------
  function ema(values, period) {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const out = [];
    let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out.push(e);
    for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
    return out;
  }

  function trend(candles, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const series = ema(candles.map(c => c.close), o.emaPeriod);
    if (series.length <= o.slopeLookback) return { trend: 'Unknown', ema20: null, note: 'Not enough candles for a 20 EMA' };
    const last = candles[candles.length - 1].close;
    const e = series[series.length - 1];
    const slope = e - series[series.length - 1 - o.slopeLookback];
    let t = 'Sideways';
    if (last > e && slope > 0) t = 'Bullish';
    else if (last < e && slope < 0) t = 'Bearish';
    return { trend: t, ema20: e, close: last, slope, note: `Close ${last > e ? 'above' : 'below'} 20 EMA, EMA ${slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat'}` };
  }

  // ---------- Zone detection ----------
  function detectZones(candles, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const zones = [];
    const n = candles.length;
    let i = 1;
    while (i < n - 1) {
      if (!isBase(candles[i], o.baseBodyRatio)) { i++; continue; }
      // maximal run of base candles starting at i
      let j = i;
      while (j + 1 < n && isBase(candles[j + 1], o.baseBodyRatio)) j++;
      const legIn = candles[i - 1];
      const legOutIdx = j + 1;
      const runLen = j - i + 1;
      if (runLen <= o.maxBaseCandles && legOutIdx < n && !isBase(legIn, o.baseBodyRatio) && !isBase(candles[legOutIdx], o.baseBodyRatio)) {
        const base = candles.slice(i, j + 1);
        const firstOut = candles[legOutIdx];
        const outDir = dir(firstOut);
        const baseHigh = Math.max(...base.map(c => c.high));
        const baseLow = Math.min(...base.map(c => c.low));
        // leg-out must break out of the base
        const brokeOut = outDir > 0 ? firstOut.close > baseHigh : firstOut.close < baseLow;
        if (brokeOut) {
          // extend the leg-out through consecutive exciting candles in the same direction
          let k = legOutIdx;
          while (k + 1 < n && !isBase(candles[k + 1], o.baseBodyRatio) && dir(candles[k + 1]) === outDir) k++;
          const legOut = candles.slice(legOutIdx, k + 1);
          const demand = outDir > 0;
          const proximal = demand ? Math.max(...base.map(c => Math.max(c.open, c.close))) : Math.min(...base.map(c => Math.min(c.open, c.close)));
          const distal = demand ? Math.min(baseLow, firstOut.low) : Math.max(baseHigh, firstOut.high);
          const height = Math.abs(proximal - distal);
          if (height > 0) {
            const legOutExtreme = demand ? Math.max(...legOut.map(c => c.high)) : Math.min(...legOut.map(c => c.low));
            const legOutMove = Math.abs(legOutExtreme - proximal);
            const inDir = dir(legIn);
            const pattern = (inDir > 0 ? 'R' : 'D') + 'B' + (outDir > 0 ? 'R' : 'D');
            zones.push({
              pattern, side: demand ? 'demand' : 'supply',
              proximal, distal, height,
              baseCandles: runLen, legOutCandles: legOut.length,
              legOutRatio: legOutMove / height,
              startIndex: i - 1, baseStart: i, baseEnd: j, endIndex: k,
              time: candles[i].time, date: candles[i].date,
            });
          }
        }
      }
      i = j + 1;
    }
    return zones.map(z => markFreshness(z, candles)).filter(z => !z.violated);
  }

  // Count separate returns into the zone after it formed; mark violated on a close beyond distal.
  function markFreshness(zone, candles) {
    let tests = 0, inside = false, violated = false;
    for (let i = zone.endIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      const touched = zone.side === 'demand' ? c.low <= zone.proximal : c.high >= zone.proximal;
      const broke = zone.side === 'demand' ? c.close < zone.distal : c.close > zone.distal;
      if (broke) { violated = true; break; }
      if (touched && !inside) tests++;
      inside = touched;
    }
    return { ...zone, tests, violated, fresh: tests === 0 };
  }

  // ---------- Scoring ----------
  function scoreZone(zone, ctx) {
    const o = { ...DEFAULTS, ...(ctx.opts || {}) };
    const legOut = zone.legOutRatio >= 3 ? 3 : zone.legOutRatio >= 2 ? 2 : zone.legOutRatio >= 1 ? 1 : 0;
    const base = zone.baseCandles <= 3 ? 2 : 1;
    const freshness = zone.tests === 0 ? 3 : zone.tests === 1 ? 1.5 : 0;

    const buffer = zone.height * o.stopBufferRatio;
    const entry = zone.proximal;
    const stop = zone.side === 'demand' ? zone.distal - buffer : zone.distal + buffer;
    const risk = Math.abs(entry - stop);
    // Target: nearest opposing zone in the profit direction, else the recent swing extreme
    const opposing = (ctx.zones || [])
      .filter(z => z.side !== zone.side && (zone.side === 'demand' ? z.proximal > entry : z.proximal < entry))
      .sort((a, b) => Math.abs(a.proximal - entry) - Math.abs(b.proximal - entry))[0];
    let target = opposing ? opposing.proximal : null;
    let targetSource = opposing ? `${opposing.side} zone (${opposing.pattern})` : null;
    if (target == null && ctx.candles && ctx.candles.length) {
      const recent = ctx.candles.slice(-100);
      const swing = zone.side === 'demand' ? Math.max(...recent.map(c => c.high)) : Math.min(...recent.map(c => c.low));
      if (zone.side === 'demand' ? swing > entry : swing < entry) { target = swing; targetSource = 'recent swing ' + (zone.side === 'demand' ? 'high' : 'low'); }
    }
    const rr = target != null && risk > 0 ? Math.abs(target - entry) / risk : 0;
    const rrScore = rr >= 3 ? 2 : rr >= 2 ? 1 : 0;
    const total = legOut + base + freshness + rrScore;
    return {
      ...zone, entry, stop, risk, target, targetSource, rr,
      score: { legOut, base, freshness, rr: rrScore, total },
      qualifies: total >= o.minScore && rr >= o.minRR,
    };
  }

  // ---------- Position sizing ----------
  function positionSize({ account, riskPercent, entry, stop }) {
    const riskPerShare = Math.abs(entry - stop);
    if (!(account > 0) || !(riskPercent > 0) || !(riskPerShare > 0)) return null;
    const riskAmount = account * riskPercent / 100;
    let qty = Math.floor(riskAmount / riskPerShare);
    let capped = false;
    if (qty * entry > account) { qty = Math.floor(account / entry); capped = true; }
    return { riskAmount, riskPerShare, qty, capital: qty * entry, actualRisk: qty * riskPerShare, capped };
  }

  // ---------- Full analysis ----------
  // input: { price, ltf: {tf, candles}, itf: {tf, candles}, htf: {tf, candles}, account, riskPercent }
  function analyze(input) {
    const o = { ...DEFAULTS, ...(input.opts || {}) };
    const price = input.price;
    const trends = {
      htf: { tf: input.htf.tf, ...trend(input.htf.candles, o) },
      itf: { tf: input.itf.tf, ...trend(input.itf.candles, o) },
      ltf: { tf: input.ltf.tf, ...trend(input.ltf.candles, o) },
    };
    const raw = detectZones(input.ltf.candles, o);
    const zones = raw.map(z => {
      const s = scoreZone(z, { zones: raw, candles: input.ltf.candles, opts: o });
      const counterTrend = (s.side === 'demand' && trends.htf.trend === 'Bearish') || (s.side === 'supply' && trends.htf.trend === 'Bullish');
      const reasons = [];
      if (s.score.legOut === 0) reasons.push('weak leg-out (moved less than the zone height)');
      if (s.tests >= 2) reasons.push(`tested ${s.tests} times — no longer fresh`);
      if (s.baseCandles > 3) reasons.push(`wide base (${s.baseCandles} candles)`);
      if (s.rr < 2) reasons.push(`risk/reward only ${s.rr.toFixed(1)}`);
      return { ...s, counterTrend, garbage: !s.qualifies, garbageReasons: reasons };
    });

    // zones price could trade from next: demand at/below price, supply at/above price
    // (price above a demand zone's distal line, or below a supply zone's distal line — includes price inside the zone)
    const actionable = zones.filter(z => (z.side === 'demand' ? price >= z.distal : price <= z.distal));
    const byDistance = (a, b) => Math.abs(a.proximal - price) - Math.abs(b.proximal - price);
    const nearestDemand = actionable.filter(z => z.side === 'demand').sort(byDistance);
    const nearestSupply = actionable.filter(z => z.side === 'supply').sort(byDistance);

    const htfT = trends.htf.trend, itfT = trends.itf.trend;
    let bias = 'None';
    if (htfT === 'Bullish') bias = 'Long';
    else if (htfT === 'Bearish') bias = 'Short';
    const aligned = htfT === itfT && (htfT === 'Bullish' || htfT === 'Bearish');

    let setup = null;
    const pool = bias === 'Long' ? nearestDemand : bias === 'Short' ? nearestSupply : [];
    const best = pool.find(z => z.qualifies);
    if (best) setup = best;

    let plan = null;
    if (setup) {
      const long = setup.side === 'demand';
      const R = setup.risk;
      // Targets: the opposing zone / swing level and a fixed 3R, ordered nearest first
      const targets = [];
      if (setup.target != null) targets.push({ v: setup.target, src: setup.targetSource });
      const threeR = long ? setup.entry + 3 * R : setup.entry - 3 * R;
      if (!targets.length || Math.abs(targets[0].v - threeR) > 0.25 * R) targets.push({ v: threeR, src: '3R (3 × risk)' });
      targets.sort((a, b) => Math.abs(a.v - setup.entry) - Math.abs(b.v - setup.entry));
      const t1 = targets[0].v, t2 = targets[1] ? targets[1].v : null;
      const inZone = long ? price <= setup.proximal && price >= setup.distal : price >= setup.proximal && price <= setup.distal;
      plan = {
        direction: long ? 'Long' : 'Short',
        zone: setup, entry: setup.entry, stop: setup.stop,
        target1: t1, target1Source: targets[0].src, target2: t2, target2Source: targets[1] ? targets[1].src : null,
        rr: Math.abs(t1 - setup.entry) / R, status: inZone ? 'Price is inside the zone now' : `Wait for price to reach ${setup.entry.toFixed(2)}`,
        distancePct: Math.abs(price - setup.entry) / price * 100,
        invalidation: `${long ? 'Daily/ITF close below' : 'Daily/ITF close above'} the distal line at ${setup.distal.toFixed(2)} (${trends.itf.tf} / ${trends.htf.tf}).`,
        sizing: positionSize({ account: input.account, riskPercent: input.riskPercent, entry: setup.entry, stop: setup.stop }),
      };
    }

    let verdict;
    if (bias === 'None') verdict = `Higher timeframe (${trends.htf.tf}) is ${htfT.toLowerCase()} — KS-001 needs a clear HTF trend, so no trade.`;
    else if (!setup) verdict = `HTF bias is ${bias.toLowerCase()}, but no ${bias === 'Long' ? 'demand' : 'supply'} zone on ${input.ltf.tf} scores ${o.minScore}/10 with at least 1:${o.minRR} risk/reward. No trade.`;
    else verdict = `${plan.direction} setup from a ${setup.pattern} ${setup.side} zone scoring ${setup.score.total}/10${aligned ? ', with HTF and ITF aligned' : `, but ITF (${trends.itf.tf}) is ${itfT.toLowerCase()} — lower conviction`}.`;

    return {
      trends, bias, aligned, zones, minRR: o.minRR,
      nearestDemand: nearestDemand.slice(0, 3), nearestSupply: nearestSupply.slice(0, 3),
      plan, verdict, minScore: o.minScore,
    };
  }

  // ---------- Live order-book pressure ----------
  // samples: [{ bidQty, askQty, ltp }] oldest first (top of book only).
  function pressure(samples) {
    const valid = (samples || []).filter(s => s && s.bidQty > 0 && s.askQty > 0);
    if (!valid.length) return null;
    const recent = valid.slice(-12);
    const bidShare = recent.reduce((a, s) => a + s.bidQty / (s.bidQty + s.askQty), 0) / recent.length;
    let upTicks = 0, downTicks = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].ltp > recent[i - 1].ltp) upTicks++;
      else if (recent[i].ltp < recent[i - 1].ltp) downTicks++;
    }
    let side = 'Balanced';
    if (bidShare >= 0.6) side = 'Buyers stronger';
    else if (bidShare <= 0.4) side = 'Sellers stronger';
    return { bidShare, upTicks, downTicks, samples: recent.length, side, score: bidShare >= 0.6 ? 1 : bidShare <= 0.4 ? -1 : 0 };
  }

  // ---------- Price outlook: probable range + which way it leans ----------
  // Uses the zones as floor/ceiling, the 20 EMA trends for direction, and
  // (when available) live top-of-book pressure. It is a reading of the
  // current structure, not a prediction.
  function outlook({ ks, price, support, resistance, pressure: pr }) {
    const dem = ks.nearestDemand || [], sup = ks.nearestSupply || [];
    const floorZone = dem[0] || null, ceilZone = sup[0] || null;
    const floor = floorZone
      ? { price: floorZone.proximal, distal: floorZone.distal, source: `${floorZone.pattern} demand zone (${floorZone.score.total}/10)`, zone: floorZone }
      : (support && support[0] != null ? { price: support[0], distal: null, source: 'swing low (no demand zone below)' } : null);
    const ceiling = ceilZone
      ? { price: ceilZone.proximal, distal: ceilZone.distal, source: `${ceilZone.pattern} supply zone (${ceilZone.score.total}/10)`, zone: ceilZone }
      : (resistance && resistance[0] != null ? { price: resistance[0], distal: null, source: 'swing high (no supply zone above)' } : null);
    const nextBelow = dem[1] ? { price: dem[1].proximal, source: `${dem[1].pattern} demand zone` } : null;
    const nextAbove = sup[1] ? { price: sup[1].proximal, source: `${sup[1].pattern} supply zone` } : null;
    const inDemand = !!(floorZone && price <= floorZone.proximal && price >= floorZone.distal);
    const inSupply = !!(ceilZone && price >= ceilZone.proximal && price <= ceilZone.distal);

    const factors = [];
    const add = (label, score) => factors.push({ label, score });
    const tScore = t => (t === 'Bullish' ? 1 : t === 'Bearish' ? -1 : 0);
    add(`Higher timeframe (${ks.trends.htf.tf}) ${ks.trends.htf.trend.toLowerCase()}`, 2 * tScore(ks.trends.htf.trend));
    add(`Middle timeframe (${ks.trends.itf.tf}) ${ks.trends.itf.trend.toLowerCase()}`, tScore(ks.trends.itf.trend));
    add(`Chart timeframe (${ks.trends.ltf.tf}) ${ks.trends.ltf.trend.toLowerCase()}`, tScore(ks.trends.ltf.trend));
    if (inDemand) add('Price is inside a demand zone (buyers expected)', 1);
    if (inSupply) add('Price is inside a supply zone (sellers expected)', -1);
    if (pr) add(`Live order book: ${pr.side.toLowerCase()} (${Math.round(pr.bidShare * 100)}% of top-of-book quantity on the bid)`, pr.score);
    const score = factors.reduce((a, f) => a + f.score, 0);
    const lean = score >= 2 ? 'Up' : score <= -2 ? 'Down' : 'Sideways';

    const room = (a, b) => (a != null && b != null ? Math.abs(a - b) / price * 100 : null);
    return {
      price, floor, ceiling, nextBelow, nextAbove, inDemand, inSupply,
      upsidePct: ceiling ? room(ceiling.price, price) : null,
      downsidePct: floor ? room(price, floor.price) : null,
      factors, score, lean,
      firstTarget: lean === 'Up' ? ceiling : lean === 'Down' ? floor : null,
    };
  }

  const KS001 = { DEFAULTS, TF_LADDER, trend, detectZones, scoreZone, positionSize, analyze, ema, pressure, outlook };
  root.KS001 = KS001;
})(typeof window !== 'undefined' ? window : globalThis);

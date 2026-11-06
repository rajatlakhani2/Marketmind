// ============================================================
// MarketMind AI — all-strategy analysis
// Runs every strategy on one stock, works out each strategy's own
// buy (or short) level, stop-loss and selling/target level, then
// combines them into one conclusion.
//   Consensus.run({ md, ks, strategies, check, account, riskPercent })
// md = daily market data (MarketData), ks = KS001.analyze result,
// check(cond, md) -> { met, detail } | null  (Conditions.check)
//   learned (optional) = MindGuru brain: { [strategyId]: { buckets: { all, 'trend:Bullish', ... } } }
//   Each strategy's vote is weighted by how its past projections actually turned out.
// ============================================================
(function (root) {
  'use strict';

  // ---------- helpers ----------
  function atr(c, n = 14) {
    if (c.length < n + 1) return null;
    let s = 0;
    for (let i = c.length - n; i < c.length; i++) {
      const p = c[i - 1].close;
      s += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - p), Math.abs(c[i].low - p));
    }
    return s / n;
  }
  const sma = (c, n) => (c.length < n ? null : c.slice(-n).reduce((a, x) => a + x.close, 0) / n);
  const lowestLow = (c, n) => Math.min(...c.slice(-n).map(x => x.low));
  const highestHigh = (c, n) => Math.max(...c.slice(-n).map(x => x.high));
  const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

  // Target for a long: nearest resistance above entry if it gives at least 1.5R, else entry + 2R
  function longTarget(entry, stop, md, fallbackR = 2) {
    const R = entry - stop;
    const res = (md.resistance || []).find(v => v > entry);
    if (res != null && res - entry >= 1.5 * R) return { target: res, why: 'nearest resistance' };
    return { target: entry + fallbackR * R, why: `${fallbackR}× risk` };
  }

  // A long plan is only usable when stop < entry < target.
  function longPlan(entry, stop, target, why, extra) {
    if (![entry, stop, target].every(v => v != null && isFinite(v)) || !(stop < entry && entry < target)) return null;
    return { side: 'long', entry: r2(entry), stop: r2(stop), target: r2(target), targetWhy: why, rr: (target - entry) / (entry - stop), ...extra };
  }
  function shortPlan(entry, stop, target, why, extra) {
    if (![entry, stop, target].every(v => v != null && isFinite(v)) || !(target < entry && entry < stop)) return null;
    return { side: 'short', entry: r2(entry), stop: r2(stop), target: r2(target), targetWhy: why, rr: (entry - target) / (stop - entry), ...extra };
  }

  // ---------- each built-in strategy's own levels ----------
  // Every builder returns a plan (or null when the strategy has no sensible level right now).
  const LEVELS = {
    lib_s_ks_demand: ({ ks }) => {
      const z = (ks.nearestDemand || []).find(x => x.qualifies);
      if (!z) return null;
      const t = z.target != null ? z.target : z.entry + 3 * z.risk;
      return longPlan(z.entry, z.stop, t, z.targetSource || '3× risk', { how: `Limit buy at the ${z.pattern} demand zone (proximal line)`, ksScore: z.score && z.score.total });
    },
    lib_s_ks_supply: ({ ks }) => {
      const z = (ks.nearestSupply || []).find(x => x.qualifies);
      if (!z) return null;
      const t = z.target != null ? z.target : z.entry - 3 * z.risk;
      return shortPlan(z.entry, z.stop, t, z.targetSource || '3× risk', { how: `Limit sell at the ${z.pattern} supply zone (proximal line)`, ksScore: z.score && z.score.total });
    },
    lib_s_rsi2: ({ md, c, a }) => {
      const entry = md.price;
      const swing = lowestLow(c, 10);
      const stop = swing < entry ? Math.min(swing, entry - a) : entry - 2 * a;
      const s5 = sma(c, 5);
      const target = s5 != null && s5 > entry ? s5 : entry + 1.5 * (entry - stop);
      return longPlan(entry, stop, target, s5 > entry ? '5-day SMA (strategy exit)' : '1.5× risk', { how: 'Buy near the close; sell when price closes above the 5-day SMA' });
    },
    lib_s_moving_momentum: ({ md, c, a }) => {
      const entry = md.price, stop = Math.min(lowestLow(c, 10), entry - a);
      const t = longTarget(entry, stop, md);
      return longPlan(entry, stop, t.target, t.why, { how: 'Buy when the MACD histogram turns positive after the pullback' });
    },
    lib_s_golden_cross: ({ md, c, a }) => {
      const s50 = sma(c, 50);
      if (s50 == null) return null;
      const entry = md.price > s50 ? Math.max(s50, md.price - a) : md.price; // buy the pullback toward the 50-day
      const stop = s50 - a;
      const t = longTarget(entry, stop, md);
      return longPlan(entry, stop, t.target, t.why, { how: 'Buy on a pullback toward the 50-day SMA; exit on a close below it' });
    },
    lib_s_ma50_pullback: ({ md, c, a }) => {
      const s50 = sma(c, 50);
      if (s50 == null) return null;
      const last = c[c.length - 1];
      const entry = Math.max(last.high, md.price);
      const stop = s50 - 0.5 * a;
      const t = longTarget(entry, stop, md);
      return longPlan(entry, stop, t.target, t.why, { how: 'Buy above the high of the bounce candle' });
    },
    lib_s_bb_squeeze: ({ md, c, a }) => {
      const C = root.Conditions;
      const bb = C ? C.bollinger(c) : null;
      if (!bb) return null;
      const entry = Math.max(md.price, bb.upper);
      const stop = Math.min(bb.mid, entry - a);
      const height = highestHigh(c, 20) - lowestLow(c, 20);
      const target = Math.max(entry + height, entry + 2 * (entry - stop));
      return longPlan(entry, stop, target, 'measured move (height of the squeeze range)', { how: 'Buy the close above the upper band' });
    },
    lib_s_nr7: ({ md, c }) => {
      const p = c[c.length - 2];
      if (!p) return null;
      const entry = Math.max(p.high, md.price), stop = p.low;
      const t = longTarget(entry, stop, md);
      return longPlan(entry, stop, t.target, t.why, { how: "Buy above the NR7 day's high" });
    },
    lib_s_engulfing_support: ({ md, c }) => {
      const l = c[c.length - 1], p = c[c.length - 2];
      const entry = md.price, stop = Math.min(l.low, p.low);
      const res = (md.resistance || []).find(v => v > entry);
      const target = res != null ? res : entry + 2 * (entry - stop);
      return longPlan(entry, stop, target, res != null ? 'nearest resistance' : '2× risk', { how: 'Buy at the close of the engulfing candle' });
    },
    lib_s_rsi_bull_range: ({ md, c, a }) => {
      const entry = md.price, stop = Math.min(lowestLow(c, 10), entry - a);
      const prior = highestHigh(c, 60);
      const target = prior > entry ? prior : entry + 2 * (entry - stop);
      return longPlan(entry, stop, target, prior > entry ? 'prior high' : '2× risk', { how: 'Buy as RSI turns up from the 40–50 band' });
    },
    // ---- added strategies ----
    lib_s_sd_flip: ({ md, c, a }) => {
      const b = root.Conditions && root.Conditions.breakoutLevel(c);
      if (!b) return null;
      const entry = md.price, stop = b.level - 0.5 * a;
      const t = longTarget(entry, stop, md);
      return longPlan(entry, stop, t.target, t.why, { how: `Buy the retest of the old range high ₹${r2(b.level)} (now support)` });
    },
    lib_s_zone_candle_long: ({ md, ks, c }) => {
      const z = (ks.nearestDemand || [])[0];
      const l = c[c.length - 1];
      if (!z || !l) return null;
      const entry = Math.max(l.high, md.price), stop = Math.min(z.stop != null ? z.stop : z.distal, l.low);
      const sup = (ks.nearestSupply || [])[0];
      const target = sup && sup.proximal > entry + 2 * (entry - stop) ? sup.proximal : entry + 2 * (entry - stop);
      return longPlan(entry, stop, target, sup && target === sup.proximal ? 'nearest supply zone' : '2× risk', { how: `Buy above the reversal candle's high inside the ${z.pattern} demand zone`, ksScore: z.score && z.score.total });
    },
    lib_s_zone_candle_short: ({ md, ks, c }) => {
      const z = (ks.nearestSupply || [])[0];
      const l = c[c.length - 1];
      if (!z || !l) return null;
      const entry = Math.min(l.low, md.price), stop = Math.max(z.stop != null ? z.stop : z.distal, l.high);
      const dem = (ks.nearestDemand || [])[0];
      const target = dem && dem.proximal < entry - 2 * (stop - entry) ? dem.proximal : entry - 2 * (stop - entry);
      return shortPlan(entry, stop, target, dem && target === dem.proximal ? 'nearest demand zone' : '2× risk', { how: `Sell below the rejection candle's low inside the ${z.pattern} supply zone`, ksScore: z.score && z.score.total });
    },
    lib_s_morning_star_demand: ({ md, c }) => {
      const t = c.slice(-3);
      if (t.length < 3) return null;
      const entry = md.price, stop = Math.min(...t.map(x => x.low));
      const lt = longTarget(entry, stop, md);
      return longPlan(entry, stop, lt.target, lt.why, { how: 'Buy at the close of the morning star; stop under the pattern' });
    },
    lib_s_donchian20: ({ md, c, a }) => {
      const entry = md.price, stop = Math.max(lowestLow(c, 10), entry - 2 * a);
      const t = longTarget(entry, stop, md);
      return longPlan(entry, stop, t.target, t.why, { how: 'Buy the close above the 20-day high; trail with the 10-day low' });
    },
    lib_s_high52: ({ md, c, a }) => {
      const entry = md.price, stop = Math.max(lowestLow(c, 10), entry - 2 * a);
      return longPlan(entry, Math.min(stop, entry - a), entry + 2 * (entry - Math.min(stop, entry - a)), '2× risk', { how: 'Buy strength near the 52-week high; trail with the 50-day SMA' });
    },
    lib_s_inside_bar: ({ md, c }) => {
      const ib = c[c.length - 2];
      if (!ib) return null;
      const entry = Math.max(ib.high, md.price), stop = ib.low;
      const t = longTarget(entry, stop, md);
      return longPlan(entry, stop, t.target, t.why, { how: "Buy above the inside bar's high; stop below its low" });
    },
    lib_s_supertrend_flip: ({ md, c, a }) => {
      const st = root.Conditions && root.Conditions.supertrendSeries(c);
      const line = st && st.line[st.line.length - 1];
      if (line == null) return null;
      const entry = md.price, stop = Math.min(line, entry - 0.5 * a);
      const t = longTarget(entry, stop, md);
      return longPlan(entry, stop, t.target, t.why, { how: 'Buy the Supertrend flip; the Supertrend line is the stop' });
    },
    lib_s_adx_ema_pullback: ({ md, c, a }) => {
      const e = md.ema20;
      if (e == null) return null;
      const entry = Math.min(md.price, e * 1.005), stop = e - a;
      const prior = highestHigh(c, 40);
      const target = prior > entry + 1.5 * (entry - stop) ? prior : entry + 2 * (entry - stop);
      return longPlan(entry, stop, target, prior === target ? 'prior high' : '2× risk', { how: 'Buy the dip to the 20-day EMA in a strong trend' });
    },
    lib_s_macd_cross_below_zero: ({ md, c, a }) => {
      const entry = md.price, stop = Math.min(lowestLow(c, 10), entry - a);
      const t = longTarget(entry, stop, md);
      return longPlan(entry, stop, t.target, t.why, { how: 'Buy the MACD crossover while MACD is still below zero' });
    },
    lib_s_rsi_divergence: ({ md, c, a }) => {
      const C = root.Conditions;
      const lows = C ? C.swings(c, 'low', c.length - 30) : [];
      const sw = lows.length ? c[lows[lows.length - 1]].low : lowestLow(c, 10);
      const entry = md.price, stop = Math.min(sw - 0.25 * a, entry - 0.5 * a);
      const res = (md.resistance || []).find(v => v > entry);
      const target = res != null && res - entry >= 1.2 * (entry - stop) ? res : entry + 2 * (entry - stop);
      return longPlan(entry, stop, target, res === target ? 'nearest resistance' : '2× risk', { how: 'Buy the confirmation close after the bullish divergence' });
    },
    lib_s_bb_lower_bounce: ({ md, c, a }) => {
      const bb = root.Conditions ? root.Conditions.bollinger(c) : null;
      if (!bb) return null;
      const entry = md.price, stop = Math.min(lowestLow(c, 5) - 0.5 * a, entry - 0.5 * a);
      const target = bb.mid > entry + (entry - stop) ? bb.mid : bb.upper;
      return longPlan(entry, stop, target, target === bb.mid ? 'middle Bollinger Band' : 'upper Bollinger Band', { how: 'Buy the turn up from the lower band; take profit at the middle band' });
    },
    lib_s_three_soldiers: ({ md, c, a }) => {
      const first = c[c.length - 3];
      if (!first) return null;
      const entry = md.price, stop = Math.max((first.open + first.close) / 2, entry - 2 * a);
      const t = longTarget(entry, Math.min(stop, entry - 0.5 * a), md);
      return longPlan(entry, Math.min(stop, entry - 0.5 * a), t.target, t.why, { how: 'Buy after three strong green candles; stop under the first one' });
    },
    lib_s_breakdown20: ({ md, c, a }) => {
      const entry = md.price, stop = Math.min(highestHigh(c, 10), entry + 2 * a);
      const st = Math.max(stop, entry + 0.5 * a);
      return shortPlan(entry, st, entry - 2 * (st - entry), '2× risk', { how: 'Sell the close below the 20-day low; trail with the 10-day high' });
    },
  };
  const SIDE = { lib_s_ks_supply: 'short', lib_s_zone_candle_short: 'short', lib_s_breakdown20: 'short' };

  // ---------- MindGuru: what each strategy's track record says ----------
  // Uses the record for today's higher-timeframe trend when it has 8+ results, else the overall record.
  function learnedFor(learned, id, trend, ksScore, symbol) {
    const s = learned && learned[id];
    const b = s && s.buckets;
    if (!b || !b.all || !b.all.trades) return null;
    let pick = b.all, scope = 'all market conditions';
    // This stock's own record wins once there are enough judged calls on it
    const sb = symbol && b[('sym:' + String(symbol).toUpperCase()).slice(0, 20)];
    if (sb && sb.trades >= 8) return { ...sb, scope: `${String(symbol).toUpperCase()} itself` };
    const kb = ksScore == null ? null : ksScore >= 9 ? 'ks:9-10' : ksScore >= 8 ? 'ks:8' : ksScore >= 7 ? 'ks:7' : 'ks:<7';
    if (kb && b[kb] && b[kb].trades >= 8) { pick = b[kb]; scope = `zones scoring ${kb.slice(3)}`; }
    else if (trend && b['trend:' + trend] && b['trend:' + trend].trades >= 8) { pick = b['trend:' + trend]; scope = `${trend.toLowerCase()} trend`; }
    return { ...pick, scope };
  }
  // Win rate pulled toward 45% until there are enough results to trust it
  const shrunkWinRate = (l) => (l.wins + 0.45 * 10) / (l.trades + 10);

  // ---------- run ----------
  function run({ md, ks, strategies, check, account, riskPercent, learned }) {
    const c = md.priceHistory || [];
    const a = atr(c) || md.price * 0.02;
    const results = (strategies || []).map(s => {
      const conds = (s.conditions || []).map(cond => {
        const r = check(cond, md);
        return { condition: cond, met: !!(r && r.met), unknown: !r, detail: r ? r.detail : 'check manually' };
      });
      const checkable = conds.filter(x => !x.unknown);
      const met = checkable.filter(x => x.met).length;
      const ratio = checkable.length ? met / checkable.length : 0;
      const status = checkable.length && met === checkable.length ? 'Active' : ratio >= 0.5 ? 'Setting up' : 'No signal';
      const builder = LEVELS[s.id];
      let plan = null;
      try { plan = builder ? builder({ md, ks, c, a }) : null; } catch (e) { plan = null; }
      const trend = ks && ks.trends && ks.trends.htf ? ks.trends.htf.trend : null;
      const lr = learnedFor(learned, s.id, trend, plan ? plan.ksScore : null, md.symbol);
      return {
        id: s.id, name: s.name, isBuiltIn: !!s.isBuiltIn, side: plan ? plan.side : (SIDE[s.id] || 'long'),
        status, met, total: checkable.length, unchecked: conds.length - checkable.length, conditions: conds, plan,
        learned: lr, weight: lr ? lr.weight : 1,
      };
    });
    const conclusion = conclude({ md, ks, results, a, account, riskPercent });
    conclusion.mindguru = mindguruView(conclusion, results, learned);
    return { results, conclusion };
  }

  // Confidence for the verdict, from the track record of the strategies behind it.
  function mindguruView(c, results, learned) {
    if (!learned) return null;
    const names = new Set(c.supporting || []);
    const behind = results.filter(r => names.has(r.name) && r.learned);
    const notes = results.filter(r => r.status === 'Active' && r.learned && r.learned.trades >= 10 && r.weight <= 0.7)
      .map(r => `${r.name} has a weak record (${Math.round(r.learned.winRate * 100)}% winners, ${r.learned.avgR >= 0 ? '+' : ''}${r.learned.avgR.toFixed(2)}R over ${r.learned.trades} trades in ${r.learned.scope}), so its vote counts less.`);
    if (!behind.length) return { confidence: null, trades: 0, notes };
    const trades = behind.reduce((x, r) => x + r.learned.trades, 0);
    const confidence = behind.reduce((x, r) => x + shrunkWinRate(r.learned) * r.learned.trades, 0) / trades;
    const avgR = behind.reduce((x, r) => x + r.learned.avgR * r.learned.trades, 0) / trades;
    return { confidence, avgR, trades, notes };
  }

  function conclude({ md, ks, results, a, account, riskPercent }) {
    const price = md.price;
    const withPlan = results.filter(r => r.plan);
    const activeLong = withPlan.filter(r => r.status === 'Active' && r.plan.side === 'long');
    const activeShort = withPlan.filter(r => r.status === 'Active' && r.plan.side === 'short');
    const settingUp = results.filter(r => r.status === 'Setting up');
    const strategyCount = results.length;
    const size = (entry, stop) => (root.KS001 && account > 0 && riskPercent > 0 ? root.KS001.positionSize({ account, riskPercent, entry, stop }) : null);
    const bias = ks && ks.bias;
    // Votes weighted by MindGuru (1 each when nothing has been learned yet)
    const wLong = activeLong.reduce((x, r) => x + (r.weight || 1), 0);
    const wShort = activeShort.reduce((x, r) => x + (r.weight || 1), 0);
    const distrusted = activeLong.length && wLong < 0.6;

    const pickLong = (list) => {
      const entries = list.map(r => r.plan.entry);
      const buyLow = Math.min(...entries), buyHigh = Math.max(...entries);
      const stop = Math.min(...list.map(r => r.plan.stop));                 // below every setup's own stop
      const targets = list.map(r => r.plan.target).filter(t => t > buyHigh).sort((x, y) => x - y);
      const sell1 = targets.length ? targets[0] : buyHigh + 2 * (buyHigh - stop);
      const sell2 = targets.length > 1 ? targets[targets.length - 1] : null;
      const mid = (buyLow + buyHigh) / 2;
      return { buyLow: r2(buyLow), buyHigh: r2(buyHigh), stop: r2(stop), sell1: r2(sell1), sell2: r2(sell2), rr: (sell1 - mid) / (mid - stop), sizing: size(mid, stop) };
    };

    // 1) Long signals active and not outweighed by shorts
    if (activeLong.length && wLong >= wShort && bias !== 'Short' && !distrusted) {
      const L = pickLong(activeLong);
      const nowInZone = price >= L.buyLow * 0.995 && price <= L.buyHigh * 1.005;
      return {
        verdict: nowInZone ? 'Buy' : 'Buy on dip', tone: 'long', ...L,
        agree: activeLong.length, of: strategyCount,
        supporting: activeLong.map(r => r.name), against: activeShort.map(r => r.name),
        summary: `${activeLong.length} of ${strategyCount} strategies give a buy signal now. ` +
          (nowInZone ? `Price ₹${price.toFixed(2)} is inside the buy zone.` : (L.buyLow === L.buyHigh ? `Best entry is ₹${L.buyLow.toFixed(2)}` : `Best entries are ₹${L.buyLow.toFixed(2)}–${L.buyHigh.toFixed(2)}`) + `; current price is ₹${price.toFixed(2)}, so wait for a dip.`) +
          ` First selling level ₹${L.sell1.toFixed(2)}${L.sell2 ? `, second ₹${L.sell2.toFixed(2)}` : ''}. Exit if price closes below ₹${L.stop.toFixed(2)}.`,
      };
    }

    // 2) Short/sell signals dominate
    if (activeShort.length && (wShort > wLong || bias === 'Short')) {
      const p = activeShort[0].plan;
      return {
        verdict: 'Sell / avoid buying', tone: 'short', sellAt: p.entry, stop: p.stop, coverAt: p.target, rr: p.rr,
        agree: activeShort.length, of: strategyCount, supporting: activeShort.map(r => r.name), against: activeLong.map(r => r.name),
        summary: `${activeShort.length} of ${strategyCount} strategies point down and the higher-timeframe trend is ${ks ? ks.trends.htf.trend.toLowerCase() : 'unclear'}. ` +
          `Selling level ₹${p.entry.toFixed(2)} (supply zone); it is invalid above ₹${p.stop.toFixed(2)}; downside target ₹${p.target.toFixed(2)}. Holders may consider selling near the supply zone.`,
      };
    }

    // 3) Nothing active: give the levels to watch
    const demand = ks && (ks.nearestDemand || []).find(z => z.qualifies) || (ks && (ks.nearestDemand || [])[0]);
    const supply = ks && (ks.nearestSupply || [])[0];
    const support = (md.support || [])[0], resistance = (md.resistance || [])[0];
    const buyLevel = demand ? demand.proximal : support != null ? support : null;
    const stop = demand ? demand.stop : (support != null ? support - a : null);
    const sellLevel = supply ? supply.proximal : resistance != null ? resistance : null;
    const rr = buyLevel != null && stop != null && sellLevel != null && buyLevel > stop ? (sellLevel - buyLevel) / (buyLevel - stop) : null;
    return {
      verdict: 'Wait', tone: 'neutral',
      buyLow: r2(buyLevel), buyHigh: r2(buyLevel), stop: r2(stop), sell1: r2(sellLevel), sell2: null, rr,
      buySource: demand ? `${demand.pattern} demand zone (${demand.score.total}/10)` : 'nearest support',
      sellSource: supply ? `${supply.pattern} supply zone` : 'nearest resistance',
      sizing: buyLevel != null && stop != null && buyLevel > stop ? size(buyLevel, stop) : null,
      agree: 0, of: strategyCount, supporting: [], against: [], settingUp: settingUp.map(r => r.name),
      summary: (distrusted && bias !== 'Short'
          ? `${activeLong.map(r => r.name).join(', ')} ${activeLong.length > 1 ? 'give' : 'gives'} a buy signal, but MindGuru has seen ${activeLong.length > 1 ? 'these strategies' : 'this strategy'} lose more than win, so it is not treated as a buy. `
          : '') + (activeLong.length && bias === 'Short'
          ? `${activeLong.length} buy signal${activeLong.length > 1 ? 's' : ''} (${activeLong.map(r => r.name).join(', ')}) but the higher-timeframe trend is bearish, so ${activeLong.length > 1 ? 'they are' : 'it is'} counter-trend. `
          : bias === 'Short' ? 'The higher-timeframe trend is bearish, so buying here is against the trend. ' : '') +
        `No strategy has a complete with-trend signal right now${settingUp.length ? ` (${settingUp.length} setting up: ${settingUp.slice(0, 3).map(r => r.name).join(', ')}${settingUp.length > 3 ? '…' : ''})` : ''}. ` +
        (buyLevel != null ? `Levels to watch: buy near ₹${buyLevel.toFixed(2)} (${demand ? 'demand zone' : 'support'})` : 'No clear buying level below') +
        (sellLevel != null ? `, sell near ₹${sellLevel.toFixed(2)} (${supply ? 'supply zone' : 'resistance'})` : '') + '.',
    };
  }

  root.Consensus = { run, atr, LEVELS, learnedFor };
})(typeof window !== 'undefined' ? window : globalThis);

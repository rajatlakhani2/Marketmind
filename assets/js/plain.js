// MarketMind AI — strategy names in plain words.
// Every strategy keeps its technical name (Library, MindGuru records), but the app shows this plain name first,
// with a one-line meaning. Plain.name(id, fallback) / Plain.what(id) / Plain.label(id, fallback) (name + tooltip).
(function (root) {
  'use strict';

  const P = {
    lib_s_golden_cross: ['New long-term uptrend', 'The 50-day average has just crossed above the 200-day: a long-term uptrend is starting.'],
    lib_s_supertrend_flip: ['Trend turned up', 'The Supertrend line has flipped to "up" and trend strength confirms it.'],
    lib_s_adx_ema_pullback: ['Dip in a strong trend', 'A strong uptrend has dipped back to its 20-day average: buying the dip.'],
    lib_s_macd_cross_below_zero: ['Early turn after a fall', 'Momentum (MACD) is turning up while still below zero: a fall may be ending.'],
    lib_s_high52: ['Near 52-week high', 'A strong stock trading close to its 1-year high, with long-term averages rising.'],
    lib_s_rsi_divergence: ['Selling is weakening', 'Price made a lower low but momentum (RSI) did not, at a support level.'],
    lib_s_morning_star_demand: ['Reversal candles at a buy zone', 'A three-candle turn-up pattern (morning star) inside a demand zone.'],
    lib_s_bb_squeeze: ['Breakout after a quiet spell', 'Price was unusually calm, then broke out above its normal range on volume.'],
    lib_s_moving_momentum: ['Uptrend dip, momentum returning', 'Long-term trend is up and short-term momentum is turning back up after a dip.'],
    lib_s_ks_demand: ['Back at a buy zone', 'Price has returned to a zone where big buyers stepped in before (demand zone).'],
    lib_s_ks_supply: ['Back at a sell zone (short)', 'Price has risen into a zone where big sellers acted before (supply zone), in a downtrend.'],
    lib_s_rsi2: ['Short-term oversold dip', 'In a long-term uptrend, price has dropped sharply for 1–3 days (2-day RSI very low).'],
    lib_s_ma50_pullback: ['Dip to the 50-day average', 'An uptrend has pulled back to its rising 50-day average and a bullish candle formed.'],
    lib_s_nr7: ['Breakout after a tight day', 'The narrowest day in 7 days, then price breaks out of it.'],
    lib_s_engulfing_support: ['Bullish candle at support', 'A big green candle swallowed the previous red one, right at a support level.'],
    lib_s_rsi_bull_range: ['Momentum dip in an uptrend', 'In an uptrend, momentum (RSI) dipped to 40–50 and is turning up.'],
    lib_s_sd_flip: ['Breakout retest', 'Price broke above an old ceiling and has come back to test it as a floor.'],
    lib_s_zone_candle_long: ['Buy zone + reversal candle', 'Price is in a demand zone and a hammer or bullish engulfing candle confirms buyers.'],
    lib_s_zone_candle_short: ['Sell zone + rejection candle (short)', 'Price is in a supply zone and a shooting star or bearish engulfing confirms sellers.'],
    lib_s_donchian20: ['20-day high breakout', 'Price closed above its highest level of the last 20 days, in a long-term uptrend.'],
    lib_s_inside_bar: ['Breakout after a pause candle', 'A small candle sat inside the previous one; price then broke above it.'],
    lib_s_bb_lower_bounce: ['Bounce from the low band', 'In an uptrend, price touched the lower Bollinger Band and is turning back up.'],
    lib_s_three_soldiers: ['Three strong green days', 'Three strong green candles pushed price back above its 50-day average with volume.'],
    lib_s_breakdown20: ['20-day low breakdown (short)', 'Price closed below its lowest level of the last 20 days, in a long-term downtrend.'],
    __verdict: ['All strategies combined', 'The overall verdict when the strategies vote together.'],
    __ks_bounce: ['Buy zone + bounce', 'Price touched a demand zone and the next candle bounced.'],
    __combo: ['Best-trend system (half at +1R)', 'New long-term uptrend, trend turned up or dip in a strong trend, with filters; books half at +1R.'],
    __combo_np: ['Best-trend system', 'New long-term uptrend, trend turned up or dip in a strong trend, with filters; exits at +2R.'],
    __watch_pos: ['Watchlist call', 'The daily BUY / SELL call on your Watchlist.'],
  };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const name = (id, fallback) => (P[id] ? P[id][0] : fallback || id);
  const what = id => (P[id] ? P[id][1] : '');
  // HTML: plain name with the meaning and technical name as a tooltip
  const label = (id, fallback) => `<span class="pl-name" title="${esc(what(id))}${fallback && P[id] ? ' · ' + esc(fallback) : ''}">${esc(name(id, fallback))}</span>`;
  // Plain name from a technical one (for saved records that only kept the name)
  const byTech = {};
  function fromTech(tech) {
    if (!Object.keys(byTech).length && root.app && root.app.engine) for (const s of root.app.engine.strategies || []) byTech[s.name] = s.id;
    const id = byTech[tech];
    return id ? name(id, tech) : tech;
  }

  root.Plain = { name, what, label, fromTech, MAP: P };
})(typeof window !== 'undefined' ? window : globalThis);

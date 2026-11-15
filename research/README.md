# Strategy research (offline back-tests)

1. Actions → **Research data** → Run: downloads 10 years of daily Yahoo prices (99 stocks, NIFTY, sector indices) to the `research-data` branch.
2. `git clone -b research-data --depth 1 https://github.com/rajatlakhani2/marketmind data`
3. `node research/signals.mjs data /tmp/signals.json` — replays the app's own Golden Cross and Supertrend Flip checks (assets/js) on every 2nd bar.
4. `node research/backtest.mjs data /tmp/signals.json` — grid of market/stock/sector filters × exit rules.
   `... "<filter>|<exit>"` for one variant by financial year; `... "port:5:<filter>|<exit>"` with at most 5 trades open.

Train = signals before 1 Apr 2025; test = FY 2025-26 and FY 2026-27 (not used to choose rules).

## Results, 13 Nov 2026 (Combined Proven system, 0.25% costs, R per trade)

| Variant | Train FY17-25 | FY 25-26 | FY 26-27 |
|---|---|---|---|
| Current (NIFTY & stock > 200-DMA, half at 1R, rest 3R / 30 days) | +0.05 | −0.01 | +0.05 (17 trades) |
| + market trend (NIFTY 50 > 200-DMA, 200-DMA rising) | +0.03 | +0.03 | no trades |
| + strong stock (beats NIFTY over 6 months) | +0.01 | −0.06 | +0.07 |
| + strong sector (sector above 50-DMA, beats NIFTY over 3 months) | +0.08 | −0.10 | −0.09 |
| Trailing stop 4×ATR after +1R, max 90 days | +0.28 | −0.09 | +0.03 |

No filter improved both the training years and the test years. The trailing exit raises the long-run average,
but almost all of it comes from 2020-21 and 2023-24; 6 of 10 financial years lose money.

With at most 5 trades open (closer to ₹1L capital): current rules −13R over 9.5 years, deepest drop 34R;
trailing exit +55R, deepest drop 32R, positive in 3 of 10 years. Both are far from the paper-trading bar
(deepest drop no more than 6R).

## New entries, 15 Nov 2026 (`node research/strategies.mjs data [c]`)

Raw daily bars, 99 stocks, NIFTY above its 200-day; stop 2×ATR; R per trade after 0.25% costs.

| Entry (best exit) | Train FY17-25 | FY 25-26 | FY 26-27 | 5 open: total R, deepest drop, positive years |
|---|---|---|---|---|
| A 52-week-high breakout on volume (trail 3×ATR) | +0.12 | −0.16 | +0.00 | +38R, 43R, 6/10 |
| B Tight range breakout (trail 10-day low) | +0.13 | −0.15 | +0.18 | +7R, 21R, 5/10 |
| **C Trend template + 20-day high (trail 10-day low)** | **+0.13** | −0.18 | +0.06 | **+54R, 24R, 7/10** |
| D Pullback in uptrend, RSI-2 < 10 (exit above 5-day avg) | −0.01 | +0.01 | +0.07 | −57R, 58R, 2/10 |
| E Monthly top-5 momentum rotation | 12.9% a year vs NIFTY 10.1%, deepest fall −25%; behind NIFTY in 6 of 10 years | | | |

C holds +0.10 to +0.14R a trade in the training years across small changes (10/50-day high, 1.5–3 ATR stop, volume filter),
about double the current Combined system (+0.05R). It loses in FY 25-26 in every variant and needs the NIFTY filter
(without it FY 26-27 is −0.26R). Profits again come mostly from trending years (FY 20-21, 23-24). Not proven for live money:
added to the app as a kundli check and a rule template ("Trend template breakout"), to be tracked live.

## Stage 4, 15 Nov 2026 (`node research/stage4.mjs data`): can C be made stronger?

Tested on top of C (same exits, ranked portfolio of 5): breadth (share of the 99 stocks above their 200-day or 50-day),
relative-strength ranking (top 50/30/20% by 6-month return), a pullback to the 20-day average inside a trend-template stock,
and a "health switch" (pause while the last 20-50 closed signals average below zero).

| Variant | Train | FY 25-26 | FY 26-27 | 5 open: total, deepest drop, positive years |
|---|---|---|---|---|
| C baseline | +0.13 | −0.18 | +0.06 | 56R, 24R, 7/10 |
| + breadth200 ≥ 50% | +0.14 | −0.17 | +0.06 | 73R, 18R, 7/10 |
| + breadth200 ≥ 60% | +0.11 | −0.17 | −0.14 | 12R, 34R, 3/10 |
| + RS top 30% | +0.10 | −0.19 | +0.13 | 34R, 22R, 7/10 |
| Pullback to 20-day | +0.17 | −0.14 | −0.52 | 52R, 37R, 5/10 |
| Health switch (last 30, floor 0) | +0.10 | −0.30 | +0.10 | 46R, 17R, 7/10 |

Nothing fixes FY 25-26, and no filter improves steadily as it is tightened (breadth 50% helps, 60% hurts), which is what
noise looks like. Conclusion: keep C unchanged; do not add filters. The gain available is in risk control (fixed risk per
trade, a cap on open positions and per sector), not in prediction.

## Similar-days finder, 15 Nov 2026 (`research/similar.mjs`): tested and not shipped

For the latest NIFTY day, find the 15 most similar past days (5/20/60-day return, distance from the 200-day, 20-day volatility)
and look at the next 20 days. Walk-forward over the last 5 years (62 tests): the similar days pointed the right way
(above or below a normal 20-day move) 36 times of 62 (58%), correlation 0.08. That is not distinguishable from chance,
so it is not shown in the app.

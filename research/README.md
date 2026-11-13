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

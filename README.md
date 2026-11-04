# MarketMind AI

A personal trading knowledge engine for NSE stocks. Upload your trading books and notes, let the app pull out concepts and strategies, and analyse stocks with live market data and the **KS-001 Demand & Supply** method.

Runs entirely in the browser (plain HTML, CSS and JavaScript). A tiny proxy fetches market data, because browsers can't call market-data sites directly.

## Features

- **Live market data** — real OHLC candles for any NSE symbol (Yahoo Finance, via the app's own proxy). If live data can't be loaded the app switches to clearly-marked simulated data and hides all trade plans.
- **KS-001 Demand & Supply engine**
  - Zone detection: RBR / DBR (demand) and RBD / DBD (supply), with proximal and distal lines
  - Freshness tracking — counts how many times price has returned to a zone; zones are removed once a candle closes beyond the distal line
  - Zone score out of 10, minimum 7 **and** at least 1:2 risk/reward to qualify
  - Multi-timeframe trend (HTF → ITF → LTF) using the 20 EMA
  - Counter-trend and low-quality ("garbage") zone flags, with the reason
  - Trade plan: entry, stop-loss, two targets, R:R, invalidation
  - Position sizing from account size and risk % per trade
  - Candlestick chart with zones and plan levels drawn on it
- **Technical indicators** — RSI (14), MACD, 20 EMA, 50 / 200 MA, swing support and resistance
- **Knowledge library** — upload PDFs, text or images; concepts, chart patterns, indicators and strategy rules are extracted and tagged
- **Strategies and screener** — strategies extracted from your documents or built in the strategy builder, checked against live data across 45 large-cap NSE stocks. Conditions the app can't check from price data are marked "check manually" instead of being guessed.

## KS-001 rules used

| Zone | Pattern | Side | Trade with HTF trend |
|------|---------|------|----------------------|
| RBR | Rally – Base – Rally | Demand | Long when HTF is bullish |
| DBR | Drop – Base – Rally | Demand | Long when HTF is bullish |
| RBD | Rally – Base – Drop | Supply | Short when HTF is bearish |
| DBD | Drop – Base – Drop | Supply | Short when HTF is bearish |

- **Base candle:** body ≤ 50% of the candle's range. **Leg candle:** body > 50%. A base is 1–6 candles, and the leg-out must close beyond the base.
- **Demand:** proximal = highest base body, distal = lowest low. **Supply:** proximal = lowest base body, distal = highest high.
- **Score (out of 10):** leg-out strength (3) + base length (2) + freshness (3) + risk/reward (2).
- **Stop-loss:** distal line ± 10% of the zone height.
- **Trend (20 EMA):** bullish = close above a rising 20 EMA; bearish = close below a falling 20 EMA; otherwise sideways (no trade).
- **Timeframes (LTF → ITF → HTF):** 5m/15m → 1h → 1d · 30m → 4h → 1d · 1h/4h → 1d → 1w · 1d → 1w → 1mo
- **Invalidation:** a close beyond the distal line on the ITF/HTF.

The rule settings live in `DEFAULTS` at the top of `assets/js/ks001.js`.

## Getting started

```bash
npm install
npm run dev
```

The app opens at `http://localhost:3000`. During development, Vite answers the market-data requests itself, so live data works without PHP.

## Hosting (cPanel / shared hosting)

```bash
npm run build
```

Upload everything inside `dist/` to a folder on your host (for example `public_html/marketmind/`). The build includes `api/chart.php`, which fetches market data on the server. The host needs PHP 7.4+ with cURL (or `allow_url_fopen`), which standard cPanel hosting has.

If the site is hosted somewhere without PHP, the app still works but shows simulated data.

## Project structure

```
├── index.html            # App shell, styles, knowledge engine, UI
├── assets/               # Copied as-is into the build
│   ├── js/
│   │   ├── marketdata.js # Data fetching, indicators, simulated fallback
│   │   └── ks001.js      # KS-001 zone detection, scoring, trade plan, sizing
│   └── api/
│       └── chart.php     # Market-data proxy for hosting
├── vite.config.js        # Dev server + dev-time data proxy
└── package.json
```

Data you add (documents, concepts, strategies) is stored in your browser (IndexedDB), not on a server.

## Disclaimer

This tool is for education and research only. It is not financial advice. Market data from Yahoo Finance may be delayed. Always do your own research before trading.

## License

MIT

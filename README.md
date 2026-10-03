# Share Market — MarketMind AI

An intelligent stock market analysis platform built with vanilla JavaScript. Integrates the **KS-001 Demand & Supply methodology** with real-time market data from MoneyControl and a local knowledge library powered by PDF documents.

## Features

- **KS-001 Demand & Supply Analysis** — RBR/DBR/DBD/RBD zone detection with proximal/distal lines and freshness scoring
- **Multi-Timeframe Mapping** — HTF → ITF → LTF trend alignment with 20 EMA filter
- **Zone Scoring System** — Leg-out strength, base width, freshness, and risk/reward ratio (minimum 7/10 to qualify)
- **Position Sizing Calculator** — Risk-per-trade and position sizing based on account size
- **Counter-Trend / Garbage Zone Detection** — Identifies low-probability setups to avoid
- **Real Market Data** — Live prices via MoneyControl API (`priceapi.moneycontrol.com`) with simulated fallback
- **Knowledge Library** — Upload PDFs, extract concepts, resolve conflicting interpretations
- **Strategy Matching** — Built-in and user-created trading strategies with condition checking
- **12-Section Analysis Output** — Full trade plan with entry, stop-loss, targets, invalidation, and risks

## Tech Stack

- HTML + CSS + Vanilla JavaScript (no frameworks)
- Vite for dev server and bundling
- PDF.js for PDF text extraction
- MoneyControl API for live market data

## Getting Started

```bash
cd "Share Market"
npm install
npm run dev
```

Then open `http://localhost:5173` in your browser.

## Project Structure

```
Share Market/
├── index.html          # Main app shell
├── package.json
├── vite.config.js
├── src/
│   ├── css/
│   │   └── app.css     # All styles
│   └── js/
│       ├── app.js      # App initialization, dashboard, portfolio
│       ├── analysis.js # KS-001 analysis engine, zone detection, scoring
│       ├── knowledge.js # PDF processing, concept extraction
│       ├── storage.js  # localStorage persistence
│       └── ui.js       # All UI renderers
└── Books/              # Reference PDFs (Module 1–5)
```

## Uploading PDFs to the Knowledge Library

1. Go to **Knowledge Library** in the app
2. Drag & drop or click to upload PDFs
3. Concepts are extracted and tagged by category
4. Relevant concepts are surfaced during stock analysis

## KS-001 Methodology Overview

| Zone Type | Trend Context | Action |
|-----------|--------------|--------|
| RBR | Bearish HTF | Short from proximal |
| DBR | Bearish HTF | Short from proximal |
| DBD | Bullish HTF | Long from proximal |
| RBD | Bullish HTF | Long from proximal |

**Scoring (out of 10):** Leg-out strength + Base quality + Freshness + R/R ratio. Minimum 7/10 required.

**Invalidation:** Price closes beyond distal line on HTF/ITF timeframe.

## Disclaimer

This tool is for educational purposes only. It does not constitute financial advice. Always do your own research before making investment decisions.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License

MIT

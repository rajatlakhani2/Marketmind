# MarketMind AI

A personal trading knowledge engine for NSE stocks. Upload your trading books and notes, let the app pull out concepts and strategies, and analyse stocks with live market data and the **KS-001 Demand & Supply** method.

Runs entirely in the browser (plain HTML, CSS and JavaScript). A tiny proxy fetches market data, because browsers can't call market-data sites directly.

## Features

- **Every NSE and BSE stock** — search-as-you-type over the full list of listed equities (about 2,000+ NSE and 5,000+ BSE). Companies listed on both exchanges show once; BSE-only companies use their 6-digit BSE code (e.g. `543320`). The list comes from ICICI's security master (with NSE's and BSE's own lists as backup) and refreshes itself weekly.
- **MindGuru** — the app's learning layer. Every All-Strategy Verdict on live data is saved as projections (each active strategy's entry, stop and target, plus the combined verdict). Once the trading days pass, MindGuru checks each one against the real price path (target hit, stop hit, time exit, or entry never reached) and measures the result in R. Those results become a **trust weight** per strategy — overall, by higher-timeframe trend, and by KS-001 zone score — and the next verdict weighs each strategy's vote by it. **Train on history** replays all strategies on about a year of past daily candles across 45 large caps, so MindGuru starts with over a thousand results instead of waiting weeks. The MindGuru page shows its lessons, a strategy trust table, projected-vs-actual for your own analyses, and a learning log by generation.
- **Sign-in and users** — MySQL-backed accounts; the admin creates logins for others.
- **Installable app (PWA)** — light theme, works on phones; install it from the browser for a full-screen app with its own icon.
- **Live market data** — real OHLC candles for any NSE symbol. Uses your **ICICI Direct (Breeze API)** login when connected, otherwise Yahoo Finance. If neither can be reached the app switches to clearly-marked simulated data and hides all trade plans.
- **All-Strategy Verdict** — pick a stock and the app runs every strategy on the daily chart. Each strategy shows Buy signal / Setting up / No signal with its own buy, stop-loss and selling levels, and the verdict combines them into one answer: **Buy**, **Buy on dip**, **Wait** (with levels to watch) or **Sell / avoid buying**, with the buying price, selling price, stop-loss, risk/reward and position size.
- **Price Outlook** — the probable range (nearest demand zone below to nearest supply zone above), what happens if either side breaks, which way price leans and why, and — with ICICI connected — a live buyer vs seller meter from the order book that refreshes every 5 seconds during market hours.
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
- **Built-in library** — 29 concepts and 10 ready-to-use strategies (KS-001 zones, RSI(2), Moving Momentum, Golden Cross, 50-DMA pullback, Bollinger squeeze, NR7, engulfing at support, RSI bull-range), written in MarketMind's own words from Zerodha Varsity, StockCharts ChartSchool and other public sources. Each item links to its source.
- **Your own knowledge** — upload PDFs, text or images; concepts, chart patterns, indicators and strategy rules are extracted and tagged
- **Strategies and screener** — library, extracted or custom strategies checked against live data across 45 large-cap NSE stocks, showing the reading behind each ✓/✗. The condition engine understands plain English such as "Price above rising 20 EMA", "RSI(2) below 10", "20-day SMA above 150-day SMA", "Stochastic below 20 in the last 10 days", "MACD histogram turned positive", "Bollinger squeeze", "NR7 on the previous candle", "Bullish engulfing on the last candle", "Volume above 10-day average" and "Qualifying demand zone within 3% below price". Anything it can't check from price data is marked "check manually" instead of being guessed.

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

## Database and sign-in (MySQL)

On the hosted site everyone signs in. The first account is the **admin**, who can add, switch off, reset or delete other users. Each user's account size, risk % and methodology follow them to any device.

**One-time setup**
1. cPanel → **MySQL Databases**: create a database (e.g. `myacct_marketmind`) and a user, then add the user to the database with **All privileges**.
2. Copy `api/marketmind-config.sample.php` to `marketmind-config.php` in the folder **above** `public_html` (next to `breeze-config.php`). Fill in the database name, user and password, and choose a long `setup_key`.
3. Open the app. It creates its tables automatically and shows **Create the admin account**. Enter the `setup_key`, your username and password.
4. Add other people from **Users** in the sidebar. They sign in with the temporary password you give them and must choose their own right away.

**Daily job (optional but recommended)**

The app also learns whenever someone opens it, but a cron job keeps MindGuru current even on days nobody does. cPanel → **Cron Jobs** → once a day after market close (e.g. 4:15 pm IST = 10:45 UTC):

```
php /home/YOURACCOUNT/public_html/marketmind/api/cron.php
```

It judges every projection whose day has passed, updates MindGuru, and refreshes the stock list weekly.

**Installing on your phone**
Open the site in Chrome (Android) and tap **Install app** in the menu, or in Safari (iPhone) tap Share → **Add to Home Screen**. The site must be on `https://`.

**Security notes**
- Passwords are stored as one-way hashes. Sign-in cookies are HTTP-only and expire after 30 days (or when the browser closes if "Keep me signed in" is off).
- 8 wrong passwords for one username (or 20 from one network) lock sign-in for 15 minutes.
- The market-data proxies (`chart.php`, `breeze.php`) only answer signed-in users, so nobody else can use your ICICI session.
- Everyone shares the admin's daily ICICI session.

With `npm run dev` there is no PHP, so the app runs in **local dev mode** without sign-in.

## Connecting ICICI Direct (Breeze API)

Breeze is free for ICICI Direct customers. It needs PHP hosting (your cPanel), so it works on the hosted site, not with `npm run dev`.

**One-time setup**
1. Log in at [api.icicidirect.com](https://api.icicidirect.com) and register a new app.
2. Set the app's **Redirect URL** to the connector on your site, e.g. `https://your-domain.com/marketmind/api/breeze.php`
3. Copy `api/breeze-config.sample.php` to `breeze-config.php` and paste in your **API Key** and **Secret Key**. Best place: the folder *above* `public_html`, so it can never be downloaded. The `api/` folder also works.
4. Make sure the `api/` folder is writable by PHP (it stores today's session and a small cache there).

**Every trading day**
- Click **Log in to ICICI** in the sidebar, log in on ICICI's page, and you'll be sent back to the app connected. Sessions end daily.
- If the redirect doesn't bring you back, copy the number after `apisession=` from the address bar and use **Paste code** in the sidebar.

**What the connector does and doesn't do**
- Read-only: it fetches historical candles and quotes. It never places orders.
- Your secret key stays on the server; the browser only talks to `api/breeze.php`.
- NSE symbols (e.g. `INFY`) are converted to ICICI codes (e.g. `INFTEC`) using ICICI's daily security master file. The host needs PHP's zip extension.
- ICICI allows about 100 requests a minute; responses are cached briefly so the screener stays under that.
- The order-book meter uses the **best bid and offer** only, which is what the quotes API provides.

## Project structure

```
├── index.html            # App shell, styles, knowledge engine, UI
├── assets/               # Copied as-is into the build
│   ├── js/
│   │   ├── marketdata.js # Data fetching (ICICI, Yahoo), indicators, simulated fallback
│   │   ├── ks001.js      # KS-001 zones, scoring, trade plan, sizing, price outlook
│   │   ├── conditions.js # Plain-English strategy condition checker
│   │   ├── library.js    # Built-in concepts and strategies with source links
│   │   ├── consensus.js  # All-strategy verdict: per-strategy levels + combined conclusion
│   │   ├── account.js    # Sign-in screens, admin Users panel, per-user settings sync
│   │   ├── stockpicker.js # Search-as-you-type stock picker
│   │   └── mindguru.js   # Saves projections, history training, MindGuru page
│   ├── manifest.webmanifest, sw.js, icons/  # Installable app
│   └── api/
│       ├── lib/bootstrap.php  # Config, MySQL connection, automatic table setup, sign-in sessions
│       ├── auth.php      # Sign-in, first-time admin setup, password change, user settings
│       ├── users.php     # Admin-only user management
│       ├── stocks.php    # NSE + BSE stock search and list refresh
│       ├── mindguru.php  # Record projections, learn from outcomes, MindGuru report
│       ├── cron.php      # Daily job (command line only)
│       ├── lib/stocks.php     # Stock list download and search
│       ├── lib/mindguru.php   # Outcome judging rules and learned weights
│       ├── marketmind-config.sample.php
│       ├── chart.php     # Yahoo Finance proxy for hosting
│       ├── breeze.php    # ICICI Direct Breeze connector (login, candles, quotes)
│       └── breeze-config.sample.php
├── vite.config.js        # Dev server + dev-time data proxy
└── package.json
```

Uploaded documents and extracted concepts/strategies are still stored in the browser (IndexedDB); they move to MySQL in a later update.

## Disclaimer

This tool is for education and research only. It is not financial advice. Market data from Yahoo Finance may be delayed. Always do your own research before trading.

## License

MIT

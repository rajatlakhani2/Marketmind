<?php
// MarketMind AI — results dates, corporate actions and news.
//
// GET ?action=calendar                 -> { meetings: [...], actions: [...] }  market-wide, upcoming
// GET ?action=stock&symbol=TCS         -> { meetings, actions, next }          one stock: upcoming + recent
// GET ?action=news[&symbol=TCS]        -> { items: [{ title, source, link, at }] }  stock or market news
// GET ?action=depth&symbol=TCS          -> live order book: 5 bids / 5 offers, total buy & sell quantity, delivery %
// GET ?action=depth_many&symbols=A,B    -> { rows: { A: {...}, B: {...} } }  for the Live board
// GET ?action=actions_board            -> upcoming dividends / bonus / splits / rights / buybacks with amount, price, yield
// GET ?action=action_detail&symbol=X   -> 10-year history of actions and the share's move around each ex-date
// GET ?action=results_board            -> upcoming results dates with live price
// GET ?action=results&symbol=X         -> quarterly results, MarketMind estimate vs actual, moves on past result days
//
// Sources: NSE's public event calendar and corporate-actions feeds, and Google News RSS.
// Results are cached on the server (calendar 1 h, a stock 1 h, news 15 min).

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';

const EV_CACHE = __DIR__ . '/.events-cache';
const NSE = 'https://www.nseindia.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---------- cache (PHP files that exit if opened over the web) ----------
function ev_cache_get(string $key, int $ttl): ?array {
    $f = EV_CACHE . '/' . md5($key) . '.php';
    if (!is_file($f) || time() - filemtime($f) >= $ttl) return null;
    $raw = (string) file_get_contents($f);
    $data = json_decode(substr($raw, strpos($raw, "\n") + 1), true);
    return is_array($data) ? $data : null;
}
function ev_cache_put(string $key, array $data): void {
    if (!is_dir(EV_CACHE)) @mkdir(EV_CACHE, 0700, true);
    @file_put_contents(EV_CACHE . '/' . md5($key) . '.php', "<?php exit; ?>\n" . json_encode($data), LOCK_EX);
}

// ---------- HTTP ----------
function ev_get(string $url, array $headers = [], bool $useCookies = false): array {
    $ch = curl_init($url);
    $opts = [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_FOLLOWLOCATION => true, CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => array_merge(['User-Agent: ' . UA, 'Accept-Language: en-US,en;q=0.9'], $headers),
    ];
    if ($useCookies) {
        if (!is_dir(EV_CACHE)) @mkdir(EV_CACHE, 0700, true);
        $opts[CURLOPT_COOKIEJAR] = $opts[CURLOPT_COOKIEFILE] = EV_CACHE . '/nse-cookies.txt';
    }
    curl_setopt_array($ch, $opts);
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$status, $body === false ? '' : (string) $body];
}

// NSE JSON API. NSE sometimes wants its cookies first, so on a refusal visit the home page and retry once.
function nse(string $path, string $warm = '/'): array {
    $h = ['Accept: application/json, text/plain, */*', 'Referer: ' . NSE . $warm];
    [$s, $b] = ev_get(NSE . $path, $h, true);
    if ($s !== 200) {
        // NSE wants the cookies its own pages set: open the home page (and the page the data belongs to), then retry
        ev_get(NSE . '/', ['Accept: text/html'], true);
        if ($warm !== '/') ev_get(NSE . $warm, ['Accept: text/html', 'Referer: ' . NSE . '/'], true);
        [$s, $b] = ev_get(NSE . $path, $h, true);
    }
    $j = json_decode($b, true);
    if ($s !== 200 || !is_array($j)) throw new RuntimeException("NSE did not answer (HTTP $s)");
    return $j;
}

// ---------- order book ----------
function nse_depth(string $sym, int $ttl = 4): array {
    $key = "depth|$sym";
    if ($hit = ev_cache_get($key, $ttl)) return $hit;
    $j = nse('/api/quote-equity?symbol=' . rawurlencode($sym) . '&section=trade_info', '/get-quotes/equity?symbol=' . rawurlencode($sym));
    $ob = $j['marketDeptOrderBook'] ?? null;
    if (!is_array($ob)) throw new RuntimeException('NSE has no order book for ' . $sym);
    $lvl = fn($rows) => array_values(array_map(fn($r) => ['price' => (float) ($r['price'] ?? 0), 'qty' => (int) ($r['quantity'] ?? 0)],
        array_filter((array) $rows, fn($r) => (float) ($r['price'] ?? 0) > 0 || (int) ($r['quantity'] ?? 0) > 0)));
    $ti = $ob['tradeInfo'] ?? [];
    $dp = $j['securityWiseDP'] ?? [];
    $num = fn($v) => is_numeric($v) ? (float) $v : null;
    $out = [
        'symbol' => $sym,
        'totalBuy' => (int) ($ob['totalBuyQuantity'] ?? 0), 'totalSell' => (int) ($ob['totalSellQuantity'] ?? 0),
        'bids' => array_slice($lvl($ob['bid'] ?? []), 0, 5), 'asks' => array_slice($lvl($ob['ask'] ?? []), 0, 5),
        'volume' => $num($ti['totalTradedVolume'] ?? null),       // in lakh shares on NSE's page
        'value' => $num($ti['totalTradedValue'] ?? null),         // ₹ crore
        'vwap' => $num($ob['vwap'] ?? ($ti['vwap'] ?? null)),
        'deliveryPct' => $num($dp['deliveryToTradedQuantity'] ?? null),
        'deliveryDate' => $dp['secWiseDelPosDate'] ?? null,
        'at' => time(),
    ];
    ev_cache_put($key, $out);
    return $out;
}

// ---------- shaping ----------
function ev_date(?string $d): ?string { // "06-Nov-2026" -> "2026-11-06"
    $d = trim((string) $d);
    if ($d === '' || $d === '-') return null;
    $x = DateTime::createFromFormat('d-M-Y', $d);
    return $x ? $x->format('Y-m-d') : null;
}
function ev_today(): string { return (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d'); }

// Board meetings: results, dividends, fund raising...
function shape_meetings(array $rows): array {
    $out = [];
    foreach ($rows as $r) {
        $date = ev_date($r['date'] ?? null);
        if (!$date) continue;
        $purpose = trim((string) ($r['purpose'] ?? ''));
        $out[] = [
            'date' => $date, 'symbol' => (string) ($r['symbol'] ?? ''), 'company' => (string) ($r['company'] ?? ''),
            'purpose' => $purpose, 'details' => mb_substr(trim((string) ($r['bm_desc'] ?? '')), 0, 300),
            'results' => (bool) preg_match('/result/i', $purpose . ' ' . ($r['bm_desc'] ?? '')),
        ];
    }
    return $out;
}

// Corporate actions: dividends, splits, bonus, rights, buybacks
// Upcoming corporate actions: without a date range NSE returns only its latest 20 rows
function actions_window_path(int $days = 90): string {
    $t = new DateTime('now', new DateTimeZone('Asia/Kolkata'));
    $f = $t->format('d-m-Y');
    return '/api/corporates-corporateActions?index=equities&from_date=' . $f . '&to_date=' . $t->modify("+$days days")->format('d-m-Y');
}
function shape_actions(array $rows): array {
    $out = [];
    foreach ($rows as $r) {
        $ex = ev_date($r['exDate'] ?? null);
        if (!$ex) continue;
        $subject = trim((string) ($r['subject'] ?? ''));
        $kind = preg_match('/split|sub-?division/i', $subject) ? 'Split'
            : (preg_match('/bonus/i', $subject) ? 'Bonus'
            : (preg_match('/right/i', $subject) ? 'Rights'
            : (preg_match('/buy ?back/i', $subject) ? 'Buyback'
            : (preg_match('/dividend|distribution/i', $subject) ? 'Dividend' : 'Other'))));
        $out[] = [
            'exDate' => $ex, 'recordDate' => ev_date($r['recDate'] ?? null), 'symbol' => (string) ($r['symbol'] ?? ''),
            'company' => (string) ($r['comp'] ?? ''), 'subject' => $subject, 'kind' => $kind, 'series' => (string) ($r['series'] ?? ''),
        ];
    }
    return $out;
}

// Google News RSS -> [{ title, source, link, at }]
function news_items(string $query, int $max = 15): array {
    $url = 'https://news.google.com/rss/search?' . http_build_query(['q' => $query, 'hl' => 'en-IN', 'gl' => 'IN', 'ceid' => 'IN:en']);
    [$s, $b] = ev_get($url, ['Accept: application/rss+xml, application/xml']);
    if ($s !== 200 || $b === '') throw new RuntimeException("News feed did not answer (HTTP $s)");
    $prev = libxml_use_internal_errors(true);
    $xml = simplexml_load_string($b, 'SimpleXMLElement', LIBXML_NONET | LIBXML_NOCDATA);
    libxml_use_internal_errors($prev);
    if (!$xml || !isset($xml->channel->item)) return [];
    $items = [];
    foreach ($xml->channel->item as $it) {
        $title = trim((string) $it->title);
        $source = trim((string) $it->source);
        // Google appends " - Source" to titles; the source is shown separately
        if ($source !== '' && str_ends_with($title, ' - ' . $source)) $title = substr($title, 0, -strlen(' - ' . $source));
        $link = (string) $it->link;
        if (!preg_match('#^https://#', $link)) continue;
        $ts = strtotime((string) $it->pubDate) ?: null;
        $items[] = ['title' => $title, 'source' => $source, 'link' => $link, 'at' => $ts];
    }
    usort($items, fn($a, $b) => ($b['at'] ?? 0) <=> ($a['at'] ?? 0));
    return array_slice($items, 0, $max);
}

function clean_symbol(string $s): string {
    $s = strtoupper(trim($s));
    if (!preg_match('/^[A-Z0-9&\-]{1,20}$/', $s)) mm_json(400, ['error' => 'Invalid symbol']);
    return $s;
}


// ---------- amounts, prices and event studies (Corporate Actions and Results tabs) ----------
// "Interim Dividend - Rs 5 Per Share", "Bonus 1:1", "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share"
function action_terms(string $kind, string $subject): array {
    $t = ['amount' => null, 'ratio' => null, 'fromFv' => null, 'toFv' => null, 'label' => null];
    if ($kind === 'Dividend' && preg_match_all('/(?:rs|re|inr|₹)\.?\s*([\d]+(?:\.\d+)?)/i', $subject, $m)) {
        $t['amount'] = round(array_sum(array_map('floatval', $m[1])), 2);
        $t['label'] = '₹' . rtrim(rtrim(number_format($t['amount'], 2, '.', ''), '0'), '.') . ' a share';
    } elseif (in_array($kind, ['Bonus', 'Rights'], true) && preg_match('/(\d+)\s*:\s*(\d+)/', $subject, $m)) {
        $t['ratio'] = $m[1] . ':' . $m[2];
        $t['label'] = $kind === 'Bonus' ? "{$m[1]} new for every {$m[2]} held" : "{$m[1]} for every {$m[2]} held";
    } elseif ($kind === 'Split' && preg_match('/(?:rs|re)\.?\s*([\d.]+).*?to\s*(?:rs|re)\.?\s*([\d.]+)/i', $subject, $m)) {
        $t['fromFv'] = (float) $m[1]; $t['toFv'] = (float) $m[2];
        $t['label'] = 'face value ₹' . (0 + $m[1]) . ' → ₹' . (0 + $m[2]) . ($m[2] > 0 ? ' (1 share becomes ' . round($m[1] / $m[2], 2) . ')' : '');
    }
    return $t;
}

// Yahoo spark: last close and the day's change for many NSE symbols at once (about 15 min delayed)
function yahoo_prices(array $syms): array {
    $out = [];
    foreach (array_chunk(array_values(array_unique($syms)), 20) as $chunk) {
        $url = 'https://query1.finance.yahoo.com/v8/finance/spark?symbols=' . implode(',', array_map(fn($s) => rawurlencode($s . '.NS'), $chunk)) . '&range=5d&interval=1d';
        [$st, $b] = ev_get($url, ['Accept: application/json']);
        $j = $st === 200 ? json_decode($b, true) : null;
        if (!is_array($j)) continue;
        foreach ($j as $k => $e) {
            $c = array_values(array_filter($e['close'] ?? [], fn($v) => $v !== null && $v > 0));
            if (!$c) continue;
            $n = count($c);
            $out[preg_replace('/\.NS$/', '', $k)] = ['price' => round($c[$n - 1], 2), 'chg' => $n > 1 ? round(($c[$n - 1] / $c[$n - 2] - 1) * 100, 2) : null];
        }
    }
    return $out;
}

// Yahoo daily closes for one symbol: [['d' => 'Y-m-d', 'c' => close], ...] (split-adjusted, not dividend-adjusted)
function yahoo_daily(string $sym, string $range = '10y'): array {
    [$st, $b] = ev_get('https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($sym . '.NS') . "?range=$range&interval=1d", ['Accept: application/json']);
    $j = $st === 200 ? json_decode($b, true) : null;
    $r = $j['chart']['result'][0] ?? null;
    if (!$r) return [];
    $out = [];
    foreach ($r['timestamp'] ?? [] as $i => $ts) {
        $c = $r['indicators']['quote'][0]['close'][$i] ?? null;
        if ($c !== null && $c > 0) $out[] = ['d' => (new DateTime('@' . $ts))->setTimezone(new DateTimeZone('Asia/Kolkata'))->format('Y-m-d'), 'c' => (float) $c];
    }
    return $out;
}

// Price move around an event: buy $before trading days before the event day, sell $after trading days after it
function around(array $px, string $date, int $before, int $after, float $cash = 0.0): ?float {
    $i = null;
    foreach ($px as $k => $p) if ($p['d'] >= $date) { $i = $k; break; }
    if ($i === null || $i - $before < 0 || $i + $after >= count($px)) return null;
    $in = $px[$i - $before]["c"]; $out = $px[$i + $after]["c"];
    return round(($out + $cash - $in) / $in * 100, 2);
}
// Close-to-close move of the first trading day after a date (results are mostly announced after the market closes)
function next_day_move(array $px, string $date, bool $duringMarket = false): ?float {
    $i = null;
    foreach ($px as $k => $p) if ($duringMarket ? $p['d'] >= $date : $p['d'] > $date) { $i = $k; break; }
    if ($i === null || $i < 1) return null;
    return round(($px[$i]['c'] / $px[$i - 1]['c'] - 1) * 100, 2);
}
function stats_of(array $v): ?array {
    $v = array_values(array_filter($v, fn($x) => $x !== null));
    if (!$v) return null;
    sort($v);
    $n = count($v);
    return ['n' => $n, 'avg' => round(array_sum($v) / $n, 2), 'median' => $v[intdiv($n, 2)], 'pos' => count(array_filter($v, fn($x) => $x > 0)),
        'absAvg' => round(array_sum(array_map('abs', $v)) / $n, 2), 'best' => max($v), 'worst' => min($v)];
}

// NSE financial results, quarter by quarter (standalone/consolidated as NSE gives them). Field names differ between
// NSE feeds, so they are matched loosely; amounts are as NSE reports them (₹ lakh).
function num_of(array $r, array $patterns): ?float {
    foreach ($patterns as $p) foreach ($r as $k => $v) if (preg_match($p, (string) $k) && is_numeric(str_replace(',', '', (string) $v))) return (float) str_replace(',', '', (string) $v);
    return null;
}
function results_quarters(string $sym): array {
    $y = yahoo_quarters($sym);
    if (count($y) >= 2) return ['quarters' => $y, 'keys' => [], 'source' => 'Yahoo Finance (consolidated)'];
    $n = nse_quarters($sym);
    return $n + ['source' => 'NSE'];
}
// Yahoo quarterly fundamentals (rupees) -> ₹ lakh, the unit the app shows. Missing quarters are filled with blanks
// so "same quarter last year" is always 4 rows back.
function yahoo_quarters(string $sym): array {
    $types = ['quarterlyTotalRevenue', 'quarterlyNetIncome', 'quarterlyDilutedEPS', 'quarterlyBasicEPS'];
    $now = time();
    [$st, $b] = ev_get('https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/' . rawurlencode($sym . '.NS')
        . '?type=' . implode(',', $types) . '&period1=' . ($now - 5 * 365 * 86400) . '&period2=' . $now, ['Accept: application/json']);
    $j = $st === 200 ? json_decode($b, true) : null;
    $by = [];
    foreach ((array) ($j['timeseries']['result'] ?? []) as $res) {
        $t = $res['meta']['type'][0] ?? '';
        foreach ((array) ($res[$t] ?? []) as $v) {
            if (!is_array($v) || !isset($v['asOfDate'], $v['reportedValue']['raw'])) continue;
            $by[$v['asOfDate']][$t] = (float) $v['reportedValue']['raw'];
        }
    }
    if (!$by) return [];
    ksort($by);
    $out = [];
    $d = new DateTime(array_key_first($by));
    $last = array_key_last($by);
    while (($k = $d->format('Y-m-d')) <= $last) {
        $r = $by[$k] ?? [];
        $out[] = [
            'period' => $k,
            'revenue' => isset($r['quarterlyTotalRevenue']) ? round($r['quarterlyTotalRevenue'] / 1e5, 2) : null,
            'profit' => isset($r['quarterlyNetIncome']) ? round($r['quarterlyNetIncome'] / 1e5, 2) : null,
            'eps' => $r['quarterlyDilutedEPS'] ?? $r['quarterlyBasicEPS'] ?? null,
            'audited' => null,
        ];
        $d->modify('first day of next month')->modify('+2 months')->modify('last day of this month');
    }
    return $out;
}
function nse_quarters(string $sym): array {
    $j = nse('/api/results-comparision?symbol=' . rawurlencode($sym), '/get-quotes/equity?symbol=' . rawurlencode($sym));
    $rows = $j['resCmpData'] ?? $j['data'] ?? (array_is_list($j) ? $j : []);
    $out = [];
    foreach ($rows as $r) {
        if (!is_array($r)) continue;
        $to = ev_date($r['re_to_dt'] ?? $r['toDate'] ?? $r['to_date'] ?? null) ?? (isset($r['re_to_dt']) ? date('Y-m-d', strtotime((string) $r['re_to_dt'])) : null);
        if (!$to) continue;
        $out[$to] = [
            'period' => $to,
            'revenue' => num_of($r, ['/net_?sale/i', '/rev/i', '/tot_?inc/i', '/income/i']),
            'profit' => num_of($r, ['/net_?profit/i', '/pro_?loss_?aft/i', '/pat/i', '/profit/i']),
            'eps' => num_of($r, ['/dil_?eps/i', '/dilut\w*_eps/i', '/basic_?eps/i', '/eps/i']),
            'audited' => isset($r['re_res_type']) ? (string) $r['re_res_type'] : null,
        ];
    }
    ksort($out);
    return ['quarters' => array_values($out), 'keys' => $rows && is_array($rows[0] ?? null) ? array_keys($rows[0]) : []];
}
// MarketMind estimate for quarter i: same quarter last year × (1 + median year-on-year growth of the two quarters before)
function estimate_for(array $q, int $i, string $f): ?float {
    $g = [];
    foreach ([1, 2] as $k) {
        $a = $q[$i - $k][$f] ?? null; $b = $q[$i - $k - 4][$f] ?? null;
        if ($a !== null && $b !== null && $b > 0) $g[] = max(-0.5, min(1.0, $a / $b - 1));
    }
    $base = $q[$i - 4][$f] ?? null;
    if ($base === null) {
        $prev = $q[$i - 1][$f] ?? null;
        return $prev;                                   // too little history: assume no change from last quarter
    }
    if (!$g) return $base;
    sort($g);
    $mid = count($g) === 2 ? ($g[0] + $g[1]) / 2 : $g[0];
    return round($base * (1 + $mid), 2);
}

// ---------- actions ----------
$action = (string) ($_GET['action'] ?? '');
try {
    mm_require_user();

    // FII / DII cash-market buying and selling (NSE, latest days)
    if ($action === 'fiidii') {
        if ($hit = ev_cache_get('fiidii', 1800)) mm_json(200, $hit);
        $j = nse('/api/fiidiiTradeReact', '/reports/fii-dii');
        $rows = array_is_list($j) ? $j : ($j['data'] ?? []);
        $out = [];
        foreach ($rows as $r) if (is_array($r)) $out[] = ['who' => (string) ($r['category'] ?? ''), 'date' => (string) ($r['date'] ?? ''),
            'buy' => (float) str_replace(',', '', (string) ($r['buyValue'] ?? 0)), 'sell' => (float) str_replace(',', '', (string) ($r['sellValue'] ?? 0)), 'net' => (float) str_replace(',', '', (string) ($r['netValue'] ?? 0))];
        $res = ['at' => time(), 'rows' => $out, 'keys' => $rows && is_array($rows[0] ?? null) ? array_keys($rows[0]) : []];
        ev_cache_put('fiidii', $res);
        mm_json(200, $res);
    }

    // Trading holidays for the year (NSE equity segment)
    if ($action === 'holidays') {
        if ($hit = ev_cache_get('holidays', 86400)) mm_json(200, $hit);
        $j = nse('/api/holiday-master?type=trading', '/resources/exchange-communication-holidays');
        $out = [];
        foreach (($j['CM'] ?? $j['FO'] ?? []) as $r) {
            $d = DateTime::createFromFormat('d-M-Y', (string) ($r['tradingDate'] ?? ''));
            if ($d) $out[] = ['date' => $d->format('Y-m-d'), 'what' => (string) ($r['description'] ?? 'Holiday')];
        }
        $res = ['at' => time(), 'holidays' => $out, 'keys' => array_keys($j)];
        ev_cache_put('holidays', $res);
        mm_json(200, $res);
    }

    if ($action === 'calendar') {
        if ($hit = ev_cache_get('calendar', 3600)) mm_json(200, $hit);
        $today = ev_today();
        $meetings = array_values(array_filter(shape_meetings(nse('/api/event-calendar')), fn($m) => $m['date'] >= $today));
        $actions = array_values(array_filter(shape_actions(nse(actions_window_path())), fn($a) => $a['exDate'] >= $today));
        usort($meetings, fn($a, $b) => [$a['date'], $a['symbol']] <=> [$b['date'], $b['symbol']]);
        usort($actions, fn($a, $b) => [$a['exDate'], $a['symbol']] <=> [$b['exDate'], $b['symbol']]);
        $out = ['meetings' => $meetings, 'actions' => $actions, 'at' => time()];
        ev_cache_put('calendar', $out);
        mm_json(200, $out);
    }

    if ($action === 'stock') {
        $sym = clean_symbol((string) ($_GET['symbol'] ?? ''));
        if (preg_match('/^\d{6}$/', $sym)) mm_json(200, ['symbol' => $sym, 'meetings' => [], 'actions' => [], 'next' => null, 'note' => 'NSE calendars cover NSE-listed symbols only']);
        if ($hit = ev_cache_get("stock|$sym", 3600)) mm_json(200, $hit);
        $today = ev_today();
        $m = shape_meetings(nse('/api/event-calendar?index=equities&symbol=' . rawurlencode($sym)));
        $a = shape_actions(nse('/api/corporates-corporateActions?index=equities&symbol=' . rawurlencode($sym)));
        usort($m, fn($x, $y) => strcmp($y['date'], $x['date']));
        usort($a, fn($x, $y) => strcmp($y['exDate'], $x['exDate']));
        $upcoming = array_values(array_filter($m, fn($x) => $x['date'] >= $today));
        $next = $upcoming ? end($upcoming) : null; // nearest upcoming (list is newest first)
        $nextAction = null;
        foreach ($a as $x) if ($x['exDate'] >= $today) $nextAction = $x; // ends on the nearest upcoming
        $out = [
            'symbol' => $sym,
            'meetings' => array_slice($m, 0, 12),
            'actions' => array_slice($a, 0, 12),
            'next' => $next, 'nextAction' => $nextAction, 'at' => time(),
        ];
        ev_cache_put("stock|$sym", $out);
        mm_json(200, $out);
    }

    // Corporate Actions tab: every upcoming action with its amount / ratio and the live price
    if ($action === 'actions_board') {
        if ($hit = ev_cache_get('actions_board', 1800)) mm_json(200, $hit);
        $today = ev_today();
        $acts = array_values(array_filter(shape_actions(nse(actions_window_path())), fn($a) => $a['exDate'] >= $today));
        usort($acts, fn($a, $b) => [$a['exDate'], $a['symbol']] <=> [$b['exDate'], $b['symbol']]);
        $acts = array_slice($acts, 0, 150);
        $px = yahoo_prices(array_column($acts, 'symbol'));
        foreach ($acts as &$a) {
            $a += action_terms($a['kind'], $a['subject']);
            $p = $px[$a['symbol']] ?? null;
            $a['price'] = $p['price'] ?? null; $a['chg'] = $p['chg'] ?? null;
            $a['yield'] = $a['amount'] && $a['price'] ? round($a['amount'] / $a['price'] * 100, 2) : null;
        }
        unset($a);
        $out = ['actions' => $acts, 'at' => time(), 'delayed' => true];
        ev_cache_put('actions_board', $out);
        mm_json(200, $out);
    }

    // One company's full history of actions (10 years) and how the share moved around each ex-date
    if ($action === 'action_detail') {
        $sym = clean_symbol((string) ($_GET['symbol'] ?? ''));
        if ($hit = ev_cache_get("action_detail|$sym", 6 * 3600)) mm_json(200, $hit);
        $to = new DateTime('now', new DateTimeZone('Asia/Kolkata')); $from = (clone $to)->modify('-10 years');
        $hist = shape_actions(nse('/api/corporates-corporateActions?index=equities&symbol=' . rawurlencode($sym) . '&from_date=' . $from->format('d-m-Y') . '&to_date=' . $to->format('d-m-Y'),
            '/companies-listing/corporate-filings-actions'));
        usort($hist, fn($a, $b) => strcmp($b['exDate'], $a['exDate']));
        $px = yahoo_daily($sym);
        $today = ev_today();
        $moves = [];
        foreach ($hist as &$h) {
            $h += action_terms($h['kind'], $h['subject']);
            if ($h['exDate'] < $today) {
                $h['move5'] = around($px, $h['exDate'], 5, 5, $h['kind'] === 'Dividend' ? (float) ($h['amount'] ?? 0) : 0.0);
                $h['moveEx'] = around($px, $h['exDate'], 1, 0, $h['kind'] === 'Dividend' ? (float) ($h['amount'] ?? 0) : 0.0);
                $moves[$h['kind']][] = $h['move5'];
            }
        }
        unset($h);
        $divs = array_values(array_filter($hist, fn($h) => $h['kind'] === 'Dividend' && $h['amount']));
        $byYear = [];
        foreach ($divs as $d) { $fy = (int) substr($d['exDate'], 0, 4) - ((int) substr($d['exDate'], 5, 2) < 4 ? 1 : 0); $byYear[$fy . '-' . substr((string) ($fy + 1), 2)] = ($byYear[$fy . '-' . substr((string) ($fy + 1), 2)] ?? 0) + $d['amount']; }
        krsort($byYear);
        $last = $px ? end($px)['c'] : null;
        $out = ['symbol' => $sym, 'price' => $last, 'history' => $hist, 'dividendsByFy' => $byYear,
            'stats' => array_map('stats_of', $moves), 'at' => time()];
        ev_cache_put("action_detail|$sym", $out);
        mm_json(200, $out);
    }

    // Results tab: upcoming board meetings for results, with the live price
    if ($action === 'results_board') {
        if ($hit = ev_cache_get('results_board', 1800)) mm_json(200, $hit);
        $today = ev_today();
        $m = array_values(array_filter(shape_meetings(nse('/api/event-calendar')), fn($x) => $x['date'] >= $today && $x['results']));
        usort($m, fn($a, $b) => [$a['date'], $a['symbol']] <=> [$b['date'], $b['symbol']]);
        $m = array_slice($m, 0, 150);
        $px = yahoo_prices(array_column($m, 'symbol'));
        foreach ($m as &$x) { $p = $px[$x['symbol']] ?? null; $x['price'] = $p['price'] ?? null; $x['chg'] = $p['chg'] ?? null; }
        unset($x);
        $out = ['meetings' => $m, 'at' => time(), 'delayed' => true];
        ev_cache_put('results_board', $out);
        mm_json(200, $out);
    }

    // One company's quarterly results, MarketMind's estimate for each quarter and the share's move on past result days
    if ($action === 'results') {
        $sym = clean_symbol((string) ($_GET['symbol'] ?? ''));
        if ($hit = ev_cache_get("results|$sym", 3 * 3600)) mm_json(200, $hit);
        $r = results_quarters($sym);
        $q = $r['quarters'];
        foreach ($q as $i => &$x) {
            foreach (['revenue', 'profit'] as $f) {
                $x['est_' . $f] = estimate_for($q, $i, $f);
                $x['yoy_' . $f] = isset($q[$i - 4][$f]) && $q[$i - 4][$f] > 0 && $x[$f] !== null ? round(($x[$f] / $q[$i - 4][$f] - 1) * 100, 1) : null;
                $x['qoq_' . $f] = isset($q[$i - 1][$f]) && $q[$i - 1][$f] > 0 && $x[$f] !== null ? round(($x[$f] / $q[$i - 1][$f] - 1) * 100, 1) : null;
                $x['vs_est_' . $f] = $x['est_' . $f] && $x[$f] !== null && $x['est_' . $f] != 0 ? round(($x[$f] / $x['est_' . $f] - 1) * 100, 1) : null;
            }
        }
        unset($x);
        // Next quarter's estimate (quarter after the last reported one)
        $next = null;
        if ($q) {
            $n = count($q);
            $q2 = $q; $q2[] = ['revenue' => null, 'profit' => null];
            $next = ['period' => (new DateTime(end($q)['period']))->modify('last day of +3 months')->format('Y-m-d'),
                'est_revenue' => estimate_for($q2, $n, 'revenue'), 'est_profit' => estimate_for($q2, $n, 'profit')];
        }
        // Past result days from NSE's board-meeting history, and the share's next-day move
        $moves = [];
        try {
            $meet = array_filter(shape_meetings(nse('/api/event-calendar?index=equities&symbol=' . rawurlencode($sym))), fn($m) => $m['results'] && $m['date'] < ev_today());
            $px = yahoo_daily($sym, '5y');
            foreach ($meet as $m) $moves[] = ['date' => $m['date'], 'move' => next_day_move($px, $m['date'])];
            usort($moves, fn($a, $b) => strcmp($b['date'], $a['date']));
        } catch (Throwable $e) { /* optional */ }
        $out = ['symbol' => $sym, 'quarters' => array_reverse($q), 'next' => $next, 'resultDays' => array_slice($moves, 0, 12),
            'moveStats' => stats_of(array_column($moves, 'move')), 'unit' => '₹ lakh', 'source' => $r['source'] ?? 'NSE', 'keys' => $r['keys'], 'at' => time()];
        ev_cache_put("results|$sym", $out);
        mm_json(200, $out);
    }

    // Live buyers and sellers: NSE's order book (5 best bids and offers, total buy and sell quantity, delivery %)
    if ($action === 'depth') {
        $sym = clean_symbol((string) ($_GET['symbol'] ?? ''));
        mm_json(200, nse_depth($sym));
    }
    if ($action === 'depth_many') {
        $syms = array_slice(array_values(array_unique(array_filter(array_map(fn($x) => strtoupper(trim($x)), explode(',', (string) ($_GET['symbols'] ?? '')))))), 0, 40);
        $out = []; $t0 = microtime(true);
        foreach ($syms as $s) {
            if (!preg_match('/^[A-Z0-9&\-]{1,20}$/', $s)) continue;
            if (microtime(true) - $t0 > 18) { $out[$s] = ['symbol' => $s, 'error' => 'later']; continue; }   // stay inside PHP's time limit
            try { $out[$s] = nse_depth($s, 25); } catch (Throwable $e) { $out[$s] = ['symbol' => $s, 'error' => $e->getMessage()]; }
        }
        mm_json(200, ['rows' => $out, 'at' => time()]);
    }

    if ($action === 'news') {
        $sym = isset($_GET['symbol']) && $_GET['symbol'] !== '' ? clean_symbol((string) $_GET['symbol']) : '';
        $key = "news|$sym";
        if ($hit = ev_cache_get($key, 900)) mm_json(200, $hit);
        if ($sym !== '') {
            $name = '';
            try {
                $st = mm_db()->prepare('SELECT name FROM stocks WHERE symbol = ? AND is_active = 1 ORDER BY exchange = \'NSE\' DESC LIMIT 1');
                $st->execute([$sym]);
                $name = (string) ($st->fetchColumn() ?: '');
            } catch (Throwable $e) { /* name is optional */ }
            // Company name finds more coverage than the ticker; drop "Limited"/"Ltd" so headlines match
            $label = trim(preg_replace('/\b(limited|ltd\.?)\s*$/i', '', $name)) ?: $sym;
            $query = ($label !== $sym ? "\"$label\" OR " : '') . "$sym share when:14d";
        } else {
            $query = 'Sensex OR Nifty stock market when:2d';
        }
        $out = ['symbol' => $sym, 'query' => $query, 'items' => news_items($query), 'at' => time()];
        ev_cache_put($key, $out);
        mm_json(200, $out);
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    mm_json(502, ['error' => $e->getMessage()]);
}

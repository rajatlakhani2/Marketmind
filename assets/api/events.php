<?php
// MarketMind AI — results dates, corporate actions and news.
//
// GET ?action=calendar                 -> { meetings: [...], actions: [...] }  market-wide, upcoming
// GET ?action=stock&symbol=TCS         -> { meetings, actions, next }          one stock: upcoming + recent
// GET ?action=news[&symbol=TCS]        -> { items: [{ title, source, link, at }] }  stock or market news
// GET ?action=depth&symbol=TCS          -> live order book: 5 bids / 5 offers, total buy & sell quantity, delivery %
// GET ?action=depth_many&symbols=A,B    -> { rows: { A: {...}, B: {...} } }  for the Live board
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

// ---------- actions ----------
$action = (string) ($_GET['action'] ?? '');
try {
    mm_require_user();

    if ($action === 'calendar') {
        if ($hit = ev_cache_get('calendar', 3600)) mm_json(200, $hit);
        $today = ev_today();
        $meetings = array_values(array_filter(shape_meetings(nse('/api/event-calendar')), fn($m) => $m['date'] >= $today));
        $actions = array_values(array_filter(shape_actions(nse('/api/corporates-corporateActions?index=equities')), fn($a) => $a['exDate'] >= $today));
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

<?php
// MarketMind AI — market overview: the NIFTY 500 by size group and sector, index tiles, and sector news.
//
// GET ?action=market  -> { at, delayed, tiles:[…], sectors:{i:{index row}}, rows:[[sym,g,i,last,d1,w1,m1,m3,a50,a200], …] }
//                        d1/w1/m1/m3 = % change over 1 / 5 / 21 / 63 trading days; a50/a200 = 1 if above that
//                        day-average, 0 if below, null if too little history. Cached 5 min in market hours, else 60.
// GET ?action=news    -> { at, sectors:{i:{score, pos, neg, items:[{title,source,link,at,s}]}} }
//                        Google News headlines per sector, scored with a simple word list (+1 / −1 a headline,
//                        last 3 days). Context only: it never makes a call by itself. Cached 60 min.
//
// Prices: Yahoo Finance spark (about 15 minutes delayed), 20 symbols a request, 6 requests at a time.

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/universe.php';

const OV_CACHE = __DIR__ . '/.overview-cache';
const OV_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function ov_cache_get(string $key, int $ttl): ?array {
    $f = OV_CACHE . '/' . md5($key) . '.php';
    if (!is_file($f) || time() - filemtime($f) >= $ttl) return null;
    $raw = (string) file_get_contents($f);
    $data = json_decode(substr($raw, strpos($raw, "\n") + 1), true);
    return is_array($data) ? $data : null;
}
function ov_cache_put(string $key, array $data): void {
    if (!is_dir(OV_CACHE)) @mkdir(OV_CACHE, 0700, true);
    @file_put_contents(OV_CACHE . '/' . md5($key) . '.php', "<?php exit; ?>\n" . json_encode($data), LOCK_EX);
}

function ov_market_open(): bool {
    $now = new DateTime('now', new DateTimeZone('Asia/Kolkata'));
    if ((int) $now->format('N') >= 6) return false;
    $hm = (int) $now->format('Hi');
    return $hm >= 900 && $hm <= 1545;
}

/** Fetch many URLs, a few at a time. @return array<int, array{0:int,1:string}> */
function ov_multi(array $urls, array $headers, int $parallel = 6, int $timeout = 20): array {
    $out = [];
    foreach (array_chunk($urls, $parallel, true) as $chunk) {
        $mh = curl_multi_init(); $hs = [];
        foreach ($chunk as $k => $url) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => $timeout,
                CURLOPT_ENCODING => '', CURLOPT_HTTPHEADER => array_merge(['User-Agent: ' . OV_UA], $headers)]);
            curl_multi_add_handle($mh, $ch); $hs[$k] = $ch;
        }
        do { $st = curl_multi_exec($mh, $running); if ($running) curl_multi_select($mh, 1.0); } while ($running && $st === CURLM_OK);
        foreach ($hs as $k => $ch) {
            $out[$k] = [(int) curl_getinfo($ch, CURLINFO_HTTP_CODE), (string) curl_multi_getcontent($ch)];
            curl_multi_remove_handle($mh, $ch); curl_close($ch);
        }
        curl_multi_close($mh);
    }
    return $out;
}

function ov_pct(array $c, int $back): ?float {
    $n = count($c);
    if ($n <= $back || !$c[$n - 1 - $back]) return null;
    return round(($c[$n - 1] / $c[$n - 1 - $back] - 1) * 100, 2);
}
function ov_above(array $c, int $len): ?int {
    $n = count($c);
    if ($n < $len) return null;
    $avg = array_sum(array_slice($c, -$len)) / $len;
    return $c[$n - 1] > $avg ? 1 : 0;
}

/** Yahoo spark for many symbols: symbol => closes (oldest first, gaps removed) */
function ov_spark(array $yahooSyms): array {
    $urls = [];
    foreach (array_chunk($yahooSyms, 20) as $k => $chunk)
        $urls[$k] = 'https://query1.finance.yahoo.com/v8/finance/spark?' . 'symbols=' . implode(',', array_map('rawurlencode', $chunk)) . '&range=1y&interval=1d';
    $res = ov_multi($urls, ['Accept: application/json']);
    $out = [];
    foreach ($res as [$s, $b]) {
        if ($s !== 200) continue;
        $j = json_decode($b, true);
        if (!is_array($j)) continue;
        foreach ($j as $sym => $e) {
            if (!is_array($e) || empty($e['close'])) continue;
            $out[$sym] = array_values(array_filter($e['close'], fn($v) => $v !== null && $v > 0));
        }
    }
    return $out;
}

function ov_row(array $c): array {
    $n = count($c);
    return ['last' => $n ? round($c[$n - 1], 2) : null, 'd1' => ov_pct($c, 1), 'w1' => ov_pct($c, 5), 'm1' => ov_pct($c, 21), 'm3' => ov_pct($c, 63),
        'a50' => ov_above($c, 50), 'a200' => ov_above($c, 200)];
}

function ov_market(): array {
    $u = mm_universe();
    $idx = array_column(MM_TILES, 'sym');
    foreach (MM_SECTORS as $s) if ($s['index']) $idx[] = $s['index'];
    $idx = array_values(array_unique($idx));
    $syms = array_merge($idx, array_map(fn($s) => $s . '.NS', array_keys($u)));
    $data = ov_spark($syms);
    if (count($data) < 50) throw new RuntimeException('Price source did not answer (got ' . count($data) . ' of ' . count($syms) . ')');

    $tiles = [];
    foreach (MM_TILES as $t) $tiles[] = ['sym' => $t['sym'], 'name' => $t['name']] + ov_row($data[$t['sym']] ?? []);
    $sectors = [];
    foreach (MM_SECTORS as $i => $s) $sectors[$i] = ['name' => MM_INDUSTRIES[$i], 'short' => $s['short'], 'index' => $s['index']]
        + ($s['index'] ? ov_row($data[$s['index']] ?? []) : []);
    $rows = [];
    foreach ($u as $sym => $m) {
        $c = $data[$sym . '.NS'] ?? null;
        if (!$c) { $rows[] = [$sym, $m['g'], $m['i'], null, null, null, null, null, null, null]; continue; }
        $r = ov_row($c);
        $rows[] = [$sym, $m['g'], $m['i'], $r['last'], $r['d1'], $r['w1'], $r['m1'], $r['m3'], $r['a50'], $r['a200']];
    }
    return ['at' => time(), 'delayed' => true, 'groups' => MM_GROUPS, 'tiles' => $tiles, 'sectors' => $sectors, 'rows' => $rows,
        'missing' => count(array_filter($rows, fn($r) => $r[3] === null))];
}

// ---------- news: headline word scoring ----------
const OV_POS = ['surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'jump', 'jumps', 'gain', 'gains', 'rise', 'rises', 'rising', 'record high', 'upgrade', 'upgrades',
    'outperform', 'beats', 'beat estimates', 'strong', 'robust', 'growth', 'boost', 'boosts', 'order win', 'bags order', 'wins order', 'expansion', 'profit rises',
    'profit jumps', 'buy rating', 'bullish', 'recovery', 'rebound', 'rebounds', 'demand rises', 'tailwind', 'incentive', 'approval', 'approves', 'cut in duty', 'rate cut'];
const OV_NEG = ['fall', 'falls', 'fell', 'slump', 'slumps', 'plunge', 'plunges', 'crash', 'tumble', 'tumbles', 'drop', 'drops', 'decline', 'declines', 'slide', 'slides',
    'downgrade', 'downgrades', 'underperform', 'misses', 'weak', 'loss', 'losses', 'profit falls', 'concern', 'concerns', 'pressure', 'selloff', 'sell-off', 'bearish',
    'probe', 'penalty', 'ban', 'curb', 'tariff', 'slowdown', 'headwind', 'default', 'fraud', 'raid', 'resigns', 'hike in duty', 'sell rating', 'warning'];

function ov_score(string $title): int {
    $t = ' ' . strtolower($title) . ' ';
    $p = 0; $n = 0;
    foreach (OV_POS as $w) if (preg_match('/\b' . preg_quote($w, '/') . '\b/', $t)) $p++;
    foreach (OV_NEG as $w) if (preg_match('/\b' . preg_quote($w, '/') . '\b/', $t)) $n++;
    return $p > $n ? 1 : ($n > $p ? -1 : 0);
}

function ov_news(): array {
    $urls = [];
    foreach (MM_SECTORS as $i => $s)
        $urls[$i] = 'https://news.google.com/rss/search?' . http_build_query(['q' => $s['news'] . ' when:3d', 'hl' => 'en-IN', 'gl' => 'IN', 'ceid' => 'IN:en']);
    $res = ov_multi($urls, ['Accept: application/rss+xml, application/xml'], 5);
    $out = [];
    $cut = time() - 3 * 86400;
    foreach ($res as $i => [$s, $b]) {
        $items = [];
        if ($s === 200 && $b !== '') {
            $prev = libxml_use_internal_errors(true);
            $xml = simplexml_load_string($b, 'SimpleXMLElement', LIBXML_NONET | LIBXML_NOCDATA);
            libxml_use_internal_errors($prev);
            if ($xml && isset($xml->channel->item)) foreach ($xml->channel->item as $it) {
                $title = trim((string) $it->title); $src = trim((string) $it->source);
                if ($src !== '' && str_ends_with($title, ' - ' . $src)) $title = substr($title, 0, -strlen(' - ' . $src));
                $link = (string) $it->link; $ts = strtotime((string) $it->pubDate) ?: 0;
                if (!preg_match('#^https://#', $link) || $ts < $cut) continue;
                $items[] = ['title' => $title, 'source' => $src, 'link' => $link, 'at' => $ts, 's' => ov_score($title)];
            }
        }
        usort($items, fn($a, $c) => $c['at'] <=> $a['at']);
        $items = array_slice($items, 0, 12);
        $pos = count(array_filter($items, fn($x) => $x['s'] > 0)); $neg = count(array_filter($items, fn($x) => $x['s'] < 0));
        $out[$i] = ['score' => $pos - $neg, 'pos' => $pos, 'neg' => $neg, 'items' => $items, 'ok' => $s === 200];
    }
    return ['at' => time(), 'sectors' => $out];
}

$action = (string) ($_GET['action'] ?? '');
try {
    mm_require_user();
    if ($action === 'market') {
        $ttl = ov_market_open() ? 300 : 3600;
        $d = ov_cache_get('market', $ttl);
        if (!$d) { $d = ov_market(); ov_cache_put('market', $d); }
        mm_json(200, $d + ['open' => ov_market_open()]);
    }
    if ($action === 'news') {
        $d = ov_cache_get('news', 3600);
        if (!$d) { $d = ov_news(); ov_cache_put('news', $d); }
        mm_json(200, $d);
    }
    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind overview error: ' . $e->getMessage());
    mm_json(502, ['error' => $e->getMessage()]);
}

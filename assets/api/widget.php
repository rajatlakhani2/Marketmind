<?php
// MarketMind AI — index prices for the Android home-screen widget.
// GET widget.php -> { at, open, rows: [{ name, last, chg, pct }] }
// Public and read-only: only the main indices, nothing about any user. Yahoo Finance (about 15 minutes delayed),
// cached 2 minutes while the market is open and 30 minutes when it is shut.
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=60');
header('Access-Control-Allow-Origin: *');

const WG_INDICES = [['^NSEI', 'NIFTY 50'], ['^NSEBANK', 'Bank NIFTY'], ['^BSESN', 'SENSEX'], ['^INDIAVIX', 'India VIX']];
const WG_CACHE = __DIR__ . '/.widget-cache.php';

function wg_open(): bool {
    $n = new DateTime('now', new DateTimeZone('Asia/Kolkata'));
    if ((int) $n->format('N') >= 6) return false;
    $hm = (int) $n->format('Hi');
    return $hm >= 900 && $hm <= 1545;
}

$open = wg_open();
$ttl = $open ? 120 : 1800;
if (is_file(WG_CACHE) && time() - filemtime(WG_CACHE) < $ttl) {
    $raw = (string) file_get_contents(WG_CACHE);
    echo substr($raw, strpos($raw, "\n") + 1);
    exit;
}

$mh = curl_multi_init(); $hs = [];
foreach (WG_INDICES as [$sym]) {
    $ch = curl_init('https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($sym) . '?range=5d&interval=1d');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 10, CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36']]);
    curl_multi_add_handle($mh, $ch); $hs[$sym] = $ch;
}
do { $st = curl_multi_exec($mh, $running); if ($running) curl_multi_select($mh, 1.0); } while ($running && $st === CURLM_OK);

$rows = []; $ok = 0;
foreach (WG_INDICES as [$sym, $name]) {
    $j = json_decode((string) curl_multi_getcontent($hs[$sym]), true);
    curl_multi_remove_handle($mh, $hs[$sym]); curl_close($hs[$sym]);
    $meta = $j['chart']['result'][0]['meta'] ?? [];
    $last = isset($meta['regularMarketPrice']) ? (float) $meta['regularMarketPrice'] : null;
    // previous close: the last daily close before today's bar
    $closes = array_values(array_filter($j['chart']['result'][0]['indicators']['quote'][0]['close'] ?? [], fn($v) => $v !== null));
    $prev = count($closes) >= 2 ? (float) $closes[count($closes) - 2] : (isset($meta['chartPreviousClose']) ? (float) $meta['chartPreviousClose'] : null);
    $chg = $last !== null && $prev ? round($last - $prev, 2) : null;
    if ($last !== null) $ok++;
    $rows[] = ['name' => $name, 'last' => $last !== null ? round($last, 2) : null, 'chg' => $chg, 'pct' => $chg !== null ? round($chg / $prev * 100, 2) : null];
}
curl_multi_close($mh);

$out = json_encode(['at' => time(), 'open' => $open, 'delayed' => true, 'rows' => $rows]);
if ($ok) @file_put_contents(WG_CACHE, "<?php exit; ?>\n" . $out, LOCK_EX);
elseif (is_file(WG_CACHE)) { $raw = (string) file_get_contents(WG_CACHE); $out = substr($raw, strpos($raw, "\n") + 1); }
echo $out;

<?php
// MarketMind AI — market data proxy for shared hosting (cPanel / PHP 7.4+).
// The browser can't call Yahoo Finance directly (CORS), so the app calls
// this file, which fetches the chart JSON server-side and returns it.
// Only whitelisted parameters are accepted, and responses are cached briefly.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require __DIR__ . '/lib/bootstrap.php';
mm_require_user(); // signed-in MarketMind users only

function fail($code, $msg) {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

$symbol   = isset($_GET['symbol'])   ? strtoupper(trim($_GET['symbol'])) : '';
$interval = isset($_GET['interval']) ? $_GET['interval'] : '1d';
$range    = isset($_GET['range'])    ? $_GET['range']    : '1y';

$intervals = ['5m', '15m', '30m', '60m', '1d', '1wk', '1mo'];
$ranges    = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'];

if (!preg_match('/^\^?[A-Z0-9&\-]{1,20}(\.(NS|BO))?$/', $symbol)) fail(400, 'Invalid symbol');
if (!in_array($interval, $intervals, true)) fail(400, 'Invalid interval');
if (!in_array($range, $ranges, true)) fail(400, 'Invalid range');

// Short-lived file cache (intraday: 60s, daily and above: 5 min)
$ttl = in_array($interval, ['5m', '15m', '30m', '60m'], true) ? 60 : 300;
$cacheDir = sys_get_temp_dir() . '/marketmind_cache';
if (!is_dir($cacheDir)) @mkdir($cacheDir, 0700, true);
$cacheFile = $cacheDir . '/' . md5($symbol . '|' . $interval . '|' . $range) . '.json';
if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < $ttl) {
    readfile($cacheFile);
    exit;
}

$url = 'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($symbol)
     . '?interval=' . $interval . '&range=' . $range . '&includePrePost=false';

$body = false;
$status = 0;
if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (MarketMind AI)',
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
} else {
    $ctx = stream_context_create(['http' => [
        'timeout' => 15, 'ignore_errors' => true,
        'header' => "User-Agent: Mozilla/5.0 (MarketMind AI)\r\nAccept: application/json\r\n",
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) $status = (int) $m[1];
}

if ($body === false || $body === '') fail(502, 'Could not reach market data source');
$json = json_decode($body, true);
if ($json === null) fail(502, 'Market data source returned an invalid response');

if ($status === 200) @file_put_contents($cacheFile, $body);
http_response_code($status ?: 200);
echo $body;

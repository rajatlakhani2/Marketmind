<?php
// MarketMind order relay — runs on a VPS with a dedicated static IP registered with ICICI.
//
// SEBI requires API orders to come from a static IP registered with the broker, and a
// shared-hosting IP doesn't qualify. MarketMind (on shared hosting) sends each order the
// admin has approved here; this script checks the signature and passes it to ICICI Breeze.
//
// It accepts only:
//   - requests signed with the shared secret (HMAC-SHA256 over "time\nbody"), at most 60 s old
//   - from the IPs listed in relay-config.php (MarketMind's server)
//   - three actions: place, detail, cancel
// It keeps nothing except a log of what it sent.
//
// Setup: see relay/README.md.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out(int $code, array $data): void { http_response_code($code); echo json_encode($data); exit; }

$cfgFile = __DIR__ . '/relay-config.php';
if (!is_file($cfgFile)) out(503, ['error' => 'relay-config.php is missing']);
$cfg = include $cfgFile;
foreach (['secret', 'api_key', 'secret_key', 'allowed_ips'] as $k) {
    if (empty($cfg[$k])) out(503, ['error' => "relay-config.php: $k is not set"]);
}

// 1. Caller IP
$ip = $_SERVER['REMOTE_ADDR'] ?? '';
if (!in_array($ip, (array) $cfg['allowed_ips'], true)) out(403, ['error' => 'Not allowed from ' . $ip]);

// 2. Signature and freshness
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') out(405, ['error' => 'Use POST']);
$body = (string) file_get_contents('php://input');
$t = (string) ($_SERVER['HTTP_X_MM_TIME'] ?? '');
$sig = (string) ($_SERVER['HTTP_X_MM_SIG'] ?? '');
if (!ctype_digit($t) || abs(time() - (int) $t) > 60) out(401, ['error' => 'Request too old or clock is off']);
if (!hash_equals(hash_hmac('sha256', $t . "\n" . $body, (string) $cfg['secret']), $sig)) out(401, ['error' => 'Bad signature']);

$req = json_decode($body, true);
if (!is_array($req) || empty($req['session']) || !is_array($req['payload'] ?? null)) out(400, ['error' => 'Bad request']);
$action = (string) ($req['action'] ?? '');
$p = $req['payload'];

// 3. Only the fields ICICI needs, with basic checks
$allowed = [
    'place'  => ['stock_code', 'exchange_code', 'product', 'action', 'order_type', 'stoploss', 'quantity', 'price', 'validity', 'disclosed_quantity', 'user_remark', 'validity_date', 'expiry_date', 'right', 'strike_price'],
    'detail' => ['exchange_code', 'order_id'],
    'cancel' => ['exchange_code', 'order_id'],
];
if (!isset($allowed[$action])) out(400, ['error' => 'Unknown action']);
$p = array_intersect_key($p, array_flip($allowed[$action]));
if (!in_array($p['exchange_code'] ?? '', ['NSE', 'NFO'], true)) out(400, ['error' => 'Bad exchange']);
if ($action === 'place') {
    if (!in_array($p['order_type'] ?? '', ['limit', 'stoploss'], true)) out(400, ['error' => 'Only limit and stop-loss orders are allowed']);
    if (!in_array($p['action'] ?? '', ['buy', 'sell'], true)) out(400, ['error' => 'Bad side']);
    if (!((float) ($p['price'] ?? 0) > 0) || !((int) ($p['quantity'] ?? 0) > 0)) out(400, ['error' => 'Bad price or quantity']);
    $max = (float) ($cfg['max_order_value'] ?? 0);
    if ($max > 0 && (float) $p['price'] * (int) $p['quantity'] > $max) out(400, ['error' => 'Order value above the relay limit']);
}

// 4. Signed call to ICICI Breeze (checksum = sha256(timestamp + body + secret_key))
$method = ['place' => 'POST', 'detail' => 'GET', 'cancel' => 'DELETE'][$action];
$json = json_encode($p, JSON_UNESCAPED_SLASHES);
$ts = gmdate('Y-m-d\TH:i:s') . '.000Z';
$ch = curl_init('https://api.icicidirect.com/breezeapi/api/v1/order');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_POSTFIELDS => $json,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'X-Checksum: token ' . hash('sha256', $ts . $json . $cfg['secret_key']),
        'X-Timestamp: ' . $ts,
        'X-AppKey: ' . $cfg['api_key'],
        'X-SessionToken: ' . $req['session'],
    ],
]);
$resp = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

$log = sprintf("%s %s %s %s -> HTTP %d %s\n", gmdate('c'), $action, $p['stock_code'] ?? '', $p['order_id'] ?? (($p['action'] ?? '') . ' ' . ($p['quantity'] ?? '') . ' @ ' . ($p['price'] ?? '')), $status, substr((string) $resp, 0, 300));
@file_put_contents(__DIR__ . '/relay.log', $log, FILE_APPEND | LOCK_EX);

$data = is_string($resp) ? json_decode($resp, true) : null;
if (!is_array($data)) out(502, ['error' => 'ICICI did not answer' . ($err ? ": $err" : " (HTTP $status)")]);
if (($data['Status'] ?? 200) != 200 || (!empty($data['Error']) && empty($data['Success']))) {
    out(400, ['error' => is_string($data['Error'] ?? null) ? $data['Error'] : 'ICICI refused the request']);
}
out(200, $data);

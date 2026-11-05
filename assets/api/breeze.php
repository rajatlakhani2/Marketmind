<?php
// MarketMind AI — ICICI Direct Breeze connector (read-only market data).
//
// Keeps your API secret on the server, handles the daily ICICI login, and
// exposes only historical candles and quotes. It never places orders.
//
// Actions (?action=...):
//   status    -> { configured, loggedIn, loginDate }
//   login     -> redirects to the ICICI login page
//   (callback)-> ICICI redirects back here with the session; any request that
//                carries an apisession value is treated as the callback
//   logout    -> forgets today's session
//   candles   -> ?symbol=INFY&interval=30minute&days=60
//   quote     -> ?symbol=INFY
//
// Setup: copy breeze-config.sample.php to breeze-config.php and fill it in.

declare(strict_types=1);

const SESSION_FILE = __DIR__ . '/.breeze-session.php';
const CACHE_DIR    = __DIR__ . '/.breeze-cache';
const GUARD        = "<?php exit; ?>\n"; // stored files can't be read over the web

// ---------- config ----------
function load_config(): ?array {
    // Prefer a config file outside the web folder, then the api/ folder.
    $candidates = [
        dirname(__DIR__, 3) . '/breeze-config.php',
        dirname(__DIR__, 2) . '/breeze-config.php',
        __DIR__ . '/breeze-config.php',
    ];
    foreach ($candidates as $f) {
        if (is_file($f)) {
            $cfg = include $f;
            if (is_array($cfg) && !empty($cfg['api_key']) && !empty($cfg['secret_key'])
                && strpos($cfg['api_key'], 'PASTE') === false) {
                return $cfg + [
                    'api_url'    => 'https://api.icicidirect.com/breezeapi/api/v1/',
                    'hist_url'   => 'https://breezeapi.icicidirect.com/api/v2/historicalcharts',
                    'login_url'  => 'https://api.icicidirect.com/apiuser/login',
                    'master_url' => 'https://directlink.icicidirect.com/MotherAppMaster/SecurityMaster.zip',
                    'app_url'    => '../index.html',
                ];
            }
        }
    }
    return null;
}

// ---------- small helpers ----------
function json_out(int $code, array $data): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data);
    exit;
}

function read_guarded(string $file): ?array {
    if (!is_file($file)) return null;
    $raw = (string) file_get_contents($file);
    if (strpos($raw, GUARD) === 0) $raw = substr($raw, strlen(GUARD));
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

function write_guarded(string $file, array $data): bool {
    $dir = dirname($file);
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    return @file_put_contents($file, GUARD . json_encode($data), LOCK_EX) !== false;
}

function ist_today(): string {
    return (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d');
}

// Today's session, or null. Sessions are treated as expired at the end of the IST day.
function current_session(): ?array {
    $s = read_guarded(SESSION_FILE);
    if (!$s || empty($s['token']) || ($s['date'] ?? '') !== ist_today()) return null;
    return $s;
}

function http_request(string $method, string $url, ?string $body, array $headers, int $timeout = 20): array {
    $ch = curl_init($url);
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (MarketMind AI)',
    ];
    if ($body !== null) $opts[CURLOPT_POSTFIELDS] = $body; // Breeze sends JSON bodies even on GET
    curl_setopt_array($ch, $opts);
    $resp = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    return [$status, $resp === false ? null : (string) $resp, $err];
}

// Signed request to the v1 API (checksum = sha256(timestamp + body + secret)).
function breeze_v1(array $cfg, array $session, string $endpoint, array $body): array {
    $json = json_encode($body, JSON_UNESCAPED_SLASHES);
    $ts = gmdate('Y-m-d\TH:i:s') . '.000Z';
    $headers = [
        'Content-Type: application/json',
        'X-Checksum: token ' . hash('sha256', $ts . $json . $cfg['secret_key']),
        'X-Timestamp: ' . $ts,
        'X-AppKey: ' . $cfg['api_key'],
        'X-SessionToken: ' . $session['token'],
    ];
    [$status, $resp, $err] = http_request('GET', $cfg['api_url'] . $endpoint, $json, $headers);
    if ($resp === null) throw new RuntimeException('Could not reach ICICI: ' . $err);
    $data = json_decode($resp, true);
    if (!is_array($data)) throw new RuntimeException('ICICI returned an invalid response');
    check_breeze_error($data);
    return $data;
}

function check_breeze_error(array $data): void {
    $status = $data['Status'] ?? 200;
    $error = $data['Error'] ?? null;
    if ($status != 200 || ($error && empty($data['Success']))) {
        $msg = is_string($error) ? $error : 'ICICI request failed';
        if (preg_match('/session|resource not available|unauthori/i', $msg)) {
            @unlink(SESSION_FILE); // force a fresh login
            json_out(401, ['error' => 'ICICI session expired — please log in again', 'needsLogin' => true]);
        }
        throw new RuntimeException('ICICI: ' . $msg);
    }
}

// ---------- NSE symbol -> ICICI stock code (from ICICI's security master) ----------
function symbol_map(array $cfg): array {
    $file = CACHE_DIR . '/symbols.php';
    $cached = read_guarded($file);
    if ($cached && ($cached['date'] ?? '') === ist_today()) return $cached['map'];

    if (!class_exists('ZipArchive')) throw new RuntimeException('PHP zip extension is missing on the host');
    [$status, $zipData, $err] = http_request('GET', $cfg['master_url'], null, [], 90);
    if ($zipData === null || $status !== 200) {
        if ($cached) return $cached['map']; // yesterday's map is better than nothing
        throw new RuntimeException('Could not download ICICI security master: ' . ($err ?: "HTTP $status"));
    }
    $tmp = tempnam(sys_get_temp_dir(), 'mm');
    file_put_contents($tmp, $zipData);
    $zip = new ZipArchive();
    if ($zip->open($tmp) !== true) { @unlink($tmp); throw new RuntimeException('ICICI security master is not a valid zip'); }
    $txt = $zip->getFromName('NSEScripMaster.txt');
    $zip->close();
    @unlink($tmp);
    if ($txt === false) throw new RuntimeException('NSEScripMaster.txt not found in security master');

    $lines = preg_split('/\r\n|\n|\r/', $txt);
    $header = array_map(fn($h) => trim($h, " \"\t"), str_getcsv((string) array_shift($lines)));
    $iShort = array_search('ShortName', $header, true);
    $iExch  = array_search('ExchangeCode', $header, true);
    $iName  = array_search('CompanyName', $header, true);
    $iSeries = array_search('Series', $header, true);
    if ($iShort === false || $iExch === false) throw new RuntimeException('Unexpected security master format');
    $map = [];
    foreach ($lines as $line) {
        if ($line === '') continue;
        $c = str_getcsv($line);
        $exch = strtoupper(trim($c[$iExch] ?? '', " \""));
        $short = strtoupper(trim($c[$iShort] ?? '', " \""));
        if ($exch === '' || $short === '') continue;
        $series = $iSeries !== false ? strtoupper(trim($c[$iSeries] ?? '', " \"")) : 'EQ';
        // prefer the EQ series when a symbol appears more than once
        if (isset($map[$exch]) && $series !== 'EQ') continue;
        $map[$exch] = [$short, $iName !== false ? trim($c[$iName] ?? '', " \"") : ''];
    }
    if (!$map) throw new RuntimeException('Security master had no NSE symbols');
    write_guarded($file, ['date' => ist_today(), 'map' => $map]);
    return $map;
}

function resolve_symbol(array $cfg, string $symbol): array {
    $symbol = strtoupper(trim($symbol));
    if (!preg_match('/^[A-Z0-9&\-]{1,20}$/', $symbol)) json_out(400, ['error' => 'Invalid symbol']);
    $map = symbol_map($cfg);
    if (!isset($map[$symbol])) json_out(404, ['error' => "ICICI has no NSE stock code for $symbol"]);
    return ['nse' => $symbol, 'isec' => $map[$symbol][0], 'name' => $map[$symbol][1]];
}

function cache_get(string $key, int $ttl): ?array {
    $f = CACHE_DIR . '/' . md5($key) . '.php';
    if (is_file($f) && time() - filemtime($f) < $ttl) return read_guarded($f);
    return null;
}
function cache_put(string $key, array $data): void {
    write_guarded(CACHE_DIR . '/' . md5($key) . '.php', $data);
}

// ---------- actions ----------
$cfg = load_config();
$action = $_GET['action'] ?? '';

// Detect the login callback: ICICI sends the session as apisession / API_Session.
$incoming = null;
foreach (array_merge($_GET, $_POST) as $k => $v) {
    if (preg_match('/^api_?session$/i', (string) $k) && is_string($v) && $v !== '') { $incoming = trim($v); break; }
}
if ($incoming !== null) $action = 'callback';

// Only signed-in MarketMind users may use the connector.
require __DIR__ . '/lib/bootstrap.php';
if ($action === 'callback' && !mm_current_user()) {
    header('Content-Type: text/html; charset=utf-8');
    $code = preg_match('/^[A-Za-z0-9]{4,64}$/', (string) $incoming) ? (string) $incoming : '';
    if ($code !== '' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
        // ICICI posted back from its own site, so the browser held back our sign-in cookie.
        // Reload this page from our own site, which sends the cookie.
        $next = 'breeze.php?apisession=' . rawurlencode($code);
        echo '<!doctype html><meta charset="utf-8"><title>Connecting…</title><p>Connecting to ICICI…</p><script>location.replace(' . json_encode($next) . ');</script>';
        exit;
    }
    echo '<!doctype html><meta charset="utf-8"><title>Sign in first</title><p>Sign in to MarketMind first, then click <b>Paste code</b> in the sidebar'
        . ($code !== '' ? ' and paste: <code>' . htmlspecialchars($code) . '</code>' : '') . '.</p><p><a href="../index.html">Open MarketMind</a></p>';
    exit;
}
mm_require_user();

if ($action === 'status') {
    $s = $cfg ? current_session() : null;
    json_out(200, ['configured' => (bool) $cfg, 'loggedIn' => (bool) $s, 'loginDate' => $s['date'] ?? null]);
}

if (!$cfg) json_out(503, ['error' => 'ICICI Breeze is not set up yet (breeze-config.php missing)', 'configured' => false]);

if ($action === 'login') {
    header('Location: ' . $cfg['login_url'] . '?api_key=' . rawurlencode($cfg['api_key']));
    exit;
}

if ($action === 'callback') {
    header('Content-Type: text/html; charset=utf-8');
    $back = htmlspecialchars($cfg['app_url'], ENT_QUOTES);
    if (!preg_match('/^[A-Za-z0-9]{4,64}$/', (string) $incoming)) {
        echo "<p>That doesn't look like an ICICI session code.</p><p><a href=\"$back\">Back to MarketMind</a></p>";
        exit;
    }
    try {
        $body = json_encode(['SessionToken' => $incoming, 'AppKey' => $cfg['api_key']]);
        [$status, $resp, $err] = http_request('GET', $cfg['api_url'] . 'customerdetails', $body, ['Content-Type: application/json']);
        $data = $resp ? json_decode($resp, true) : null;
        $token = $data['Success']['session_token'] ?? null;
        if (!$token) throw new RuntimeException(is_string($data['Error'] ?? null) ? $data['Error'] : ($err ?: 'no session token returned'));
        $decoded = base64_decode($token, true);
        $user = $decoded !== false && strpos($decoded, ':') !== false ? explode(':', $decoded)[0] : '';
        if (!write_guarded(SESSION_FILE, ['token' => $token, 'date' => ist_today(), 'user' => $user, 'at' => time()])) {
            throw new RuntimeException('could not save the session (folder not writable)');
        }
        header('Location: ' . $cfg['app_url'] . '#icici=connected');
    } catch (Throwable $e) {
        echo '<p>ICICI login failed: ' . htmlspecialchars($e->getMessage()) . "</p><p><a href=\"$back\">Back to MarketMind</a></p>";
    }
    exit;
}

if ($action === 'logout') {
    @unlink(SESSION_FILE);
    json_out(200, ['loggedIn' => false]);
}

$session = current_session();
if (!$session) json_out(401, ['error' => 'Not logged in to ICICI today', 'needsLogin' => true]);

try {
    if ($action === 'candles') {
        $intervals = ['1minute' => 12, '5minute' => 12, '30minute' => 70, '1day' => 1350]; // calendar days per request (<=1000 candles)
        $maxDays   = ['1minute' => 5, '5minute' => 30, '30minute' => 200, '1day' => 4500];
        $interval = $_GET['interval'] ?? '1day';
        if (!isset($intervals[$interval])) json_out(400, ['error' => 'Invalid interval']);
        $days = max(1, min((int) ($_GET['days'] ?? 365), $maxDays[$interval]));
        $sym = resolve_symbol($cfg, (string) ($_GET['symbol'] ?? ''));

        $ttl = $interval === '1day' ? 600 : 60;
        $key = "c|{$sym['isec']}|$interval|$days";
        if ($hit = cache_get($key, $ttl)) json_out(200, $hit);

        $tz = new DateTimeZone('Asia/Kolkata');
        $end = new DateTime('now', $tz);
        $start = (clone $end)->modify("-$days days");
        $rows = [];
        $cursor = clone $start;
        while ($cursor < $end) {
            $chunkEnd = (clone $cursor)->modify('+' . $intervals[$interval] . ' days');
            if ($chunkEnd > $end) $chunkEnd = clone $end;
            $q = http_build_query([
                'interval' => $interval,
                'from_date' => $cursor->format('Y-m-d\TH:i:s') . '.000Z',
                'to_date' => $chunkEnd->format('Y-m-d\TH:i:s') . '.000Z',
                'stock_code' => $sym['isec'],
                'exch_code' => 'NSE',
                'product_type' => 'cash',
            ]);
            [$status, $resp, $err] = http_request('GET', $cfg['hist_url'] . '?' . $q, null, [
                'Content-Type: application/json',
                'X-SessionToken: ' . $session['token'],
                'apikey: ' . $cfg['api_key'],
            ]);
            if ($resp === null) throw new RuntimeException('Could not reach ICICI: ' . $err);
            $data = json_decode($resp, true);
            if (!is_array($data)) throw new RuntimeException('ICICI returned an invalid response');
            check_breeze_error($data);
            foreach (($data['Success'] ?? []) as $r) {
                // ICICI datetimes are IST wall-clock, e.g. "2025-02-03 09:20:00"
                $dt = DateTime::createFromFormat('Y-m-d H:i:s', (string) ($r['datetime'] ?? ''), $tz);
                if (!$dt) continue;
                $t = $dt->getTimestamp();
                $rows[$t] = [$t, (float) $r['open'], (float) $r['high'], (float) $r['low'], (float) $r['close'], (int) ($r['volume'] ?? 0)];
            }
            $cursor = $chunkEnd;
        }
        ksort($rows);
        $out = ['symbol' => $sym['nse'], 'isec' => $sym['isec'], 'name' => $sym['name'], 'interval' => $interval, 'candles' => array_values($rows)];
        if (!$rows) json_out(404, ['error' => "ICICI returned no candles for {$sym['nse']}"]);
        cache_put($key, $out);
        json_out(200, $out);
    }

    if ($action === 'quote') {
        $sym = resolve_symbol($cfg, (string) ($_GET['symbol'] ?? ''));
        $data = breeze_v1($cfg, $session, 'quotes', ['stock_code' => $sym['isec'], 'exchange_code' => 'NSE', 'product_type' => 'cash']);
        $rows = $data['Success'] ?? [];
        $q = null;
        foreach ($rows as $r) { if (strtoupper($r['exchange_code'] ?? '') === 'NSE') { $q = $r; break; } }
        if (!$q) $q = $rows[0] ?? null;
        if (!$q) json_out(404, ['error' => 'No quote returned']);
        $num = fn($k) => isset($q[$k]) && $q[$k] !== '' ? (float) $q[$k] : null;
        json_out(200, [
            'symbol' => $sym['nse'], 'isec' => $sym['isec'], 'name' => $sym['name'],
            'ltp' => $num('ltp'), 'ltt' => $q['ltt'] ?? null,
            'bid' => $num('best_bid_price'), 'bidQty' => $num('best_bid_quantity'),
            'ask' => $num('best_offer_price'), 'askQty' => $num('best_offer_quantity'),
            'open' => $num('open'), 'high' => $num('high'), 'low' => $num('low'),
            'prevClose' => $num('previous_close'), 'changePct' => $num('ltp_percent_change'),
            'upperCircuit' => $num('upper_circuit'), 'lowerCircuit' => $num('lower_circuit'),
            'volume' => $num('total_quantity_traded'),
            'at' => time(),
        ]);
    }

    json_out(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    json_out(502, ['error' => $e->getMessage()]);
}

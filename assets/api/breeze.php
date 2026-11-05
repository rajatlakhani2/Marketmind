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
    $json = $body ? json_encode($body, JSON_UNESCAPED_SLASHES) : '{}'; // ICICI wants {} for "no parameters"
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
    // A 6-digit symbol is a BSE scrip code; its ICICI code comes from the stock list in MySQL.
    if (preg_match('/^\d{6}$/', $symbol)) {
        $st = mm_db()->prepare("SELECT isec_code, name FROM stocks WHERE exchange = 'BSE' AND symbol = ?");
        $st->execute([$symbol]);
        $row = $st->fetch();
        if (!$row || $row['isec_code'] === '') json_out(404, ['error' => "ICICI has no BSE stock code for $symbol"]);
        return ['nse' => $symbol, 'isec' => $row['isec_code'], 'name' => $row['name'], 'exch' => 'BSE'];
    }
    $map = symbol_map($cfg);
    if (!isset($map[$symbol])) json_out(404, ['error' => "ICICI has no NSE stock code for $symbol"]);
    return ['nse' => $symbol, 'isec' => $map[$symbol][0], 'name' => $map[$symbol][1], 'exch' => 'NSE'];
}

// ---------- F&O underlyings (from FONSEScripMaster.txt in the same security master) ----------
// Returns [{ isec, name, symbol, kind: index|stock, lot, futures: [dates], options: [dates] }], cached for the day.
function fo_meta(array $cfg): array {
    $file = CACHE_DIR . '/fo_meta.php';
    $cached = read_guarded($file);
    if ($cached && ($cached['date'] ?? '') === ist_today()) return $cached['list'];

    if (!class_exists('ZipArchive')) throw new RuntimeException('PHP zip extension is missing on the host');
    [$status, $zipData, $err] = http_request('GET', $cfg['master_url'], null, [], 90);
    if ($zipData === null || $status !== 200) {
        if ($cached) return $cached['list'];
        throw new RuntimeException('Could not download ICICI security master: ' . ($err ?: "HTTP $status"));
    }
    $tmp = tempnam(sys_get_temp_dir(), 'mm');
    file_put_contents($tmp, $zipData);
    $zip = new ZipArchive();
    if ($zip->open($tmp) !== true) { @unlink($tmp); throw new RuntimeException('ICICI security master is not a valid zip'); }
    $txt = $zip->getFromName('FONSEScripMaster.txt');
    $zip->close();
    @unlink($tmp);
    if ($txt === false) throw new RuntimeException('FONSEScripMaster.txt not found in security master');

    $lines = preg_split('/\r\n|\n|\r/', $txt);
    $header = array_map(fn($h) => trim($h, " \"\t"), str_getcsv((string) array_shift($lines)));
    $col = fn($name) => array_search($name, $header, true);
    [$iInst, $iShort, $iExp, $iLot, $iName, $iExch] = [$col('InstrumentName'), $col('ShortName'), $col('ExpiryDate'), $col('LotSize'), $col('CompanyName'), $col('ExchangeCode')];
    if (in_array(false, [$iInst, $iShort, $iExp], true)) throw new RuntimeException('Unexpected F&O security master format');

    $today = ist_today();
    $u = [];
    foreach ($lines as $line) {
        if ($line === '') continue;
        $c = str_getcsv($line);
        $inst = strtoupper(trim($c[$iInst] ?? ''));
        if (!in_array($inst, ['FUTIDX', 'FUTSTK', 'OPTIDX', 'OPTSTK'], true)) continue;
        $isec = strtoupper(trim($c[$iShort] ?? ''));
        $d = DateTime::createFromFormat('d-M-Y', trim($c[$iExp] ?? ''));
        if ($isec === '' || !$d) continue;
        $exp = $d->format('Y-m-d');
        if ($exp < $today) continue;
        if (!isset($u[$isec])) {
            $u[$isec] = [
                'isec' => $isec, 'name' => trim($c[$iName] ?? '') ?: $isec,
                'symbol' => strtoupper(trim($c[$iExch] ?? '')) ?: $isec,
                'kind' => $inst[3] === 'I' ? 'index' : 'stock',
                'lot' => 0, 'futures' => [], 'options' => [],
            ];
        }
        $lot = (int) ($c[$iLot] ?? 0);
        $isFut = $inst[0] === 'F';
        // Lot size of the nearest futures contract is the one that applies now
        if ($isFut && $lot > 0 && (!$u[$isec]['futures'] || $exp < min($u[$isec]['futures']))) $u[$isec]['lot'] = $lot;
        if (!$u[$isec]['lot'] && $lot > 0) $u[$isec]['lot'] = $lot;
        $u[$isec][$isFut ? 'futures' : 'options'][$exp] = true;
    }
    $list = [];
    foreach ($u as $x) {
        $x['futures'] = array_keys($x['futures']); sort($x['futures']);
        $x['options'] = array_keys($x['options']); sort($x['options']);
        $list[] = $x;
    }
    // Indices first, then stocks A–Z
    usort($list, fn($a, $b) => [$a['kind'] === 'index' ? 0 : 1, $a['name']] <=> [$b['kind'] === 'index' ? 0 : 1, $b['name']]);
    if (!$list) throw new RuntimeException('No F&O contracts found in the security master');
    write_guarded($file, ['date' => $today, 'list' => $list]);
    return $list;
}

function fo_underlying(array $cfg, string $isec): array {
    $isec = strtoupper(trim($isec));
    if (!preg_match('/^[A-Z0-9&\-]{1,20}$/', $isec)) json_out(400, ['error' => 'Invalid underlying']);
    foreach (fo_meta($cfg) as $u) if ($u['isec'] === $isec) return $u;
    json_out(404, ['error' => "$isec has no F&O contracts"]);
}

function fo_expiry_param(string $date): string {
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) json_out(400, ['error' => 'Invalid expiry date']);
    return $date . 'T06:00:00.000Z'; // the format Breeze expects
}

// Spot: index value or the stock's cash price (NSE)
function fo_spot(array $cfg, array $session, array $u): ?float {
    try {
        $data = breeze_v1($cfg, $session, 'quotes', ['stock_code' => $u['isec'], 'exchange_code' => 'NSE', 'product_type' => 'cash']);
        foreach (($data['Success'] ?? []) as $r) {
            if (strtoupper($r['exchange_code'] ?? '') === 'NSE' && isset($r['ltp']) && $r['ltp'] !== '') return (float) $r['ltp'];
        }
    } catch (Throwable $e) { /* spot is optional */ }
    return null;
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
        $key = "c|{$sym['exch']}|{$sym['isec']}|$interval|$days";
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
                'exch_code' => $sym['exch'],
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
        $data = breeze_v1($cfg, $session, 'quotes', ['stock_code' => $sym['isec'], 'exchange_code' => $sym['exch'], 'product_type' => 'cash']);
        $rows = $data['Success'] ?? [];
        $q = null;
        foreach ($rows as $r) { if (strtoupper($r['exchange_code'] ?? '') === $sym['exch']) { $q = $r; break; } }
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

    // ---------- F&O ----------
    // Underlyings with their expiries and lot sizes, from ICICI's F&O security master.
    if ($action === 'fo_meta') {
        json_out(200, ['underlyings' => fo_meta($cfg)]);
    }

    // Option chain for one underlying, expiry and side (call or put).
    if ($action === 'option_chain') {
        $u = fo_underlying($cfg, (string) ($_GET['isec'] ?? ''));
        $expiry = fo_expiry_param((string) ($_GET['expiry'] ?? ''));
        $right = ($_GET['right'] ?? 'call') === 'put' ? 'put' : 'call';
        $key = "oc|{$u['isec']}|$expiry|$right";
        if ($hit = cache_get($key, 20)) json_out(200, $hit);
        $data = breeze_v1($cfg, $session, 'optionchain', [
            'stock_code' => $u['isec'], 'exchange_code' => 'NFO', 'product_type' => 'options',
            'expiry_date' => $expiry, 'right' => $right, 'strike_price' => '',
        ]);
        $rows = [];
        foreach (($data['Success'] ?? []) as $r) {
            $n = fn($k) => isset($r[$k]) && $r[$k] !== '' ? (float) $r[$k] : null;
            $strike = $n('strike_price');
            if ($strike === null) continue;
            $rows[] = [
                'strike' => $strike, 'ltp' => $n('ltp'), 'changePct' => $n('ltp_percent_change'),
                'oi' => $n('open_interest'), 'oiChange' => $n('chnge_oi'), 'volume' => $n('total_quantity_traded'),
                'bid' => $n('best_bid_price'), 'ask' => $n('best_offer_price'), 'prevClose' => $n('previous_close'),
                'spot' => $n('spot_price'),
            ];
        }
        usort($rows, fn($a, $b) => $a['strike'] <=> $b['strike']);
        $out = ['isec' => $u['isec'], 'name' => $u['name'], 'expiry' => substr($expiry, 0, 10), 'right' => $right, 'lot' => $u['lot'], 'rows' => $rows, 'at' => time()];
        if (!empty($_GET['debug']) && ($data['Success'][0] ?? null)) $out['raw'] = $data['Success'][0];
        cache_put($key, $out);
        json_out(200, $out);
    }

    // Futures quote for one underlying and expiry, plus the spot price.
    if ($action === 'futures') {
        $u = fo_underlying($cfg, (string) ($_GET['isec'] ?? ''));
        $expiry = fo_expiry_param((string) ($_GET['expiry'] ?? ''));
        $data = breeze_v1($cfg, $session, 'quotes', [
            'stock_code' => $u['isec'], 'exchange_code' => 'NFO', 'product_type' => 'futures',
            'expiry_date' => $expiry, 'right' => 'others', 'strike_price' => '0',
        ]);
        $q = ($data['Success'] ?? [])[0] ?? null;
        if (!$q) json_out(404, ['error' => 'No futures quote returned']);
        $num = fn($k) => isset($q[$k]) && $q[$k] !== '' ? (float) $q[$k] : null;
        json_out(200, [
            'isec' => $u['isec'], 'name' => $u['name'], 'expiry' => substr($expiry, 0, 10), 'lot' => $u['lot'],
            'ltp' => $num('ltp'), 'changePct' => $num('ltp_percent_change'), 'open' => $num('open'), 'high' => $num('high'), 'low' => $num('low'),
            'prevClose' => $num('previous_close'), 'volume' => $num('total_quantity_traded'), 'oi' => $num('open_interest'), 'oiChange' => $num('chnge_oi'),
            'bid' => $num('best_bid_price'), 'bidQty' => $num('best_bid_quantity'), 'ask' => $num('best_offer_price'), 'askQty' => $num('best_offer_quantity'),
            'spot' => fo_spot($cfg, $session, $u) ?? $num('spot_price'), 'ltt' => $q['ltt'] ?? null, 'at' => time(),
            'raw' => !empty($_GET['debug']) ? $q : null,
        ]);
    }

    // ---------- your ICICI account (read-only) ----------
    // Holdings: shares you own (demat). Positions: today's open trades (intraday, F&O).
    if ($action === 'holdings') {
        // The ICICI session is the admin's own account, so only an admin may read it
        if ((mm_current_user()['role'] ?? '') !== 'admin') json_out(403, ['error' => 'Only the admin can see the ICICI holdings']);
        $tz = new DateTimeZone('Asia/Kolkata');
        $to = (new DateTime('now', $tz))->format('Y-m-d') . 'T06:00:00.000Z';
        $from = (new DateTime('-3650 days', $tz))->format('Y-m-d') . 'T06:00:00.000Z';
        $out = ['holdings' => [], 'positions' => [], 'notes' => []];
        try {
            $d = breeze_v1($cfg, $session, 'portfolioholdings', ['exchange_code' => 'NSE', 'from_date' => $from, 'to_date' => $to, 'stock_code' => '', 'portfolio_type' => '']);
            $out['holdings'] = $d['Success'] ?? [];
        } catch (Throwable $e) { $out['notes'][] = 'Holdings: ' . $e->getMessage(); }
        if (!$out['holdings']) {
            try {
                $d = breeze_v1($cfg, $session, 'dematholdings', []);
                $out['demat'] = $d['Success'] ?? [];
            } catch (Throwable $e) { $out['notes'][] = 'Demat holdings: ' . $e->getMessage(); }
        }
        try {
            $d = breeze_v1($cfg, $session, 'portfoliopositions', []);
            $out['positions'] = $d['Success'] ?? [];
        } catch (Throwable $e) { $out['notes'][] = 'Positions: ' . $e->getMessage(); }
        // ICICI codes -> NSE symbols (e.g. RELIND -> RELIANCE)
        $codes = [];
        foreach (array_merge($out['holdings'] ?: [], $out['demat'] ?? [], $out['positions'] ?: []) as $r) if (!empty($r['stock_code'])) $codes[strtoupper((string) $r['stock_code'])] = true;
        $map = [];
        if ($codes) {
            $st = mm_db()->prepare("SELECT isec_code, symbol FROM stocks WHERE exchange = 'NSE' AND isec_code IN (" . implode(',', array_fill(0, count($codes), '?')) . ')');
            $st->execute(array_keys($codes));
            foreach ($st->fetchAll() as $r) $map[strtoupper($r['isec_code'])] = $r['symbol'];
        }
        $out['symbols'] = $map;
        $out['at'] = time();
        json_out(200, $out);
    }

    // Spot price of an F&O underlying (index or stock).
    if ($action === 'fo_spot') {
        $u = fo_underlying($cfg, (string) ($_GET['isec'] ?? ''));
        json_out(200, ['isec' => $u['isec'], 'spot' => fo_spot($cfg, $session, $u), 'at' => time()]);
    }

    json_out(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    json_out(502, ['error' => $e->getMessage()]);
}

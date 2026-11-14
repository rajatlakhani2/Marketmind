<?php
// MarketMind AI — broker accounts that each user adds for themselves (several per user, several brokers).
// API secrets and daily session tokens are stored encrypted (see mm_encrypt in bootstrap.php).
// Today: ICICI Direct (Breeze). Zerodha, Groww, Upstox and Angel One plug in here later.

declare(strict_types=1);

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === realpath(__FILE__)) { http_response_code(404); exit; }

const MM_BROKERS = [
    'icici' => ['name' => 'ICICI Direct', 'login_url' => 'https://api.icicidirect.com/apiuser/login?api_key=', 'api_url' => 'https://api.icicidirect.com/breezeapi/api/v1/'],
    'zerodha' => ['name' => 'Zerodha (Kite)', 'login_url' => 'https://kite.zerodha.com/connect/login?v=3&api_key=', 'api_url' => 'https://api.kite.trade/'],
];
const MM_BROKER_PENDING_KEY = 'broker_login_pending'; // user_settings key: account waiting for its ICICI callback
const MM_MAX_BROKER_ACCOUNTS = 6;

function mm_ist_today(): string { return (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d'); }

// One account of this user (or 404).
function mm_broker_account(int $userId, int $id): array {
    $st = mm_db()->prepare('SELECT * FROM broker_accounts WHERE id = ? AND user_id = ?');
    $st->execute([$id, $userId]);
    $a = $st->fetch();
    if (!$a) mm_json(404, ['error' => 'Broker account not found']);
    return $a;
}

// An account this user may VIEW: their own, or one its owner shared with them (read-only).
function mm_broker_viewable(array $u, int $id): array {
    $st = mm_db()->prepare('SELECT * FROM broker_accounts WHERE id = ?');
    $st->execute([$id]);
    $a = $st->fetch();
    $shared = $a ? array_filter(array_map('trim', explode(',', strtolower((string) $a['shared_with'])))) : [];
    if (!$a || ((int) $a['user_id'] !== (int) $u['id'] && !in_array(strtolower($u['username']), $shared, true))) mm_json(404, ['error' => 'Broker account not found']);
    return $a;
}

function mm_broker_public(array $a): array {
    $today = mm_ist_today();
    return [
        'id' => (int) $a['id'], 'broker' => $a['broker'], 'brokerName' => MM_BROKERS[$a['broker']]['name'] ?? $a['broker'],
        'label' => $a['label'], 'apiKeyEnd' => substr((string) $a['api_key'], -4),
        'connectedToday' => ($a['session_date'] ?? '') === $today && !empty($a['session_enc']),
        'brokerUser' => $a['broker_user'], 'lastError' => $a['last_error'], 'updatedAt' => $a['updated_at'],
        'sharedWith' => $a['shared_with'] ?? '',
    ];
}

function mm_broker_set_pending(int $userId, int $accountId): void {
    $pdo = mm_db();
    $pdo->prepare('DELETE FROM user_settings WHERE user_id = ? AND setting_key = ?')->execute([$userId, MM_BROKER_PENDING_KEY]);
    if ($accountId > 0) {
        $pdo->prepare('INSERT INTO user_settings (user_id, setting_key, value_json, updated_at) VALUES (?, ?, ?, ?)')
            ->execute([$userId, MM_BROKER_PENDING_KEY, json_encode(['id' => $accountId, 'at' => time()]), mm_now()]);
    }
}

// The account this user started an ICICI login for in the last 15 minutes, or null.
function mm_broker_pending(int $userId): ?array {
    $st = mm_db()->prepare('SELECT value_json FROM user_settings WHERE user_id = ? AND setting_key = ?');
    $st->execute([$userId, MM_BROKER_PENDING_KEY]);
    $v = json_decode((string) $st->fetchColumn(), true);
    if (!is_array($v) || time() - (int) ($v['at'] ?? 0) > 900) return null;
    $st = mm_db()->prepare('SELECT * FROM broker_accounts WHERE id = ? AND user_id = ?');
    $st->execute([(int) ($v['id'] ?? 0), $userId]);
    return $st->fetch() ?: null;
}

function mm_broker_http(string $method, string $url, ?string $body, array $headers, int $timeout = 20): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $timeout, CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers, CURLOPT_USERAGENT => 'Mozilla/5.0 (MarketMind AI)'] + ($body !== null ? [CURLOPT_POSTFIELDS => $body] : []));
    $resp = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    return [$status, $resp === false ? null : (string) $resp, $err];
}

// ICICI redirected back with a session code for this account: swap it for today's session token and keep it.
function mm_icici_finish_login(array $a, string $code): void {
    $api = MM_BROKERS['icici']['api_url'];
    [, $resp, $err] = mm_broker_http('GET', $api . 'customerdetails', json_encode(['SessionToken' => $code, 'AppKey' => $a['api_key']]), ['Content-Type: application/json']);
    $data = $resp ? json_decode($resp, true) : null;
    $token = $data['Success']['session_token'] ?? null;
    if (!$token) {
        $msg = is_string($data['Error'] ?? null) ? $data['Error'] : ($err ?: 'no session token returned');
        mm_db()->prepare('UPDATE broker_accounts SET last_error = ?, updated_at = ? WHERE id = ?')->execute([substr('Login: ' . $msg, 0, 250), mm_now(), $a['id']]);
        throw new RuntimeException($msg);
    }
    $decoded = base64_decode($token, true);
    $user = $decoded !== false && strpos($decoded, ':') !== false ? explode(':', $decoded)[0] : '';
    mm_db()->prepare("UPDATE broker_accounts SET session_enc = ?, session_date = ?, broker_user = ?, last_error = '', updated_at = ? WHERE id = ?")
        ->execute([mm_encrypt($token), mm_ist_today(), substr($user, 0, 60), mm_now(), $a['id']]);
}

// Signed Breeze v1 call for one stored account (checksum = sha256(timestamp + body + secret)).
function mm_icici_call(array $a, string $endpoint, array $body): array {
    if (($a['session_date'] ?? '') !== mm_ist_today() || empty($a['session_enc'])) {
        mm_json(401, ['error' => 'Log in to this ICICI account for today first', 'needsLogin' => true, 'accountId' => (int) $a['id']]);
    }
    $secret = mm_decrypt((string) $a['secret_enc']);
    $token = mm_decrypt((string) $a['session_enc']);
    if ($secret === null || $token === null) mm_json(409, ['error' => 'The saved secret for this account can no longer be read (the server key changed). Edit the account and enter the secret again.']);
    $json = $body ? json_encode($body, JSON_UNESCAPED_SLASHES) : '{}';
    $ts = gmdate('Y-m-d\TH:i:s') . '.000Z';
    $headers = ['Content-Type: application/json', 'X-Checksum: token ' . hash('sha256', $ts . $json . $secret), 'X-Timestamp: ' . $ts, 'X-AppKey: ' . $a['api_key'], 'X-SessionToken: ' . $token];
    $data = null;
    for ($try = 0; $try < 2 && !is_array($data); $try++) {
        if ($try) usleep(700000);
        [$status, $resp, $err] = mm_broker_http('GET', MM_BROKERS['icici']['api_url'] . $endpoint, $json, $headers);
        $data = $resp === null ? null : json_decode($resp, true);
    }
    if (!is_array($data)) throw new RuntimeException($resp === null ? 'Could not reach ICICI: ' . $err : 'ICICI returned an invalid response');
    $error = $data['Error'] ?? null;
    if (($data['Status'] ?? 200) != 200 || ($error && empty($data['Success']))) {
        $msg = is_string($error) ? $error : 'ICICI request failed';
        if (preg_match('/session|resource not available|unauthori/i', $msg)) {
            mm_db()->prepare('UPDATE broker_accounts SET session_enc = NULL, session_date = NULL, updated_at = ? WHERE id = ?')->execute([mm_now(), $a['id']]);
            mm_json(401, ['error' => 'ICICI session expired. Log in to this account again.', 'needsLogin' => true, 'accountId' => (int) $a['id']]);
        }
        throw new RuntimeException('ICICI: ' . $msg);
    }
    return $data;
}

// Cash: ICICI 'funds' (bank balance and what is allocated to equity / F&O)
function mm_icici_funds(array $a): array {
    $f = mm_icici_call($a, 'funds', [])['Success'] ?? [];
    $num = fn($k) => isset($f[$k]) && is_numeric($f[$k]) ? (float) $f[$k] : null;
    return ['bank' => $num('total_bank_balance'), 'equity' => $num('allocated_equity'), 'fno' => $num('allocated_fno'), 'free' => $num('unallocated_balance'), 'blockEquity' => $num('block_by_trade_equity'), 'keys' => array_keys($f)];
}

// Holdings and today's positions of one ICICI account, in the same shape as breeze.php?action=holdings.
function mm_icici_holdings(array $a): array {
    $tz = new DateTimeZone('Asia/Kolkata');
    $to = (new DateTime('now', $tz))->format('Y-m-d') . 'T06:00:00.000Z';
    $from = (new DateTime('-3650 days', $tz))->format('Y-m-d') . 'T06:00:00.000Z';
    $out = ['holdings' => [], 'positions' => [], 'notes' => []];
    try { $out['holdings'] = mm_icici_call($a, 'portfolioholdings', ['exchange_code' => 'NSE', 'from_date' => $from, 'to_date' => $to, 'stock_code' => '', 'portfolio_type' => ''])['Success'] ?? []; }
    catch (Throwable $e) { $out['notes'][] = 'Holdings: ' . $e->getMessage(); }
    if (!$out['holdings']) {
        try { $out['demat'] = mm_icici_call($a, 'dematholdings', [])['Success'] ?? []; }
        catch (Throwable $e) { $out['notes'][] = 'Demat holdings: ' . $e->getMessage(); }
    }
    try { $out['positions'] = mm_icici_call($a, 'portfoliopositions', [])['Success'] ?? []; }
    catch (Throwable $e) { $out['notes'][] = 'Positions: ' . $e->getMessage(); }
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
    return $out;
}


// ---------- Zerodha (Kite Connect v3) ----------
// Login: kite.zerodha.com sends the user back to api/kite.php with request_token; we swap it for the day's access token.
function mm_kite_finish_login(array $a, string $requestToken): void {
    $secret = mm_decrypt((string) $a['secret_enc']);
    if ($secret === null) throw new RuntimeException('The saved secret can no longer be read; enter it again');
    [$st, $resp] = mm_broker_http('POST', MM_BROKERS['zerodha']['api_url'] . 'session/token',
        http_build_query(['api_key' => $a['api_key'], 'request_token' => $requestToken, 'checksum' => hash('sha256', $a['api_key'] . $requestToken . $secret)]),
        ['X-Kite-Version: 3', 'Content-Type: application/x-www-form-urlencoded']);
    $j = $resp ? json_decode($resp, true) : null;
    $token = $j['data']['access_token'] ?? null;
    if (!$token) {
        $msg = (string) ($j['message'] ?? "HTTP $st");
        mm_db()->prepare('UPDATE broker_accounts SET last_error = ?, updated_at = ? WHERE id = ?')->execute([substr('Login: ' . $msg, 0, 250), mm_now(), $a['id']]);
        throw new RuntimeException($msg);
    }
    mm_db()->prepare("UPDATE broker_accounts SET session_enc = ?, session_date = ?, broker_user = ?, last_error = '', updated_at = ? WHERE id = ?")
        ->execute([mm_encrypt($token), mm_ist_today(), substr((string) ($j['data']['user_id'] ?? ''), 0, 60), mm_now(), $a['id']]);
}

function mm_kite_call(array $a, string $path): array {
    if (($a['session_date'] ?? '') !== mm_ist_today() || empty($a['session_enc'])) mm_json(401, ['error' => 'Log in to this Zerodha account for today first', 'needsLogin' => true, 'accountId' => (int) $a['id']]);
    $token = mm_decrypt((string) $a['session_enc']);
    [$st, $resp, $err] = mm_broker_http('GET', MM_BROKERS['zerodha']['api_url'] . $path, null, ['X-Kite-Version: 3', 'Authorization: token ' . $a['api_key'] . ':' . $token]);
    $j = $resp ? json_decode($resp, true) : null;
    if (!is_array($j)) throw new RuntimeException('Could not reach Zerodha' . ($err ? ": $err" : ''));
    if (($j['status'] ?? '') !== 'success') {
        if (($j['error_type'] ?? '') === 'TokenException' || $st === 403) {
            mm_db()->prepare('UPDATE broker_accounts SET session_enc = NULL, session_date = NULL, updated_at = ? WHERE id = ?')->execute([mm_now(), $a['id']]);
            mm_json(401, ['error' => 'Zerodha session expired. Log in to this account again.', 'needsLogin' => true, 'accountId' => (int) $a['id']]);
        }
        throw new RuntimeException('Zerodha: ' . ($j['message'] ?? "HTTP $st"));
    }
    return $j['data'] ?? [];
}

// Same shape as the ICICI holdings, so the app's Holdings, My money and X-ray work unchanged
function mm_kite_holdings(array $a): array {
    $out = ['holdings' => [], 'positions' => [], 'notes' => [], 'symbols' => []];
    try {
        foreach (mm_kite_call($a, 'portfolio/holdings') as $h) {
            $sym = strtoupper((string) $h['tradingsymbol']);
            $out['holdings'][] = ['stock_code' => $sym, 'quantity' => (float) ($h['quantity'] ?? 0) + (float) ($h['t1_quantity'] ?? 0), 'average_price' => (float) ($h['average_price'] ?? 0),
                'current_market_price' => (float) ($h['last_price'] ?? 0), 'pnl' => (float) ($h['pnl'] ?? 0), 'exchange_code' => $h['exchange'] ?? 'NSE'];
            $out['symbols'][$sym] = $sym;
        }
    } catch (Throwable $e) { $out['notes'][] = 'Holdings: ' . $e->getMessage(); }
    try {
        foreach ((mm_kite_call($a, 'portfolio/positions')['net'] ?? []) as $p) {
            if ((float) ($p['quantity'] ?? 0) == 0 && (float) ($p['pnl'] ?? 0) == 0) continue;
            $sym = strtoupper((string) $p['tradingsymbol']);
            $out['positions'][] = ['stock_code' => $sym, 'quantity' => (float) $p['quantity'], 'average_price' => (float) ($p['average_price'] ?? 0), 'ltp' => (float) ($p['last_price'] ?? 0),
                'pnl' => (float) ($p['pnl'] ?? 0), 'product_type' => $p['product'] ?? '', 'exchange_code' => $p['exchange'] ?? ''];
            $out['symbols'][$sym] = $sym;
        }
    } catch (Throwable $e) { $out['notes'][] = 'Positions: ' . $e->getMessage(); }
    $out['at'] = time();
    return $out;
}

function mm_kite_funds(array $a): array {
    $m = mm_kite_call($a, 'user/margins');
    $eq = $m['equity'] ?? [];
    return ['bank' => isset($eq['net']) ? (float) $eq['net'] : null, 'equity' => isset($eq['utilised']['debits']) ? (float) $eq['utilised']['debits'] : null, 'fno' => null,
        'free' => isset($eq['available']['live_balance']) ? (float) $eq['available']['live_balance'] : (isset($eq['net']) ? (float) $eq['net'] : null), 'keys' => array_keys($eq)];
}

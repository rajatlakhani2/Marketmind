<?php
// MarketMind AI — broker accounts that each user adds for themselves (several per user, several brokers).
// API secrets and daily session tokens are stored encrypted (see mm_encrypt in bootstrap.php).
// Today: ICICI Direct (Breeze). Zerodha, Groww, Upstox and Angel One plug in here later.

declare(strict_types=1);

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === realpath(__FILE__)) { http_response_code(404); exit; }

const MM_BROKERS = [
    'icici' => ['name' => 'ICICI Direct', 'login_url' => 'https://api.icicidirect.com/apiuser/login', 'api_url' => 'https://api.icicidirect.com/breezeapi/api/v1/'],
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

function mm_broker_public(array $a): array {
    $today = mm_ist_today();
    return [
        'id' => (int) $a['id'], 'broker' => $a['broker'], 'brokerName' => MM_BROKERS[$a['broker']]['name'] ?? $a['broker'],
        'label' => $a['label'], 'apiKeyEnd' => substr((string) $a['api_key'], -4),
        'connectedToday' => ($a['session_date'] ?? '') === $today && !empty($a['session_enc']),
        'brokerUser' => $a['broker_user'], 'lastError' => $a['last_error'], 'updatedAt' => $a['updated_at'],
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

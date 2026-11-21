<?php
// MarketMind AI — push notifications to the Android app through Firebase Cloud Messaging (HTTP v1).
//
// Needs the Firebase service-account key saved as fcm-service-account.json next to marketmind-config.php
// (outside public_html). Firebase console → Project settings → Service accounts → Generate new private key.
// Without that file nothing is sent and the app says so.
//
// Kinds a phone can switch on or off: ideas (morning swing buys), alerts (price alerts), events (results and
// corporate actions for watchlist stocks).

declare(strict_types=1);
if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === realpath(__FILE__)) { http_response_code(404); exit; }

const MM_PUSH_KINDS = ['ideas', 'alerts', 'events'];

function mm_push_account(): ?array {
    static $acc = false;
    if ($acc !== false) return $acc;
    $acc = null;
    $api = dirname(__DIR__);
    foreach ([dirname($api, 3), dirname($api, 2), dirname($api), $api] as $dir) {
        $f = $dir . '/fcm-service-account.json';
        if (is_file($f)) {
            $j = json_decode((string) file_get_contents($f), true);
            if (is_array($j) && !empty($j['private_key']) && !empty($j['client_email']) && !empty($j['project_id'])) { $acc = $j; break; }
        }
    }
    return $acc;
}
function mm_push_configured(): bool { return mm_push_account() !== null; }

function mm_b64url(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }

// OAuth access token for FCM, kept for 50 minutes
function mm_push_access_token(PDO $pdo): ?string {
    $acc = mm_push_account();
    if (!$acc) return null;
    $c = mm_get_meta($pdo, 'fcm_access');
    if ($c && ($c['exp'] ?? 0) > time() + 60 && ($c['who'] ?? '') === $acc['client_email']) return $c['tok'];
    $now = time(); $aud = $acc['token_uri'] ?? 'https://oauth2.googleapis.com/token';
    $jwt = mm_b64url(json_encode(['alg' => 'RS256', 'typ' => 'JWT'])) . '.' . mm_b64url(json_encode([
        'iss' => $acc['client_email'], 'scope' => 'https://www.googleapis.com/auth/firebase.messaging', 'aud' => $aud, 'iat' => $now, 'exp' => $now + 3600]));
    $key = openssl_pkey_get_private($acc['private_key']);
    if (!$key || !openssl_sign($jwt, $sig, $key, OPENSSL_ALGO_SHA256)) { error_log('MarketMind push: could not sign with the service-account key'); return null; }
    $jwt .= '.' . mm_b64url($sig);
    $ch = curl_init($aud);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query(['grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'assertion' => $jwt])]);
    $r = json_decode((string) curl_exec($ch), true); curl_close($ch);
    if (empty($r['access_token'])) { error_log('MarketMind push: Google refused the key: ' . json_encode($r)); return null; }
    mm_set_meta($pdo, 'fcm_access', ['tok' => $r['access_token'], 'exp' => $now + min(3000, (int) ($r['expires_in'] ?? 3000)), 'who' => $acc['client_email']]);
    return $r['access_token'];
}

// Sends to one phone; returns true when Firebase accepted it. Drops tokens Firebase says are gone.
function mm_push_send(PDO $pdo, string $token, string $title, string $body, array $data = []): bool {
    $acc = mm_push_account(); $at = mm_push_access_token($pdo);
    if (!$acc || !$at) return false;
    $msg = ['message' => [
        'token' => $token,
        'notification' => ['title' => mb_substr($title, 0, 80), 'body' => mb_substr($body, 0, 240)],
        'data' => array_map('strval', $data),
        'android' => ['priority' => 'high', 'notification' => ['channel_id' => 'market', 'color' => '#1f4e9e']],
    ]];
    $ch = curl_init('https://fcm.googleapis.com/v1/projects/' . rawurlencode($acc['project_id']) . '/messages:send');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode($msg),
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $at, 'Content-Type: application/json']]);
    $res = (string) curl_exec($ch); $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    if ($code === 200) return true;
    if ($code === 404 || ($code === 400 && str_contains($res, 'registration token')) || str_contains($res, 'UNREGISTERED')) {
        $pdo->prepare('DELETE FROM push_tokens WHERE token = ?')->execute([$token]);
    } else error_log("MarketMind push: HTTP $code $res");
    return false;
}

function mm_push_prefs(string $json): array {
    $p = json_decode($json, true);
    $out = [];
    foreach (MM_PUSH_KINDS as $k) $out[$k] = !is_array($p) || !array_key_exists($k, $p) ? true : (bool) $p[$k];
    return $out;
}

// Sends to every phone of one user that has this kind switched on; returns how many accepted it
function mm_push_user(PDO $pdo, int $uid, string $kind, string $title, string $body, array $data = []): int {
    if (!mm_push_configured()) return 0;
    $st = $pdo->prepare('SELECT token, prefs FROM push_tokens WHERE user_id = ?'); $st->execute([$uid]);
    $n = 0;
    foreach ($st->fetchAll() as $r) {
        if ($kind !== 'test' && !(mm_push_prefs((string) $r['prefs'])[$kind] ?? true)) continue;
        if (mm_push_send($pdo, (string) $r['token'], $title, $body, $data)) $n++;
    }
    return $n;
}

// Morning round, once a trading day from 8:45 am IST: swing buys from the overnight scan, and watchlist stocks
// with results or a corporate action today or tomorrow.
function mm_push_morning(PDO $pdo, bool $force = false): array {
    $ist = new DateTime('now', new DateTimeZone('Asia/Kolkata'));
    $today = $ist->format('Y-m-d');
    $meta = mm_get_meta($pdo, 'push_morning');
    if (!$force && (($meta['d'] ?? '') === $today)) return ['skipped' => 'already sent today'];
    if (!mm_push_configured()) return ['skipped' => 'no Firebase key'];
    mm_set_meta($pdo, 'push_morning', ['d' => $today]);
    $tomorrow = (clone $ist)->modify('+1 day')->format('Y-m-d');
    $users = $pdo->query('SELECT DISTINCT user_id FROM push_tokens')->fetchAll(PDO::FETCH_COLUMN);
    $sent = ['ideas' => 0, 'events' => 0];

    // 1. Trade ideas
    $f = dirname(__DIR__, 4) . '/marketmind-data/swing.json';
    $sw = is_file($f) ? json_decode((string) file_get_contents($f), true) : null;
    if (is_array($sw) && !empty($sw['signals']) && !empty($sw['date']) && strtotime($sw['date']) >= time() - 4 * 86400) {
        $syms = array_slice(array_map(fn($x) => (string) ($x['sym'] ?? ''), $sw['signals']), 0, 6);
        $n = count($sw['signals']);
        $title = $n === 1 ? '1 swing buy for today' : "$n swing buys for today";
        $body = implode(', ', array_filter($syms)) . ($n > 6 ? ' and more' : '') . '. Check the plan before the open; orders still need your approval.';
        foreach ($users as $uid) $sent['ideas'] += mm_push_user($pdo, (int) $uid, 'ideas', $title, $body, ['page' => 'ideas']);
    }

    // 2. Watchlist events (from the NSE calendar the Events page keeps; up to 2 days old)
    $cf = dirname(__DIR__) . '/.events-cache/' . md5('calendar') . '.php';
    $cal = null;
    if (is_file($cf) && time() - filemtime($cf) < 2 * 86400) { $raw = (string) file_get_contents($cf); $cal = json_decode(substr($raw, strpos($raw, "\n") + 1), true); }
    if (is_array($cal)) {
        $wl = $pdo->prepare('SELECT symbol FROM user_watchlist WHERE user_id = ?');
        foreach ($users as $uid) {
            $wl->execute([(int) $uid]); $mine = array_flip(array_map('strtoupper', $wl->fetchAll(PDO::FETCH_COLUMN)));
            if (!$mine) continue;
            $lines = [];
            foreach ($cal['meetings'] ?? [] as $m) if (isset($mine[strtoupper($m['symbol'])]) && ($m['date'] === $today || $m['date'] === $tomorrow))
                $lines[] = $m['symbol'] . ' ' . ($m['results'] ? 'results' : 'board meeting') . ($m['date'] === $today ? ' today' : ' tomorrow');
            foreach ($cal['actions'] ?? [] as $a) if (isset($mine[strtoupper($a['symbol'])]) && ($a['exDate'] === $today || $a['exDate'] === $tomorrow))
                $lines[] = $a['symbol'] . ' ex-' . strtolower($a['kind'] === 'Other' ? 'date' : $a['kind']) . ($a['exDate'] === $today ? ' today' : ' tomorrow');
            $lines = array_values(array_unique($lines));
            if (!$lines) continue;
            $title = count($lines) === 1 ? 'On your watchlist: ' . $lines[0] : count($lines) . ' events on your watchlist';
            $sent['events'] += mm_push_user($pdo, (int) $uid, 'events', $title, implode(' · ', array_slice($lines, 0, 6)), ['page' => 'corpactions']);
        }
    }
    return $sent;
}

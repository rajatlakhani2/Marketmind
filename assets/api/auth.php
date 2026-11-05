<?php
// MarketMind AI — sign-in, first-time admin setup, password change and per-user settings.
//
// GET  ?action=status           -> { configured, dbOk, needsSetup, loggedIn, user }
// POST ?action=setup            { setupKey, username, displayName, password }  (only while no users exist)
// POST ?action=login            { username, password, remember }
// POST ?action=logout
// POST ?action=change_password  { currentPassword, newPassword }
// GET  ?action=settings         -> { settings: { key: value } }
// POST ?action=save_setting     { key, value }   (value: any JSON, null deletes)
//
// POST requests must send the header  X-Requested-With: MarketMind

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';

$action = (string) ($_GET['action'] ?? '');

try {
    if ($action === 'status') {
        if (!mm_config()) mm_json(200, ['configured' => false, 'dbOk' => false, 'needsSetup' => false, 'loggedIn' => false]);
        $pdo = mm_db();
        $needsSetup = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() === 0;
        $u = $needsSetup ? null : mm_current_user();
        mm_json(200, ['configured' => true, 'dbOk' => true, 'needsSetup' => $needsSetup, 'loggedIn' => (bool) $u, 'user' => $u ? mm_public_user($u) : null]);
    }

    if ($action === 'setup') {
        $body = mm_require_post();
        $pdo = mm_db();
        if ((int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0) mm_json(409, ['error' => 'Setup is already done. Sign in instead.']);
        $key = (string) (mm_config()['setup_key'] ?? '');
        if ($key === '' || strpos($key, 'PASTE') !== false) mm_json(503, ['error' => 'Set a setup_key in marketmind-config.php first']);
        mm_check_rate_limit('__setup__');
        if (!hash_equals($key, mm_str($body, 'setupKey', 500))) {
            mm_record_attempt('__setup__', false);
            mm_json(403, ['error' => 'Setup key is not correct']);
        }
        $username = mm_check_username(mm_str($body, 'username', 50));
        $password = (string) ($body['password'] ?? '');
        mm_check_password($password);
        $pdo->prepare('INSERT INTO users (username, display_name, password_hash, role, is_active, must_change_password, created_at, password_changed_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)')
            ->execute([$username, mm_str($body, 'displayName', 100), password_hash($password, PASSWORD_DEFAULT), 'admin', mm_now(), mm_now()]);
        $id = (int) $pdo->lastInsertId();
        mm_start_session($id, true);
        $pdo->prepare('UPDATE users SET last_login_at = ? WHERE id = ?')->execute([mm_now(), $id]);
        mm_json(200, ['ok' => true, 'user' => mm_public_user(mm_user_by_id($id))]);
    }

    if ($action === 'login') {
        $body = mm_require_post();
        $pdo = mm_db();
        $username = strtolower(mm_str($body, 'username', 50));
        $password = (string) ($body['password'] ?? '');
        mm_check_rate_limit($username);
        $st = $pdo->prepare('SELECT * FROM users WHERE username = ?');
        $st->execute([$username]);
        $u = $st->fetch();
        // Always run a hash check so response time doesn't reveal which usernames exist
        $ok = password_verify($password, $u['password_hash'] ?? '$2y$10$zCHIjrnBZb37DhsduoigquQv6cNi8rlJk1QDDIoFxCu8nOJidYz4u');
        if (!$u || !$ok) {
            mm_record_attempt($username, false);
            mm_json(401, ['error' => 'Wrong username or password']);
        }
        if (!(int) $u['is_active']) {
            mm_record_attempt($username, false);
            mm_json(403, ['error' => 'This account is switched off. Ask the admin.']);
        }
        mm_record_attempt($username, true);
        if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) {
            $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $u['id']]);
        }
        mm_start_session((int) $u['id'], !empty($body['remember']));
        $pdo->prepare('UPDATE users SET last_login_at = ? WHERE id = ?')->execute([mm_now(), $u['id']]);
        mm_json(200, ['ok' => true, 'user' => mm_public_user(mm_user_by_id((int) $u['id']))]);
    }

    if ($action === 'logout') {
        mm_require_post();
        mm_end_session();
        mm_json(200, ['ok' => true]);
    }

    if ($action === 'change_password') {
        $body = mm_require_post();
        $u = mm_require_user(true);
        $current = (string) ($body['currentPassword'] ?? '');
        $new = (string) ($body['newPassword'] ?? '');
        if (!password_verify($current, $u['password_hash'])) mm_json(400, ['error' => 'Current password is not correct']);
        mm_check_password($new);
        if ($new === $current) mm_json(400, ['error' => 'Choose a different password from the current one']);
        $pdo = mm_db();
        $pdo->prepare('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?')
            ->execute([password_hash($new, PASSWORD_DEFAULT), mm_now(), $u['id']]);
        // Sign out every other device; keep this one
        $token = hash('sha256', (string) ($_COOKIE[MM_SESSION_COOKIE] ?? ''));
        $pdo->prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')->execute([$u['id'], $token]);
        mm_json(200, ['ok' => true, 'user' => mm_public_user(mm_user_by_id((int) $u['id']))]);
    }

    if ($action === 'settings') {
        $u = mm_require_user();
        $st = mm_db()->prepare('SELECT setting_key, value_json FROM user_settings WHERE user_id = ?');
        $st->execute([$u['id']]);
        $out = [];
        foreach ($st->fetchAll() as $r) $out[$r['setting_key']] = json_decode($r['value_json'], true);
        mm_json(200, ['settings' => (object) $out]);
    }

    if ($action === 'save_setting') {
        $body = mm_require_post();
        $u = mm_require_user();
        $key = mm_str($body, 'key', 64);
        if (!preg_match('/^[a-z0-9_]{1,64}$/', $key)) mm_json(400, ['error' => 'Invalid setting name']);
        $pdo = mm_db();
        $pdo->prepare('DELETE FROM user_settings WHERE user_id = ? AND setting_key = ?')->execute([$u['id'], $key]);
        if (array_key_exists('value', $body) && $body['value'] !== null) {
            $json = json_encode($body['value']);
            if (strlen($json) > 64 * 1024) mm_json(413, ['error' => 'Setting is too large']);
            $pdo->prepare('INSERT INTO user_settings (user_id, setting_key, value_json, updated_at) VALUES (?, ?, ?, ?)')
                ->execute([$u['id'], $key, $json, mm_now()]);
        }
        mm_json(200, ['ok' => true]);
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind auth error: ' . $e->getMessage());
    mm_json(500, ['error' => 'Server error. Check the PHP error log on the host.']);
}

// ---------- helpers ----------
function mm_user_by_id(int $id): array {
    $st = mm_db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$id]);
    return $st->fetch() ?: [];
}

function mm_record_attempt(string $username, bool $success): void {
    $pdo = mm_db();
    $pdo->prepare('INSERT INTO login_attempts (username, ip, attempted_at, success) VALUES (?, ?, ?, ?)')
        ->execute([substr($username, 0, 50), mm_ip(), mm_now(), $success ? 1 : 0]);
    if (random_int(1, 50) === 1) $pdo->prepare('DELETE FROM login_attempts WHERE attempted_at < ?')->execute([gmdate('Y-m-d H:i:s', time() - 7 * 86400)]);
}

// At most 8 failed tries per username, or 20 per IP address, in 15 minutes.
function mm_check_rate_limit(string $username): void {
    $since = gmdate('Y-m-d H:i:s', time() - 15 * 60);
    $pdo = mm_db();
    $st = $pdo->prepare('SELECT COUNT(*) FROM login_attempts WHERE success = 0 AND attempted_at > ? AND username = ?');
    $st->execute([$since, $username]);
    $byUser = (int) $st->fetchColumn();
    $st = $pdo->prepare('SELECT COUNT(*) FROM login_attempts WHERE success = 0 AND attempted_at > ? AND ip = ?');
    $st->execute([$since, mm_ip()]);
    if ($byUser >= 8 || (int) $st->fetchColumn() >= 20) {
        mm_json(429, ['error' => 'Too many wrong attempts. Wait 15 minutes and try again.']);
    }
}

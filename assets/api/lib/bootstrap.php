<?php
// MarketMind AI — shared server code: config, database, migrations, login sessions.
//
// Included by the api/*.php endpoints. Never served directly (api/lib/.htaccess
// blocks it, and the guard below stops it if that file is missing).

declare(strict_types=1);

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === realpath(__FILE__)) { http_response_code(404); exit; }

const MM_SESSION_COOKIE = 'mm_session';
const MM_ROLES = ['admin', 'user'];

// ---------- responses ----------
function mm_json(int $code, array $data): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data);
    exit;
}

function mm_now(): string { return gmdate('Y-m-d H:i:s'); } // stored as UTC

// ---------- config ----------
// marketmind-config.php is looked for above public_html first, then next to the app, then in api/.
function mm_config(): ?array {
    static $cfg = false;
    if ($cfg !== false) return $cfg;
    $cfg = null;
    $api = dirname(__DIR__);
    foreach ([dirname($api, 3), dirname($api, 2), dirname($api), $api] as $dir) {
        $f = $dir . '/marketmind-config.php';
        if (is_file($f)) {
            $c = include $f;
            if (is_array($c) && !empty($c['db'])) { $cfg = $c + ['session_days' => 30]; break; }
        }
    }
    return $cfg;
}

// ---------- database ----------
function mm_db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $cfg = mm_config();
    if (!$cfg) mm_json(503, ['error' => 'MarketMind is not set up yet: marketmind-config.php is missing', 'configured' => false]);
    $db = $cfg['db'];
    try {
        if (!empty($db['dsn'])) { // e.g. sqlite for local testing
            $pdo = new PDO($db['dsn'], $db['user'] ?? null, $db['pass'] ?? null);
        } else {
            $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $db['host'] ?? 'localhost', (int) ($db['port'] ?? 3306), $db['name'] ?? '');
            $pdo = new PDO($dsn, $db['user'] ?? '', $db['pass'] ?? '');
        }
    } catch (PDOException $e) {
        error_log('MarketMind DB connect failed: ' . $e->getMessage());
        mm_json(503, ['error' => 'Could not connect to the database. Check the db settings in marketmind-config.php.', 'configured' => true, 'dbOk' => false]);
    }
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, false);
    mm_migrate($pdo);
    return $pdo;
}

function mm_is_sqlite(PDO $pdo): bool { return $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite'; }

// Tables are written for MySQL; this turns them into SQLite for local testing.
function mm_ddl(PDO $pdo, string $sql): string {
    if (!mm_is_sqlite($pdo)) return $sql;
    $sql = str_replace('INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY', 'INTEGER PRIMARY KEY AUTOINCREMENT', $sql);
    $sql = preg_replace('/\)\s*ENGINE=[^;]*$/', ')', $sql);
    return str_replace('INT UNSIGNED', 'INTEGER', $sql);
}

// Schema changes, applied once each, in order. Later features add entries here.
function mm_migrations(): array {
    $t = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    return [
        1 => [
            "CREATE TABLE users (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                display_name VARCHAR(100) NOT NULL DEFAULT '',
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(10) NOT NULL DEFAULT 'user',
                is_active TINYINT NOT NULL DEFAULT 1,
                must_change_password TINYINT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                created_by INT UNSIGNED NULL,
                last_login_at DATETIME NULL,
                password_changed_at DATETIME NULL
            )$t",
            "CREATE UNIQUE INDEX ux_users_username ON users (username)",
            "CREATE TABLE sessions (
                token_hash CHAR(64) NOT NULL PRIMARY KEY,
                user_id INT UNSIGNED NOT NULL,
                created_at DATETIME NOT NULL,
                expires_at DATETIME NOT NULL,
                last_seen_at DATETIME NOT NULL,
                ip VARCHAR(45) NOT NULL DEFAULT '',
                user_agent VARCHAR(255) NOT NULL DEFAULT '',
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )$t",
            "CREATE INDEX ix_sessions_user ON sessions (user_id)",
            "CREATE TABLE login_attempts (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                ip VARCHAR(45) NOT NULL,
                attempted_at DATETIME NOT NULL,
                success TINYINT NOT NULL DEFAULT 0
            )$t",
            "CREATE INDEX ix_login_attempts_time ON login_attempts (attempted_at)",
            "CREATE TABLE user_settings (
                user_id INT UNSIGNED NOT NULL,
                setting_key VARCHAR(64) NOT NULL,
                value_json MEDIUMTEXT NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (user_id, setting_key),
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )$t",
        ],
        // Full NSE + BSE equity list, and app-wide state
        2 => [
            "CREATE TABLE app_meta (
                meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
                value_json MEDIUMTEXT NOT NULL,
                updated_at DATETIME NOT NULL
            )$t",
            "CREATE TABLE stocks (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                exchange VARCHAR(3) NOT NULL,
                symbol VARCHAR(20) NOT NULL,
                name VARCHAR(150) NOT NULL DEFAULT '',
                isin VARCHAR(12) NOT NULL DEFAULT '',
                series VARCHAR(5) NOT NULL DEFAULT '',
                isec_code VARCHAR(20) NOT NULL DEFAULT '',
                is_active TINYINT NOT NULL DEFAULT 1,
                updated_at DATETIME NOT NULL
            )$t",
            "CREATE UNIQUE INDEX ux_stocks_exch_symbol ON stocks (exchange, symbol)",
            "CREATE INDEX ix_stocks_isin ON stocks (isin)",
        ],
        // MindGuru: every projection, its real outcome, and what was learned from them
        3 => [
            "CREATE TABLE predictions (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                source VARCHAR(10) NOT NULL DEFAULT 'live',
                user_id INT UNSIGNED NULL,
                symbol VARCHAR(20) NOT NULL,
                name VARCHAR(150) NOT NULL DEFAULT '',
                kind VARCHAR(10) NOT NULL,
                strategy_id VARCHAR(64) NOT NULL,
                strategy_name VARCHAR(120) NOT NULL DEFAULT '',
                side VARCHAR(5) NOT NULL,
                signal_date DATE NOT NULL,
                price_at_signal DECIMAL(14,4) NOT NULL,
                entry DECIMAL(14,4) NOT NULL,
                stop DECIMAL(14,4) NOT NULL,
                target DECIMAL(14,4) NOT NULL,
                entry_type VARCHAR(10) NOT NULL,
                trend VARCHAR(10) NOT NULL DEFAULT '',
                ks_score DECIMAL(4,1) NULL,
                context_json TEXT NULL,
                status VARCHAR(12) NOT NULL DEFAULT 'pending',
                entered_date DATE NULL,
                exit_date DATE NULL,
                exit_price DECIMAL(14,4) NULL,
                r_multiple DECIMAL(8,3) NULL,
                mfe_r DECIMAL(8,3) NULL,
                mae_r DECIMAL(8,3) NULL,
                days_held INT NULL,
                created_at DATETIME NOT NULL,
                checked_at DATETIME NULL,
                resolved_at DATETIME NULL
            )$t",
            "CREATE UNIQUE INDEX ux_predictions_key ON predictions (symbol, kind, strategy_id, signal_date, source)",
            "CREATE INDEX ix_predictions_status ON predictions (status)",
            "CREATE INDEX ix_predictions_strategy ON predictions (strategy_id, status)",
            "CREATE TABLE strategy_stats (
                strategy_id VARCHAR(64) NOT NULL,
                bucket VARCHAR(20) NOT NULL,
                strategy_name VARCHAR(120) NOT NULL DEFAULT '',
                trades INT NOT NULL DEFAULT 0,
                wins INT NOT NULL DEFAULT 0,
                losses INT NOT NULL DEFAULT 0,
                expired INT NOT NULL DEFAULT 0,
                no_entry INT NOT NULL DEFAULT 0,
                win_rate DECIMAL(6,4) NOT NULL DEFAULT 0,
                avg_r DECIMAL(8,3) NOT NULL DEFAULT 0,
                weight DECIMAL(6,3) NOT NULL DEFAULT 1,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (strategy_id, bucket)
            )$t",
            "CREATE TABLE mindguru_log (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                generation INT NOT NULL,
                created_at DATETIME NOT NULL,
                outcomes INT NOT NULL DEFAULT 0,
                notes_json MEDIUMTEXT NOT NULL
            )$t",
        ],
        // Each user's own knowledge (uploaded books, extracted concepts and strategies)
        4 => [
            "CREATE TABLE knowledge_items (
                user_id INT UNSIGNED NOT NULL,
                store VARCHAR(20) NOT NULL,
                item_id VARCHAR(100) NOT NULL,
                data_json LONGTEXT NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (user_id, store, item_id)
            )$t",
            "CREATE INDEX ix_knowledge_updated ON knowledge_items (user_id, updated_at)",
        ],
    ];
}

function mm_migrate(PDO $pdo): void {
    $pdo->exec(mm_ddl($pdo, "CREATE TABLE IF NOT EXISTS schema_migrations (version INT UNSIGNED NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL) ENGINE=InnoDB"));
    $current = (int) $pdo->query('SELECT COALESCE(MAX(version), 0) FROM schema_migrations')->fetchColumn();
    foreach (mm_migrations() as $version => $statements) {
        if ($version <= $current) continue;
        // MySQL commits table changes immediately, so each statement is checked rather than wrapped in a transaction.
        foreach ($statements as $sql) {
            try { $pdo->exec(mm_ddl($pdo, $sql)); }
            catch (PDOException $e) {
                if (!preg_match('/already exists|Duplicate key name/i', $e->getMessage())) throw $e;
            }
        }
        $pdo->prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')->execute([$version, mm_now()]);
    }
}

// ---------- request helpers ----------
function mm_ip(): string { return substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45); }

function mm_https(): bool {
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || ((int) ($_SERVER['SERVER_PORT'] ?? 0) === 443);
}

// State-changing calls must be POST with the app's custom header. Other sites can't send
// that header without a CORS preflight, which this server never approves (CSRF protection).
function mm_require_post(int $maxBytes = 512 * 1024): array {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') mm_json(405, ['error' => 'Use POST']);
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'MarketMind') mm_json(403, ['error' => 'Missing request header']);
    $raw = (string) file_get_contents('php://input');
    if (strlen($raw) > $maxBytes) mm_json(413, ['error' => 'Request too large']);
    $body = $raw === '' ? [] : json_decode($raw, true);
    if (!is_array($body)) mm_json(400, ['error' => 'Invalid JSON']);
    return $body;
}

function mm_str(array $body, string $key, int $max = 255): string {
    $v = $body[$key] ?? '';
    if (!is_string($v)) mm_json(400, ['error' => "Invalid $key"]);
    $v = trim($v);
    if (strlen($v) > $max) mm_json(400, ['error' => "$key is too long"]);
    return $v;
}

// ---------- passwords and usernames ----------
function mm_check_username(string $u): string {
    $u = strtolower($u);
    if (!preg_match('/^[a-z0-9][a-z0-9._-]{2,49}$/', $u)) {
        mm_json(400, ['error' => 'Username must be 3–50 characters: letters, numbers, dot, dash or underscore']);
    }
    return $u;
}

function mm_check_password(string $p): void {
    if (strlen($p) < 8) mm_json(400, ['error' => 'Password must be at least 8 characters']);
    if (strlen($p) > 200) mm_json(400, ['error' => 'Password is too long']);
}

// ---------- login sessions ----------
function mm_set_cookie(string $value, int $expires): void {
    setcookie(MM_SESSION_COOKIE, $value, [
        'expires' => $expires, 'path' => '/', 'secure' => mm_https(), 'httponly' => true, 'samesite' => 'Lax',
    ]);
}

function mm_start_session(int $userId, bool $remember): void {
    $pdo = mm_db();
    $token = bin2hex(random_bytes(32));
    $days = $remember ? max(1, (int) mm_config()['session_days']) : 1;
    $expires = time() + $days * 86400;
    $pdo->prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
        ->execute([hash('sha256', $token), $userId, mm_now(), gmdate('Y-m-d H:i:s', $expires), mm_now(), mm_ip(), substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255)]);
    mm_set_cookie($token, $remember ? $expires : 0);
    // Tidy up expired sessions now and then
    if (random_int(1, 20) === 1) $pdo->prepare('DELETE FROM sessions WHERE expires_at < ?')->execute([mm_now()]);
}

function mm_end_session(): void {
    $token = (string) ($_COOKIE[MM_SESSION_COOKIE] ?? '');
    if ($token !== '') mm_db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
    mm_set_cookie('', time() - 3600);
}

// The signed-in user, or null.
function mm_current_user(): ?array {
    static $user = false;
    if ($user !== false) return $user;
    $user = null;
    $token = (string) ($_COOKIE[MM_SESSION_COOKIE] ?? '');
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) return null;
    $pdo = mm_db();
    $st = $pdo->prepare('SELECT u.*, s.last_seen_at AS session_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?');
    $st->execute([hash('sha256', $token), mm_now()]);
    $row = $st->fetch();
    if (!$row || !(int) $row['is_active']) return null;
    if (strtotime($row['session_seen'] . ' UTC') < time() - 300) {
        $pdo->prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')->execute([mm_now(), hash('sha256', $token)]);
    }
    unset($row['session_seen']);
    return $user = $row;
}

function mm_public_user(array $u): array {
    return [
        'id' => (int) $u['id'], 'username' => $u['username'], 'displayName' => $u['display_name'] ?: $u['username'],
        'role' => $u['role'], 'isActive' => (bool) (int) $u['is_active'],
        'mustChangePassword' => (bool) (int) $u['must_change_password'],
        'createdAt' => $u['created_at'], 'lastLoginAt' => $u['last_login_at'],
    ];
}

// Stop unless someone is signed in. Endpoints call this first.
function mm_require_user(bool $allowPasswordChangePending = false): array {
    $u = mm_current_user();
    if (!$u) mm_json(401, ['error' => 'Please sign in to MarketMind', 'authRequired' => true]);
    if (!$allowPasswordChangePending && (int) $u['must_change_password']) {
        mm_json(403, ['error' => 'Please set a new password first', 'passwordChangeRequired' => true]);
    }
    return $u;
}

function mm_require_admin(): array {
    $u = mm_require_user();
    if ($u['role'] !== 'admin') mm_json(403, ['error' => 'Only an admin can do this']);
    return $u;
}

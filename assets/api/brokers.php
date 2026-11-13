<?php
// MarketMind AI — each user's own broker accounts.
//
// GET  ?action=list                    -> { accounts: [...], brokers: {...}, main: {...}|null (admin: the server-config ICICI account) }
// POST ?action=add      { broker, label, apiKey, secret }
// POST ?action=update   { id, label?, apiKey?, secret? }   (blank secret = keep the saved one)
// POST ?action=delete   { id }
// GET  ?action=login&id=N   -> redirects to the broker's login page; the broker sends you back to breeze.php
// POST ?action=logout   { id }   (forgets today's session)
// GET  ?action=holdings&id=N  -> holdings and today's positions (read-only)
// GET  ?action=funds&id=N     -> cash: bank balance, allocated to equity / F&O, free
//
// Every account belongs to the signed-in user; nobody else, the admin included, can use it.
// POST ?action=share {id, usernames: "a,b"} lets those users VIEW its holdings and cash (never log in or trade).
// POST requests must send the header  X-Requested-With: MarketMind

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/brokers.php';

$action = (string) ($_GET['action'] ?? '');

try {
    $u = mm_require_user();
    $uid = (int) $u['id'];
    $pdo = mm_db();

    if ($action === 'list') {
        $st = $pdo->prepare('SELECT * FROM broker_accounts WHERE user_id = ? ORDER BY id');
        $st->execute([$uid]);
        $main = null;
        if ($u['role'] === 'admin') {
            // The server-config ICICI account (breeze-config.php) keeps its session in a guarded file
            $raw = is_file(__DIR__ . '/.breeze-session.php') ? (string) file_get_contents(__DIR__ . '/.breeze-session.php') : '';
            $sess = json_decode((string) preg_replace('/^<\?php exit; \?>\n/', '', $raw), true);
            $main = ['connectedToday' => is_array($sess) && ($sess['date'] ?? '') === mm_ist_today(), 'brokerUser' => is_array($sess) ? ($sess['user'] ?? '') : ''];
        }
        $brokers = [];
        foreach (MM_BROKERS as $k => $b) $brokers[$k] = $b['name'];
        // Accounts other people shared with me (read-only)
        $sh = [];
        $q = $pdo->prepare("SELECT b.*, u.display_name AS owner_name, u.username AS owner_user FROM broker_accounts b JOIN users u ON u.id = b.user_id WHERE b.user_id <> ? AND b.shared_with <> ''");
        $q->execute([$uid]);
        foreach ($q->fetchAll() as $a) {
            if (in_array(strtolower($u['username']), array_map('trim', explode(',', strtolower((string) $a['shared_with']))), true)) $sh[] = mm_broker_public($a) + ['owner' => $a['owner_name'] ?: $a['owner_user'], 'sharedWith' => ''];
        }
        mm_json(200, ['accounts' => array_map('mm_broker_public', $st->fetchAll()), 'shared' => $sh, 'brokers' => $brokers, 'main' => $main]);
    }

    if ($action === 'add') {
        $body = mm_require_post();
        $broker = mm_str($body, 'broker', 20);
        if (!isset(MM_BROKERS[$broker])) mm_json(400, ['error' => 'That broker is not supported yet']);
        $st = $pdo->prepare('SELECT COUNT(*) FROM broker_accounts WHERE user_id = ?');
        $st->execute([$uid]);
        if ((int) $st->fetchColumn() >= MM_MAX_BROKER_ACCOUNTS) mm_json(400, ['error' => 'You can add up to ' . MM_MAX_BROKER_ACCOUNTS . ' broker accounts']);
        [$key, $secret] = [trim(mm_str($body, 'apiKey', 120)), trim((string) ($body['secret'] ?? ''))];
        if (!preg_match('/^[\x21-\x7e]{6,120}$/', $key)) mm_json(400, ['error' => 'Paste the API key exactly as the broker shows it']);
        if (!preg_match('/^[\x21-\x7e]{6,200}$/', $secret)) mm_json(400, ['error' => 'Paste the API secret exactly as the broker shows it']);
        $label = trim(mm_str($body, 'label', 60)) ?: (MM_BROKERS[$broker]['name'] . ' ' . substr($key, -4));
        $pdo->prepare('INSERT INTO broker_accounts (user_id, broker, label, api_key, secret_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            ->execute([$uid, $broker, $label, $key, mm_encrypt($secret), mm_now(), mm_now()]);
        mm_json(200, ['ok' => true, 'account' => mm_broker_public(mm_broker_account($uid, (int) $pdo->lastInsertId()))]);
    }

    if ($action === 'update') {
        $body = mm_require_post();
        $a = mm_broker_account($uid, (int) ($body['id'] ?? 0));
        $label = array_key_exists('label', $body) ? (trim(mm_str($body, 'label', 60)) ?: $a['label']) : $a['label'];
        $key = array_key_exists('apiKey', $body) && trim((string) $body['apiKey']) !== '' ? trim(mm_str($body, 'apiKey', 120)) : $a['api_key'];
        if (!preg_match('/^[\x21-\x7e]{6,120}$/', $key)) mm_json(400, ['error' => 'Paste the API key exactly as the broker shows it']);
        $secret = trim((string) ($body['secret'] ?? ''));
        if ($secret !== '' && !preg_match('/^[\x21-\x7e]{6,200}$/', $secret)) mm_json(400, ['error' => 'Paste the API secret exactly as the broker shows it']);
        $changedCreds = $key !== $a['api_key'] || $secret !== '';
        $pdo->prepare('UPDATE broker_accounts SET label = ?, api_key = ?, secret_enc = ?, session_enc = ?, session_date = ?, updated_at = ? WHERE id = ?')
            ->execute([$label, $key, $secret !== '' ? mm_encrypt($secret) : $a['secret_enc'], $changedCreds ? null : $a['session_enc'], $changedCreds ? null : $a['session_date'], mm_now(), $a['id']]);
        mm_json(200, ['ok' => true, 'account' => mm_broker_public(mm_broker_account($uid, (int) $a['id']))]);
    }

    if ($action === 'delete') {
        $body = mm_require_post();
        $a = mm_broker_account($uid, (int) ($body['id'] ?? 0));
        $pdo->prepare('DELETE FROM broker_accounts WHERE id = ?')->execute([$a['id']]);
        mm_json(200, ['ok' => true]);
    }

    if ($action === 'login') {
        $a = mm_broker_account($uid, (int) ($_GET['id'] ?? 0));
        mm_broker_set_pending($uid, (int) $a['id']); // breeze.php's callback finishes the login for this account
        header('Location: ' . MM_BROKERS[$a['broker']]['login_url'] . '?api_key=' . rawurlencode($a['api_key']));
        exit;
    }

    if ($action === 'logout') {
        $body = mm_require_post();
        $a = mm_broker_account($uid, (int) ($body['id'] ?? 0));
        $pdo->prepare('UPDATE broker_accounts SET session_enc = NULL, session_date = NULL, updated_at = ? WHERE id = ?')->execute([mm_now(), $a['id']]);
        mm_json(200, ['ok' => true]);
    }

    if ($action === 'share') {
        $body = mm_require_post();
        $a = mm_broker_account($uid, (int) ($body['id'] ?? 0));
        $names = array_values(array_unique(array_filter(array_map(fn($x) => strtolower(trim($x)), explode(',', (string) ($body['usernames'] ?? ''))))));
        foreach ($names as $n) {
            $c = $pdo->prepare("SELECT COUNT(*) FROM users WHERE username = ? AND is_active = 1"); $c->execute([$n]);
            if (!(int) $c->fetchColumn()) mm_json(400, ['error' => "No active MarketMind user called \"$n\""]);
        }
        $pdo->prepare('UPDATE broker_accounts SET shared_with = ?, updated_at = ? WHERE id = ?')->execute([substr(implode(',', $names), 0, 250), mm_now(), $a['id']]);
        mm_json(200, ['ok' => true, 'account' => mm_broker_public(mm_broker_account($uid, (int) $a['id']))]);
    }

    if ($action === 'funds') {
        $a = mm_broker_viewable($u, (int) ($_GET['id'] ?? 0));
        mm_json(200, mm_icici_funds($a) + ['account' => mm_broker_public($a)]);
    }

    if ($action === 'holdings') {
        $a = mm_broker_viewable($u, (int) ($_GET['id'] ?? 0));
        $out = mm_icici_holdings($a);
        $out['account'] = mm_broker_public($a);
        mm_json(200, $out);
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind brokers error: ' . $e->getMessage());
    mm_json(502, ['error' => $e->getMessage()]);
}

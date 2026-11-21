<?php
// MarketMind AI — phones that get push notifications.
// GET  ?action=status                       -> { devices, server, prefs }
// POST ?action=register   { token, prefs, platform }
// POST ?action=prefs      { prefs: { ideas, alerts, events } }   (all of your phones)
// POST ?action=unregister { token }
// POST ?action=test                         -> { sent, note }
// POST ?action=morning                      (admin) send today's morning round now
declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/stocks.php';
require __DIR__ . '/lib/push.php';

$action = (string) ($_GET['action'] ?? '');
try {
    $u = mm_require_user(); $uid = (int) $u['id']; $pdo = mm_db();
    $cleanPrefs = function ($p): string {
        $out = [];
        foreach (MM_PUSH_KINDS as $k) $out[$k] = is_array($p) && array_key_exists($k, $p) ? (bool) $p[$k] : true;
        return json_encode($out);
    };
    if ($action === 'status') {
        $st = $pdo->prepare('SELECT prefs FROM push_tokens WHERE user_id = ? ORDER BY last_seen DESC'); $st->execute([$uid]);
        $rows = $st->fetchAll();
        mm_json(200, ['devices' => count($rows), 'server' => mm_push_configured(), 'prefs' => $rows ? mm_push_prefs((string) $rows[0]['prefs']) : null]);
    }
    $body = mm_require_post();
    if ($action === 'register') {
        $tok = trim(mm_str($body, 'token', 255));
        if (strlen($tok) < 20) mm_json(400, ['error' => 'Bad token']);
        $plat = preg_replace('/[^a-z]/', '', strtolower(mm_str($body, 'platform', 12))) ?: 'android';
        $prefs = $cleanPrefs($body['prefs'] ?? null);
        $pdo->prepare('DELETE FROM push_tokens WHERE token = ?')->execute([$tok]); // a phone moves to whoever signed in last
        $pdo->prepare('INSERT INTO push_tokens (user_id, token, platform, prefs, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$uid, $tok, $plat, $prefs, mm_now(), mm_now()]);
        mm_json(200, ['ok' => true, 'server' => mm_push_configured()]);
    }
    if ($action === 'prefs') {
        $pdo->prepare('UPDATE push_tokens SET prefs = ? WHERE user_id = ?')->execute([$cleanPrefs($body['prefs'] ?? null), $uid]);
        mm_json(200, ['ok' => true]);
    }
    if ($action === 'unregister') {
        $tok = trim(mm_str($body, 'token', 255));
        $pdo->prepare('DELETE FROM push_tokens WHERE user_id = ? AND token = ?')->execute([$uid, $tok]);
        mm_json(200, ['ok' => true]);
    }
    if ($action === 'test') {
        if (!mm_push_configured()) mm_json(200, ['sent' => 0, 'note' => 'The server does not have its Firebase key yet, so nothing can be sent.']);
        $n = mm_push_user($pdo, $uid, 'test', 'MarketMind test', 'Notifications are working on this phone.', ['page' => 'dashboard']);
        mm_json(200, ['sent' => $n, 'note' => $n ? '' : 'No phone accepted it. Turn notifications off and on again in the app.']);
    }
    if ($action === 'morning') {
        if (($u['role'] ?? '') !== 'admin') mm_json(403, ['error' => 'Admins only']);
        mm_json(200, mm_push_morning($pdo, true));
    }
    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind push error: ' . $e->getMessage());
    mm_json(500, ['error' => 'Server error']);
}

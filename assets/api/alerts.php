<?php
// MarketMind AI — your price and indicator alerts.
// GET  ?action=list                 -> { alerts: [...], kinds: {...} }
// POST ?action=add    { symbol, kind, value }
// POST ?action=delete { id }
// POST ?action=seen                 (marks your fired alerts as read)
// GET  ?action=check                -> { fired: [your alerts that fired and are unread] }; runs the check at most once a minute
declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/stocks.php';
require __DIR__ . '/lib/alerts.php';

$action = (string) ($_GET['action'] ?? '');
try {
    $u = mm_require_user(); $uid = (int) $u['id']; $pdo = mm_db();
    if ($action === 'list') {
        $st = $pdo->prepare('SELECT id, symbol, kind, value, active, seen, message, created_at, triggered_at FROM price_alerts WHERE user_id = ? ORDER BY active DESC, id DESC LIMIT 100');
        $st->execute([$uid]);
        mm_json(200, ['alerts' => $st->fetchAll(), 'kinds' => MM_ALERT_KINDS]);
    }
    if ($action === 'check') {
        $last = mm_get_meta($pdo, 'alerts_checked');
        if (!$last || ($last['t'] ?? 0) < time() - 60) { mm_set_meta($pdo, 'alerts_checked', ['t' => time()]); mm_alerts_check($pdo); }
        $st = $pdo->prepare('SELECT id, symbol, message, triggered_at FROM price_alerts WHERE user_id = ? AND active = 0 AND seen = 0 ORDER BY triggered_at DESC');
        $st->execute([$uid]);
        mm_json(200, ['fired' => $st->fetchAll()]);
    }
    $body = mm_require_post();
    if ($action === 'add') {
        $sym = strtoupper(trim(mm_str($body, 'symbol', 20)));
        $kind = mm_str($body, 'kind', 12);
        if (!preg_match('/^[A-Z0-9&\-]{1,20}$/', $sym)) mm_json(400, ['error' => 'Invalid symbol']);
        if (!isset(MM_ALERT_KINDS[$kind])) mm_json(400, ['error' => 'Unknown alert type']);
        $val = in_array($kind, ['ma200_up', 'ma200_down'], true) ? null : (float) ($body['value'] ?? 0);
        if ($val !== null && $val <= 0) mm_json(400, ['error' => 'Enter a value above zero']);
        $st = $pdo->prepare('SELECT COUNT(*) FROM price_alerts WHERE user_id = ? AND active = 1'); $st->execute([$uid]);
        if ((int) $st->fetchColumn() >= 50) mm_json(400, ['error' => 'You can have up to 50 active alerts']);
        $pdo->prepare('INSERT INTO price_alerts (user_id, symbol, kind, value, created_at) VALUES (?, ?, ?, ?, ?)')->execute([$uid, $sym, $kind, $val, mm_now()]);
        mm_json(200, ['ok' => true]);
    }
    if ($action === 'delete') { $pdo->prepare('DELETE FROM price_alerts WHERE id = ? AND user_id = ?')->execute([(int) ($body['id'] ?? 0), $uid]); mm_json(200, ['ok' => true]); }
    if ($action === 'seen') { $pdo->prepare('UPDATE price_alerts SET seen = 1 WHERE user_id = ? AND active = 0')->execute([$uid]); mm_json(200, ['ok' => true]); }
    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind alerts error: ' . $e->getMessage());
    mm_json(500, ['error' => 'Server error. Check the PHP error log on the host.']);
}

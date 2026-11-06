<?php
// MarketMind AI — personal watchlist (each signed-in user has their own).
//
// GET  ?action=list                 -> { items: [{ id, symbol, name, added_at }] }
// POST ?action=add    {symbol}      -> adds (name looked up from the stock list), returns items
// POST ?action=remove {id}          -> returns items

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';

const WATCH_MAX = 30;

function items(PDO $pdo, int $uid): array {
    $st = $pdo->prepare('SELECT id, symbol, name, added_at FROM user_watchlist WHERE user_id = ? ORDER BY added_at, id');
    $st->execute([$uid]);
    return $st->fetchAll();
}

$action = (string) ($_GET['action'] ?? '');
try {
    $user = mm_require_user();
    $uid = (int) $user['id'];
    $pdo = mm_db();

    if ($action === 'list') mm_json(200, ['items' => items($pdo, $uid), 'max' => WATCH_MAX]);

    $body = mm_require_post();

    if ($action === 'add') {
        $sym = strtoupper(mm_str($body, 'symbol', 20));
        if (!preg_match('/^[A-Z0-9&\-]{1,20}$/', $sym)) mm_json(400, ['error' => 'Invalid symbol']);
        $st = $pdo->prepare('SELECT COUNT(*) FROM user_watchlist WHERE user_id = ?');
        $st->execute([$uid]);
        if ((int) $st->fetchColumn() >= WATCH_MAX) mm_json(400, ['error' => 'Your watchlist is full (' . WATCH_MAX . ' stocks). Remove one first.']);
        $st = $pdo->prepare('SELECT name FROM stocks WHERE symbol = ? AND is_active = 1 ORDER BY exchange = \'NSE\' DESC LIMIT 1');
        $st->execute([$sym]);
        $name = $st->fetchColumn();
        if ($name === false) mm_json(400, ['error' => "$sym is not in the NSE/BSE stock list"]);
        $sql = mm_is_sqlite($pdo) ? 'INSERT OR IGNORE' : 'INSERT IGNORE';
        $pdo->prepare("$sql INTO user_watchlist (user_id, symbol, name, added_at) VALUES (?, ?, ?, ?)")->execute([$uid, $sym, (string) $name, mm_now()]);
        mm_json(200, ['items' => items($pdo, $uid), 'max' => WATCH_MAX]);
    }

    if ($action === 'remove') {
        $pdo->prepare('DELETE FROM user_watchlist WHERE id = ? AND user_id = ?')->execute([(int) ($body['id'] ?? 0), $uid]);
        mm_json(200, ['items' => items($pdo, $uid), 'max' => WATCH_MAX]);
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    mm_json(502, ['error' => $e->getMessage()]);
}

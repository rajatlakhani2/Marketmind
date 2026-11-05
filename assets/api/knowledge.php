<?php
// MarketMind AI — each user's own knowledge library, kept in MySQL so it follows them
// to every device. The browser keeps a copy (IndexedDB) and syncs changes here.
//
// GET  ?action=pull&since=YYYY-MM-DD HH:MM:SS
//      -> { now, items: [{ store, id, data }] changed since then, ids: { store: [every id] } }
// POST ?action=sync  { puts: [{ store, id, data }], deletes: [{ store, id }] }   (max ~16 MB)
//
// Stores: documents, concepts, strategies, chunks, feedback.

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';

const MM_STORES = ['documents', 'concepts', 'strategies', 'chunks', 'feedback'];

$action = (string) ($_GET['action'] ?? '');

try {
    $u = mm_require_user();
    $pdo = mm_db();
    $uid = (int) $u['id'];

    if ($action === 'pull') {
        $since = (string) ($_GET['since'] ?? '');
        if (!preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $since)) $since = '2000-01-01 00:00:00';
        $now = mm_now();
        $st = $pdo->prepare('SELECT store, item_id, data_json FROM knowledge_items WHERE user_id = ? AND updated_at >= ?');
        $st->execute([$uid, $since]);
        $items = [];
        foreach ($st as $r) $items[] = ['store' => $r['store'], 'id' => $r['item_id'], 'data' => json_decode($r['data_json'], true)];
        $ids = array_fill_keys(MM_STORES, []);
        $st = $pdo->prepare('SELECT store, item_id FROM knowledge_items WHERE user_id = ?');
        $st->execute([$uid]);
        foreach ($st as $r) $ids[$r['store']][] = $r['item_id'];
        mm_json(200, ['now' => $now, 'items' => $items, 'ids' => $ids]);
    }

    if ($action === 'sync') {
        $body = mm_require_post(16 * 1024 * 1024);
        $puts = is_array($body['puts'] ?? null) ? $body['puts'] : [];
        $deletes = is_array($body['deletes'] ?? null) ? $body['deletes'] : [];
        $valid = fn($x) => is_array($x) && in_array($x['store'] ?? '', MM_STORES, true) && is_string($x['id'] ?? null) && $x['id'] !== '' && strlen($x['id']) <= 100;
        $del = $pdo->prepare('DELETE FROM knowledge_items WHERE user_id = ? AND store = ? AND item_id = ?');
        $ins = $pdo->prepare('INSERT INTO knowledge_items (user_id, store, item_id, data_json, updated_at) VALUES (?, ?, ?, ?, ?)');
        $now = mm_now();
        $saved = $removed = 0;
        $pdo->beginTransaction();
        foreach ($deletes as $d) {
            if (!$valid($d)) continue;
            $del->execute([$uid, $d['store'], $d['id']]);
            $removed++;
        }
        foreach ($puts as $p) {
            if (!$valid($p) || !is_array($p['data'] ?? null)) continue;
            $json = json_encode($p['data'], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            if ($json === false || strlen($json) > 15 * 1024 * 1024) continue;
            $del->execute([$uid, $p['store'], $p['id']]);
            $ins->execute([$uid, $p['store'], $p['id'], $json, $now]);
            $saved++;
        }
        $pdo->commit();
        mm_json(200, ['ok' => true, 'saved' => $saved, 'removed' => $removed, 'now' => $now]);
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind knowledge error: ' . $e->getMessage());
    mm_json(500, ['error' => 'Server error. Check the PHP error log on the host.']);
}

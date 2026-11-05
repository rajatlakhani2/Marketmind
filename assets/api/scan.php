<?php
// MarketMind AI — daily opportunity scan results.
//
// The scan itself runs in the admin's browser (the strategies are JavaScript) and saves
// its results here, so every signed-in user, on any device, sees the latest scan.
//
// GET  ?action=latest                    -> { date, at, rows: [...] }
// POST ?action=save {date, rows: [...]}  (admin) -> stores one scan day (replaces that day)

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';

$action = (string) ($_GET['action'] ?? '');
try {
    if ($action === 'latest') {
        mm_require_user();
        $pdo = mm_db();
        $date = $pdo->query('SELECT MAX(scan_date) FROM scan_results')->fetchColumn();
        if (!$date) mm_json(200, ['date' => null, 'rows' => []]);
        $st = $pdo->prepare('SELECT data, created_at FROM scan_results WHERE scan_date = ?');
        $st->execute([$date]);
        $rows = []; $at = null;
        foreach ($st->fetchAll() as $r) {
            $d = json_decode($r['data'], true);
            if (is_array($d)) $rows[] = $d;
            $at = max((string) $at, $r['created_at']);
        }
        mm_json(200, ['date' => $date, 'at' => $at, 'rows' => $rows]);
    }

    if ($action === 'save') {
        mm_require_admin();
        $body = mm_require_post(4 * 1024 * 1024);
        $date = (string) ($body['date'] ?? '');
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) mm_json(400, ['error' => 'Invalid date']);
        $pdo = mm_db();
        $saved = 0;
        $sql = mm_is_sqlite($pdo) ? 'INSERT OR REPLACE INTO scan_results (scan_date, symbol, data, created_at) VALUES (?, ?, ?, ?)'
            : 'INSERT INTO scan_results (scan_date, symbol, data, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), created_at = VALUES(created_at)';
        $st = $pdo->prepare($sql);
        foreach (array_slice((array) ($body['rows'] ?? []), 0, 600) as $r) {
            if (!is_array($r) || !preg_match('/^[A-Z0-9&\-]{1,20}$/', (string) ($r['symbol'] ?? ''))) continue;
            $st->execute([$date, $r['symbol'], json_encode($r), mm_now()]);
            $saved++;
        }
        // Keep the last 30 scan days
        $pdo->prepare('DELETE FROM scan_results WHERE scan_date < ?')->execute([(new DateTime($date))->modify('-30 days')->format('Y-m-d')]);
        mm_json(200, ['saved' => $saved]);
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    mm_json(502, ['error' => $e->getMessage()]);
}

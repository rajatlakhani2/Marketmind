<?php
// MarketMind AI — NSE + BSE stock list.
//
// GET  ?action=search&q=tata     -> { results: [{ symbol, exchange, nse, bse, name }], total }
// GET  ?action=info              -> { nse, bse, lastRefresh }
// POST ?action=refresh           (admin) downloads the latest lists from ICICI / NSE / BSE
//
// BSE-only companies use their 6-digit BSE code as the symbol (e.g. 543320).

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/stocks.php';

$action = (string) ($_GET['action'] ?? '');

try {
    mm_require_user();
    $pdo = mm_db();

    if ($action === 'search') {
        $q = substr(trim((string) ($_GET['q'] ?? '')), 0, 50);
        $results = mm_search_stocks($pdo, $q, max(1, min(50, (int) ($_GET['limit'] ?? 20))));
        mm_json(200, ['results' => $results, 'total' => (int) $pdo->query('SELECT COUNT(*) FROM stocks WHERE is_active = 1')->fetchColumn()]);
    }

    if ($action === 'info') {
        $counts = $pdo->query('SELECT exchange, COUNT(*) AS n FROM stocks WHERE is_active = 1 GROUP BY exchange')->fetchAll(PDO::FETCH_KEY_PAIR);
        mm_json(200, ['nse' => (int) ($counts['NSE'] ?? 0), 'bse' => (int) ($counts['BSE'] ?? 0), 'lastRefresh' => mm_get_meta($pdo, 'stocks_refresh')]);
    }

    if ($action === 'refresh') {
        mm_require_post();
        mm_require_admin();
        mm_json(200, ['ok' => true] + mm_refresh_stocks($pdo));
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind stocks error: ' . $e->getMessage());
    mm_json(500, ['error' => $e instanceof RuntimeException ? $e->getMessage() : 'Server error. Check the PHP error log on the host.']);
}

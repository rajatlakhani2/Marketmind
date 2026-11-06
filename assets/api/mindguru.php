<?php
// MarketMind AI — MindGuru endpoints.
//
// GET  ?action=brain     -> learned weights per strategy (used by the All-Strategy Verdict)
// GET  ?action=report    -> stats, lessons, learning log and recent projections for the MindGuru page
// POST ?action=record    { source: "live"|"backtest", predictions: [...] }  (max 500 per call)
// POST ?action=learn     judge projections whose day has passed, then update the weights
// POST ?action=reset     (admin) { scope: "backtest"|"all" }

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/stocks.php';
require __DIR__ . '/lib/mindguru.php';

$action = (string) ($_GET['action'] ?? '');

try {
    $user = mm_require_user();
    $pdo = mm_db();

    if ($action === 'brain') {
        mm_json(200, mg_brain($pdo));
    }

    if ($action === 'record') {
        $body = mm_require_post();
        $source = in_array($body['source'] ?? 'live', ['backtest', 'watch'], true) ? $body['source'] : 'live';
        $items = $body['predictions'] ?? null;
        if (!is_array($items) || count($items) > 500) mm_json(400, ['error' => 'Send 1–500 predictions at a time']);
        mm_json(200, ['ok' => true] + mg_record($pdo, (int) $user['id'], $source, $items));
    }

    if ($action === 'watch_stats') {
        $syms = explode(',', (string) ($_GET['symbols'] ?? ''));
        mm_json(200, ['stats' => (object) mg_watch_stats($pdo, array_slice($syms, 0, 40))]);
    }

    if ($action === 'learn') {
        mm_require_post();
        @set_time_limit(60);
        $ev = mg_evaluate($pdo, 15, 25);
        $meta = mm_get_meta($pdo, 'mindguru');
        if ($ev['resolved'] > 0 || !$meta) $meta = mg_recompute($pdo);
        mm_json(200, ['ok' => true, 'done' => $ev['symbolsLeft'] === 0] + $ev + ['generation' => (int) ($meta['generation'] ?? 0)]);
    }

    if ($action === 'report') {
        $brain = mg_brain($pdo);
        $stats = $pdo->query("SELECT * FROM strategy_stats WHERE bucket = 'all' ORDER BY weight DESC, trades DESC")->fetchAll();
        $counts = $pdo->query('SELECT source, status, COUNT(*) AS n FROM predictions GROUP BY source, status')->fetchAll();
        $log = $pdo->query('SELECT generation, created_at, outcomes, notes_json FROM mindguru_log ORDER BY id DESC LIMIT 15')->fetchAll();
        $recent = $pdo->query("SELECT id, source, symbol, name, kind, strategy_name, side, signal_date, price_at_signal, entry, stop, target, entry_type, trend, ks_score, status, exit_date, exit_price, r_multiple, days_held
            FROM predictions WHERE source = 'live' ORDER BY signal_date DESC, id DESC LIMIT 80")->fetchAll();
        mm_json(200, [
            'brain' => ['generation' => $brain['generation'], 'trades' => $brain['trades'], 'learnedAt' => $brain['learnedAt']],
            'stats' => array_map(fn($r) => [
                'strategyId' => $r['strategy_id'], 'name' => $r['strategy_name'], 'trades' => (int) $r['trades'], 'wins' => (int) $r['wins'],
                'losses' => (int) $r['losses'], 'expired' => (int) $r['expired'], 'noEntry' => (int) $r['no_entry'],
                'winRate' => (float) $r['win_rate'], 'avgR' => (float) $r['avg_r'], 'weight' => (float) $r['weight'],
                'buckets' => $brain['strategies']->{$r['strategy_id']}['buckets'] ?? (object) [],
            ], $stats),
            'counts' => $counts,
            'insights' => mg_insights(json_decode(json_encode($brain), true)),
            'log' => array_map(fn($r) => ['generation' => (int) $r['generation'], 'at' => $r['created_at'], 'outcomes' => (int) $r['outcomes'], 'notes' => json_decode($r['notes_json'], true)], $log),
            'recent' => $recent,
            'isAdmin' => $user['role'] === 'admin',
        ]);
    }

    if ($action === 'reset') {
        $body = mm_require_post();
        mm_require_admin();
        $scope = ($body['scope'] ?? '') === 'all' ? 'all' : 'backtest';
        if ($scope === 'all') { $pdo->exec('DELETE FROM predictions'); $pdo->exec('DELETE FROM mindguru_log'); mm_set_meta($pdo, 'mindguru', ['generation' => 0]); }
        else $pdo->exec("DELETE FROM predictions WHERE source = 'backtest'");
        mm_json(200, ['ok' => true] + mg_recompute($pdo));
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind MindGuru error: ' . $e->getMessage());
    mm_json(500, ['error' => 'Server error. Check the PHP error log on the host.']);
}

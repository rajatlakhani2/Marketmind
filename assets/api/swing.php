<?php
// MarketMind AI — today's swing setups and the paper record (written each trading evening by the GitHub "Swing scan"
// workflow to ~/marketmind-data/swing.json, outside public_html).
// GET ?action=latest -> { date, market, signals, near, open, closedStats, recentClosed, start, rules }
declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';
try {
    mm_require_user();
    $f = dirname(__DIR__, 3) . '/marketmind-data/swing.json';
    if (!is_file($f)) mm_json(200, ['date' => null, 'note' => 'The first swing scan has not run yet.']);
    $d = json_decode((string) file_get_contents($f), true);
    if (!is_array($d)) mm_json(500, ['error' => 'swing.json is unreadable']);
    mm_json(200, $d);
} catch (Throwable $e) {
    error_log('MarketMind swing error: ' . $e->getMessage());
    mm_json(500, ['error' => 'Server error']);
}

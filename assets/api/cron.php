<?php
// MarketMind AI — daily background job (optional; the app also learns when it's opened).
//
// cPanel → Cron Jobs, once a day after market close, e.g. 4:15 pm IST (10:45 UTC):
//   php /home/YOURACCOUNT/public_html/marketmind/api/cron.php
//
// It judges every projection whose day has passed, updates MindGuru's weights, and
// refreshes the NSE + BSE stock list once a week. It only runs from the command line.

declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/stocks.php';
require __DIR__ . '/lib/mindguru.php';

$log = fn(string $m) => fwrite(STDOUT, '[' . gmdate('Y-m-d H:i:s') . " UTC] $m\n");

try {
    $pdo = mm_db();

    $last = mm_get_meta($pdo, 'stocks_refresh');
    if (!$last || strtotime(($last['at'] ?? '2000-01-01') . ' UTC') < time() - 7 * 86400) {
        try {
            $r = mm_refresh_stocks($pdo);
            $log("Stock list: {$r['nse']} NSE, {$r['bse']} BSE (+{$r['added']}, ~{$r['changed']}, -{$r['removed']})");
        } catch (Throwable $e) { $log('Stock list refresh failed: ' . $e->getMessage()); }
    }

    $resolved = 0;
    $t0 = time();
    do {
        $ev = mg_evaluate($pdo, 25, 60);
        $resolved += $ev['resolved'];
        foreach ($ev['errors'] as $err) $log("Price data: $err");
    } while ($ev['symbolsLeft'] > 0 && time() - $t0 < 600);
    $meta = mg_recompute($pdo);
    $log("MindGuru: judged $resolved projections; generation {$meta['generation']}, {$meta['trades']} finished trades learned from");
} catch (Throwable $e) {
    $log('Failed: ' . $e->getMessage());
    exit(1);
}

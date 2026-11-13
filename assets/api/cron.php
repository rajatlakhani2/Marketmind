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

// php cron.php alerts  -> check price alerts (add a cron every 5 minutes; it only works 9:15-15:35 IST, Mon-Fri)
// php cron.php weekly  -> email each user who gave an email address a weekly summary (add a cron on Sunday)
$mode = $argv[1] ?? 'daily';
if ($mode === 'alerts') {
    require __DIR__ . '/lib/alerts.php';
    $n = new DateTime('now', new DateTimeZone('Asia/Kolkata')); $m = (int) $n->format('G') * 60 + (int) $n->format('i');
    if ((int) $n->format('N') <= 5 && $m >= 555 && $m <= 935) { $f = mm_alerts_check(mm_db()); $log(count($f) . ' alert(s) fired'); }
    exit(0);
}
if ($mode === 'weekly') {
    $pdo = mm_db();
    foreach ($pdo->query("SELECT id, display_name, username, contact FROM users WHERE is_active = 1")->fetchAll() as $u) {
        if (!filter_var($u['contact'], FILTER_VALIDATE_EMAIL)) continue;
        $lines = ['Hello ' . ($u['display_name'] ?: $u['username']) . ',', '', 'Your MarketMind week:'];
        $st = $pdo->prepare("SELECT value_json FROM user_settings WHERE user_id = ? AND setting_key = 'networth_log'"); $st->execute([$u['id']]);
        $log = json_decode((string) $st->fetchColumn(), true) ?: [];
        if ($log) {
            $now = end($log); $week = null;
            foreach ($log as $x) if ($x['d'] >= gmdate('Y-m-d', time() - 7 * 86400)) { $week = $x; break; }
            $lines[] = '- Portfolio value: Rs ' . number_format($now['v']) . ($week && $week !== $now ? sprintf(' (%+.1f%% this week, money added left out)', (($now['v'] - $now['i']) - ($week['v'] - $week['i'])) / max(1, $week['v']) * 100) : '');
        }
        $st = $pdo->prepare("SELECT message FROM price_alerts WHERE user_id = ? AND triggered_at >= ?"); $st->execute([$u['id'], gmdate('Y-m-d H:i:s', time() - 7 * 86400)]);
        foreach ($st->fetchAll() as $a) $lines[] = '- Alert: ' . $a['message'];
        $st = $pdo->prepare("SELECT symbol FROM user_watchlist WHERE user_id = ? ORDER BY symbol"); $st->execute([$u['id']]);
        $w = array_column($st->fetchAll(), 'symbol');
        if ($w) $lines[] = '- Watchlist: ' . implode(', ', array_slice($w, 0, 20));
        $lines[] = ''; $lines[] = 'Open MarketMind for this week\'s results dates and setups.';
        @mail($u['contact'], 'MarketMind: your week', implode("\n", $lines), 'Content-Type: text/plain; charset=utf-8');
        $log("weekly email to user {$u['id']}");
    }
    exit(0);
}

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

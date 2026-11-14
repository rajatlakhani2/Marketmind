<?php
// MarketMind AI — Zerodha (Kite Connect) login comes back here: set this page as the app's Redirect URL
// on developers.kite.trade, e.g. https://marketmind.kuhu.org.in/api/kite.php
// Kite adds ?request_token=...&status=success; the Broker accounts account being logged in is remembered for 15 minutes.
declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/brokers.php';
$back = fn(string $r) => (header('Location: ../index.html#broker=' . $r) ?: exit);
try {
    $u = mm_current_user();
    if (!$u) { header('Location: ../index.html'); exit; }
    $a = mm_broker_pending((int) $u['id']);
    mm_broker_set_pending((int) $u['id'], 0);
    $tok = (string) ($_GET['request_token'] ?? '');
    if (!$a || $a['broker'] !== 'zerodha') $back('failed');
    if (($_GET['status'] ?? '') !== 'success' || !preg_match('/^[A-Za-z0-9]{6,64}$/', $tok)) $back('badcode');
    mm_kite_finish_login($a, $tok);
    $back('connected');
} catch (Throwable $e) {
    error_log('MarketMind kite login error: ' . $e->getMessage());
    $back('failed');
}

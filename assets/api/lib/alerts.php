<?php
// MarketMind AI — price and indicator alerts: checked by the app while it is open (api/alerts.php?action=check,
// at most once a minute for everyone) and by cron.php every few minutes in market hours. A triggered alert
// is switched off, kept with its message, and emailed when the owner's contact is an email address.

declare(strict_types=1);
if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === realpath(__FILE__)) { http_response_code(404); exit; }

const MM_ALERT_KINDS = [
    'above' => 'price rises above', 'below' => 'price falls below',
    'rsi_above' => 'RSI(14) rises above', 'rsi_below' => 'RSI(14) falls below',
    'ma200_up' => 'closes above its 200-day average', 'ma200_down' => 'closes below its 200-day average',
];

// Daily closes for many symbols at once (Yahoo, 1 year)
function mm_alert_closes(array $syms): array {
    $mh = curl_multi_init(); $hs = []; $out = [];
    foreach ($syms as $s) {
        $ch = curl_init('https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode(preg_match('/^\d{6}$/', $s) ? "$s.BO" : "$s.NS") . '?range=1y&interval=1d');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_USERAGENT => 'Mozilla/5.0 (MarketMind AI)']);
        curl_multi_add_handle($mh, $ch); $hs[$s] = $ch;
    }
    do { $st = curl_multi_exec($mh, $run); if ($run) curl_multi_select($mh, 1.0); } while ($run && $st === CURLM_OK);
    foreach ($hs as $s => $ch) {
        $r = json_decode((string) curl_multi_getcontent($ch), true)['chart']['result'][0] ?? null;
        $c = array_values(array_filter($r['indicators']['quote'][0]['close'] ?? [], fn($v) => $v !== null));
        if ($r && $c) { $c[count($c) - 1] = (float) ($r['meta']['regularMarketPrice'] ?? end($c)); $out[$s] = $c; }
        curl_multi_remove_handle($mh, $ch); curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
}

function mm_alert_rsi(array $c, int $n = 14): ?float {
    if (count($c) <= $n) return null;
    $g = $l = 0.0;
    for ($i = 1; $i <= $n; $i++) { $d = $c[$i] - $c[$i - 1]; $d > 0 ? $g += $d : $l -= $d; }
    $g /= $n; $l /= $n;
    for ($i = $n + 1; $i < count($c); $i++) { $d = $c[$i] - $c[$i - 1]; $g = ($g * ($n - 1) + max($d, 0)) / $n; $l = ($l * ($n - 1) + max(-$d, 0)) / $n; }
    return $l == 0 ? 100.0 : 100 - 100 / (1 + $g / $l);
}

// Checks every active alert; returns the ones that fired now.
function mm_alerts_check(PDO $pdo): array {
    $alerts = $pdo->query('SELECT * FROM price_alerts WHERE active = 1')->fetchAll();
    if (!$alerts) return [];
    $closes = mm_alert_closes(array_values(array_unique(array_column($alerts, 'symbol'))));
    $fired = [];
    foreach ($alerts as $a) {
        $c = $closes[$a['symbol']] ?? null;
        if (!$c || count($c) < 2) continue;
        $px = end($c); $v = (float) $a['value'];
        $ma = count($c) >= 200 ? array_sum(array_slice($c, -200)) / 200 : null;
        $maPrev = count($c) >= 201 ? array_sum(array_slice($c, -201, 200)) / 200 : null;
        $rsi = in_array($a['kind'], ['rsi_above', 'rsi_below'], true) ? mm_alert_rsi($c) : null;
        $hit = match ($a['kind']) {
            'above' => $px >= $v, 'below' => $px <= $v,
            'rsi_above' => $rsi !== null && $rsi >= $v, 'rsi_below' => $rsi !== null && $rsi <= $v,
            'ma200_up' => $ma && $maPrev && $px > $ma && $c[count($c) - 2] <= $maPrev,
            'ma200_down' => $ma && $maPrev && $px < $ma && $c[count($c) - 2] >= $maPrev,
            default => false,
        };
        if (!$hit) continue;
        $msg = sprintf('%s %s%s — now ₹%s%s', $a['symbol'], MM_ALERT_KINDS[$a['kind']] ?? $a['kind'], in_array($a['kind'], ['ma200_up', 'ma200_down'], true) ? '' : ' ' . rtrim(rtrim(number_format($v, 2, '.', ''), '0'), '.'),
            number_format($px, 2), $rsi !== null ? sprintf(' (RSI %.0f)', $rsi) : '');
        $pdo->prepare('UPDATE price_alerts SET active = 0, seen = 0, message = ?, triggered_at = ? WHERE id = ?')->execute([substr($msg, 0, 250), mm_now(), $a['id']]);
        $fired[] = $a + ['message' => $msg];
        $st = $pdo->prepare('SELECT contact, display_name FROM users WHERE id = ?'); $st->execute([$a['user_id']]); $u = $st->fetch();
        if ($u && filter_var($u['contact'], FILTER_VALIDATE_EMAIL)) @mail($u['contact'], 'MarketMind alert: ' . $a['symbol'], $msg . "\n\nOpen MarketMind to see the stock.", 'Content-Type: text/plain; charset=utf-8');
    }
    return $fired;
}

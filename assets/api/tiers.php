<?php
// MarketMind AI — strategy tiers (Proven / Watch / Not proven).
//
// GET  ?action=get                         -> { tiers: { id: {tier, btTier, override, bt, live, why} }, backtestAt, rules, history }
// POST ?action=backtest {cfg, stats}       (admin) apply a finished swing back-test (3+ years, 50+ stocks)
// POST ?action=override {id, tier}         (admin) tier = proven|watch|unproven, or '' to go back to automatic
//
// Rules (decided 10 Nov 2026):
//   Proven     : 100+ trades, average at least +0.10R after costs, positive in at least half the years
//   Watch      : 30+ trades, average above 0
//   Not proven : everything else
//   Buffer so tiers don't flip every month: a Proven strategy stays Proven while it holds +0.05R and
//   misses at most one more year than the rule allows; a Watch strategy stays Watch down to −0.03R.
//   Live MindGuru results (source "live") move a strategy one tier: down after 30+ trades at −0.10R or worse,
//   up after 50+ trades at +0.15R or better. A tier set by hand always wins.

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/stocks.php';
require __DIR__ . '/lib/mindguru.php';

const TIER_ORDER = ['unproven', 'watch', 'proven'];

// Starting point: the back-test of 10 Nov 2026 (99 stocks, 5 years, 36,259 trades)
function tiers_seed(): array {
    $bt = [
        'lib_s_golden_cross' => ['name' => 'Golden Cross', 'avg' => 0.19, 'yearsPos' => 4, 'years' => 6, 'tier' => 'proven'],
        'lib_s_adx_ema_pullback' => ['name' => 'ADX Pullback to 20 EMA', 'avg' => 0.14, 'yearsPos' => 4, 'years' => 6, 'tier' => 'proven'],
        'lib_s_supertrend_flip' => ['name' => 'Supertrend Flip', 'avg' => 0.12, 'yearsPos' => 3, 'years' => 6, 'tier' => 'proven'],
        'lib_s_macd_cross_below_zero' => ['name' => 'MACD Cross Below Zero', 'tier' => 'watch'],
        'lib_s_high52' => ['name' => '52-Week High', 'tier' => 'watch'],
        'lib_s_rsi_divergence' => ['name' => 'RSI Divergence', 'tier' => 'watch'],
        'lib_s_morning_star_demand' => ['name' => 'Morning Star', 'tier' => 'watch'],
    ];
    return ['backtestAt' => '2026-11-10 00:00:00', 'cfg' => ['style' => 'swing', 'years' => 5, 'symbols' => 99, 'seed' => true], 'bt' => $bt, 'overrides' => [], 'history' => []];
}

function tiers_meta(PDO $pdo): array { return mm_get_meta($pdo, 'tiers') ?? tiers_seed(); }

function tier_from_backtest(array $s, ?string $prev): string {
    $n = (int) ($s['n'] ?? 0); $avg = (float) ($s['avg'] ?? 0);
    $years = (int) ($s['years'] ?? 0); $pos = (int) ($s['yearsPos'] ?? 0);
    $halfOk = $years === 0 || $pos * 2 >= $years;
    if ($n >= 100 && $avg >= 0.10 && $halfOk) return 'proven';
    if ($prev === 'proven' && $n >= 100 && $avg >= 0.05 && ($years === 0 || ($pos + 1) * 2 >= $years)) return 'proven';
    if ($n >= 30 && $avg > 0) return 'watch';
    if (in_array($prev, ['watch', 'proven'], true) && $n >= 30 && $avg >= -0.03) return 'watch';
    return 'unproven';
}

function tier_step(string $t, int $d): string {
    $i = max(0, min(2, array_search($t, TIER_ORDER, true) + $d));
    return TIER_ORDER[$i];
}

function tiers_effective(PDO $pdo, array $meta): array {
    $brain = mg_brain($pdo)['strategies'];
    $brain = is_object($brain) ? (array) $brain : $brain;
    $ids = array_unique(array_merge(array_keys($meta['bt'] ?? []), array_keys($brain), array_keys($meta['overrides'] ?? [])));
    $out = [];
    foreach ($ids as $id) {
        if ($id === '' || $id[0] === '_') continue;          // verdict / watchlist calls are not strategies
        $bt = $meta['bt'][$id] ?? null;
        $btTier = $bt['tier'] ?? 'unproven';
        $live = $brain[$id]['buckets']['src:live'] ?? null;
        $tier = $btTier; $why = $bt ? 'back-test' : 'no back-test record';
        if ($live) {
            $n = (int) $live['trades']; $avg = (float) $live['avgR'];
            if ($n >= 30 && $avg <= -0.10 && $tier !== 'unproven') { $tier = tier_step($tier, -1); $why = sprintf('moved down: live %+.2fR over %d trades', $avg, $n); }
            elseif ($n >= 50 && $avg >= 0.15 && $tier !== 'proven') { $tier = tier_step($tier, 1); $why = sprintf('moved up: live %+.2fR over %d trades', $avg, $n); }
        }
        $ov = $meta['overrides'][$id] ?? null;
        if ($ov) { $tier = $ov; $why = 'set by hand'; }
        $out[$id] = [
            'tier' => $tier, 'btTier' => $btTier, 'override' => $ov, 'why' => $why,
            'name' => $bt['name'] ?? ($brain[$id]['name'] ?? $id),
            'bt' => $bt ? array_intersect_key($bt, array_flip(['n', 'avg', 'yearsPos', 'years'])) : null,
            'live' => $live ? ['n' => (int) $live['trades'], 'avg' => (float) $live['avgR']] : null,
        ];
    }
    return $out;
}

function tiers_reply(PDO $pdo, array $meta, array $extra = []): void {
    mm_json(200, $extra + [
        'tiers' => (object) tiers_effective($pdo, $meta),
        'backtestAt' => $meta['backtestAt'] ?? null, 'cfg' => $meta['cfg'] ?? null,
        'history' => array_slice($meta['history'] ?? [], 0, 12),
    ]);
}

$action = (string) ($_GET['action'] ?? '');
try {
    $user = mm_require_user();
    $pdo = mm_db();

    if ($action === 'get') tiers_reply($pdo, tiers_meta($pdo));

    $body = mm_require_post(1024 * 1024);
    mm_require_admin();
    $meta = tiers_meta($pdo);

    if ($action === 'backtest') {
        $cfg = is_array($body['cfg'] ?? null) ? $body['cfg'] : [];
        $stats = is_array($body['stats'] ?? null) ? $body['stats'] : [];
        if (($cfg['style'] ?? '') !== 'swing' || (int) ($cfg['years'] ?? 0) < 3 || (int) ($cfg['symbols'] ?? 0) < 50 || !empty($cfg['cancelled']))
            mm_json(400, ['error' => 'Tiers only update from a complete swing back-test of 3+ years on 50+ stocks.']);
        if (!$stats || count($stats) > 200) mm_json(400, ['error' => 'No strategy results sent']);
        $bt = []; $changes = [];
        foreach ($stats as $s) {
            $id = substr((string) ($s['id'] ?? ''), 0, 64);
            if ($id === '' || $id[0] === '_' || !preg_match('/^[a-z0-9_]+$/i', $id)) continue;
            $years = 0; $pos = 0;
            foreach ((array) ($s['years'] ?? []) as $y) { if ((int) ($y['n'] ?? 0) >= 10) { $years++; if ((float) $y['avg'] > 0) $pos++; } }
            $row = ['name' => substr((string) ($s['name'] ?? $id), 0, 120), 'n' => (int) ($s['n'] ?? 0), 'avg' => round((float) ($s['avg'] ?? 0), 3), 'yearsPos' => $pos, 'years' => $years];
            $prev = $meta['bt'][$id]['tier'] ?? null;
            $row['tier'] = tier_from_backtest($row, $prev);
            if (($prev ?? 'unproven') !== $row['tier']) $changes[] = ['id' => $id, 'name' => $row['name'], 'from' => $prev ?? 'unproven', 'to' => $row['tier']];
            $bt[$id] = $row;
        }
        $meta['bt'] = $bt;
        $meta['backtestAt'] = mm_now();
        $meta['cfg'] = ['style' => 'swing', 'years' => (int) $cfg['years'], 'symbols' => (int) $cfg['symbols']];
        array_unshift($meta['history'], ['at' => $meta['backtestAt'], 'kind' => 'backtest', 'changes' => $changes]);
        $meta['history'] = array_slice($meta['history'], 0, 24);
        mm_set_meta($pdo, 'tiers', $meta);
        tiers_reply($pdo, $meta, ['changes' => $changes]);
    }

    if ($action === 'override') {
        $id = substr((string) ($body['id'] ?? ''), 0, 64);
        $tier = (string) ($body['tier'] ?? '');
        if (!preg_match('/^[a-z0-9_]+$/i', $id)) mm_json(400, ['error' => 'Invalid strategy']);
        if ($tier !== '' && !in_array($tier, TIER_ORDER, true)) mm_json(400, ['error' => 'Invalid tier']);
        if ($tier === '') unset($meta['overrides'][$id]); else $meta['overrides'][$id] = $tier;
        array_unshift($meta['history'], ['at' => mm_now(), 'kind' => 'override', 'changes' => [['id' => $id, 'to' => $tier ?: 'automatic']]]);
        $meta['history'] = array_slice($meta['history'], 0, 24);
        mm_set_meta($pdo, 'tiers', $meta);
        tiers_reply($pdo, $meta);
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind tiers error: ' . $e->getMessage());
    mm_json(500, ['error' => 'Server error. Check the PHP error log on the host.']);
}

<?php
// MarketMind AI — MindGuru: records every projection, checks it against what the market
// actually did, and turns the results into per-strategy weights the verdict uses next time.
//
// How a projection is judged (daily candles after the signal day):
//   * Entry: "market" when the plan's entry is within 0.5% of the price at the signal
//     (filled at that price); otherwise it must be reached within ENTRY_WINDOW days
//     (a limit below price, or a breakout above it), else the result is "no_entry".
//   * Exit: stop-loss or target, whichever is touched first. If a single candle touches
//     both, the stop is assumed (the cautious choice). Gaps fill at the open.
//     Still open after HOLD_MAX days -> "expired" at that day's close.
//   * Result in R: profit or loss divided by the planned risk (entry to stop).

declare(strict_types=1);

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === realpath(__FILE__)) { http_response_code(404); exit; }

const MG_ENTRY_WINDOW = 10;   // trading days to reach the entry price
const MG_HOLD_MAX     = 30;   // trading days to reach stop or target
const MG_MARKET_TOL   = 0.005;
const MG_PRIOR_N      = 15;   // results needed before a strategy's record counts fully
const MG_RESOLVED     = ['target_hit', 'stop_hit', 'expired'];

function mg_ist_today(): string { return gmdate('Y-m-d', time() + 19800); }

// ---------- daily candles (Yahoo Finance, cached) ----------
// Returns [['d' => 'Y-m-d', 'o' =>, 'h' =>, 'l' =>, 'c' =>], ...] oldest first, in IST dates.
function mg_daily_candles(string $symbol): array {
    $ySym = preg_match('/^\d{6}$/', $symbol) ? "$symbol.BO" : "$symbol.NS";
    // Testing only: 'price_fixtures' in the config points at saved Yahoo responses (<SYMBOL>.json)
    $fixtures = mm_config()['price_fixtures'] ?? null;
    $url = $fixtures ? "$fixtures/$symbol.json" : null;
    $dir = sys_get_temp_dir() . '/marketmind_cache';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $file = $dir . '/mg_' . md5($ySym) . '.json';
    if (!$url && is_file($file) && time() - filemtime($file) < 3 * 3600) {
        $cached = json_decode((string) file_get_contents($file), true);
        if (is_array($cached)) return $cached;
    }
    if ($url) {
        $body = is_file($url) ? file_get_contents($url) : false;
    } else {
        $ch = curl_init('https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($ySym) . '?interval=1d&range=2y&includePrePost=false');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 20,
            CURLOPT_USERAGENT => 'Mozilla/5.0 (MarketMind AI)', CURLOPT_HTTPHEADER => ['Accept: application/json']]);
        $body = curl_exec($ch);
        curl_close($ch);
    }
    $json = $body ? json_decode((string) $body, true) : null;
    $res = $json['chart']['result'][0] ?? null;
    if (!$res) throw new RuntimeException("No price data for $symbol");
    $ts = $res['timestamp'] ?? [];
    $q = $res['indicators']['quote'][0] ?? [];
    $today = mg_ist_today();
    $marketOpen = gmdate('H:i', time() + 19800) < '15:45';
    $out = [];
    foreach ($ts as $i => $t) {
        $o = $q['open'][$i] ?? null; $h = $q['high'][$i] ?? null; $l = $q['low'][$i] ?? null; $c = $q['close'][$i] ?? null;
        if ($o === null || $h === null || $l === null || $c === null) continue;
        $d = gmdate('Y-m-d', (int) $t + 19800);
        if ($d === $today && $marketOpen) continue; // today's candle isn't finished
        $out[$d] = ['d' => $d, 'o' => (float) $o, 'h' => (float) $h, 'l' => (float) $l, 'c' => (float) $c];
    }
    $out = array_values($out);
    @file_put_contents($file, json_encode($out));
    return $out;
}

// ---------- recording ----------
function mg_num($v): ?float { return is_numeric($v) && is_finite((float) $v) ? (float) $v : null; }

// Validates and stores projections. Returns ['added' => n, 'skipped' => n].
function mg_record(PDO $pdo, ?int $userId, string $source, array $items): array {
    $find = $pdo->prepare('SELECT id FROM predictions WHERE symbol = ? AND kind = ? AND strategy_id = ? AND signal_date = ? AND source = ?');
    $ins = $pdo->prepare('INSERT INTO predictions (source, user_id, symbol, name, kind, strategy_id, strategy_name, side, signal_date, price_at_signal, entry, stop, target, entry_type, trend, ks_score, context_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $added = $skipped = 0;
    $today = mg_ist_today();
    $pdo->beginTransaction();
    try {
        foreach ($items as $p) {
            if (!is_array($p)) { $skipped++; continue; }
            $symbol = strtoupper(trim((string) ($p['symbol'] ?? '')));
            $kind = (string) ($p['kind'] ?? '');
            $sid = (string) ($p['strategyId'] ?? '');
            $side = (string) ($p['side'] ?? '');
            $date = (string) ($p['signalDate'] ?? '');
            $price = mg_num($p['price'] ?? null); $entry = mg_num($p['entry'] ?? null);
            $stop = mg_num($p['stop'] ?? null); $target = mg_num($p['target'] ?? null);
            $ok = preg_match('/^[A-Z0-9&\-]{1,20}$/', $symbol) && in_array($kind, ['strategy', 'verdict'], true)
                && preg_match('/^[A-Za-z0-9_\-]{1,64}$/', $sid) && in_array($side, ['long', 'short'], true)
                && preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) && $date <= $today
                && $price > 0 && $entry > 0 && $stop > 0 && $target > 0
                && ($side === 'long' ? ($stop < $entry && $entry < $target) : ($target < $entry && $entry < $stop))
                && abs($entry - $price) / $price < 0.25;
            if (!$ok) { $skipped++; continue; }
            $find->execute([$symbol, $kind, $sid, $date, $source]);
            if ($find->fetchColumn()) { $skipped++; continue; }
            $gap = ($entry - $price) / $price;
            $entryType = abs($gap) <= MG_MARKET_TOL ? 'market' : (($side === 'long') === ($gap < 0) ? 'limit' : 'breakout');
            $trend = in_array($p['trend'] ?? '', ['Bullish', 'Bearish', 'Sideways'], true) ? $p['trend'] : '';
            $ks = mg_num($p['ksScore'] ?? null);
            $ctx = isset($p['context']) && is_array($p['context']) ? substr(json_encode($p['context']), 0, 4000) : null;
            $ins->execute([$source, $userId, $symbol, mb_substr((string) ($p['name'] ?? ''), 0, 150), $kind, $sid, mb_substr((string) ($p['strategyName'] ?? $sid), 0, 120),
                $side, $date, $price, $entry, $stop, $target, $entryType, $trend, $ks, $ctx, 'pending', mm_now()]);
            $added++;
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return ['added' => $added, 'skipped' => $skipped];
}

// ---------- judging one projection ----------
// Returns null while it can't be decided yet, else the fields to save.
function mg_judge(array $p, array $candles): ?array {
    $short = $p['side'] === 'short';
    // Shorts are judged as longs on the negated price series
    $f = fn($v) => $short ? -(float) $v : (float) $v;
    $entry = $f($p['entry']); $stop = $f($p['stop']); $target = $f($p['target']);
    $after = array_values(array_filter($candles, fn($c) => $c['d'] > $p['signal_date']));
    $bars = array_map(fn($c) => $short
        ? ['d' => $c['d'], 'o' => -$c['o'], 'h' => -$c['l'], 'l' => -$c['h'], 'c' => -$c['c']]
        : $c, $after);

    $fill = null; $start = 0; $enteredDate = $p['signal_date'];
    if ($p['entry_type'] === 'market') {
        $fill = $f($p['price_at_signal']);
    } else {
        $limit = $p['entry_type'] === 'limit';
        foreach (array_slice($bars, 0, MG_ENTRY_WINDOW) as $i => $b) {
            if ($limit && $b['l'] <= $entry) { $fill = min($b['o'], $entry); $start = $i; $enteredDate = $b['d']; break; }
            if (!$limit && $b['h'] >= $entry) { $fill = max($b['o'], $entry); $start = $i; $enteredDate = $b['d']; break; }
        }
        if ($fill === null) {
            return count($bars) >= MG_ENTRY_WINDOW ? ['status' => 'no_entry'] : null;
        }
    }
    $risk = $fill - $stop;
    if ($risk <= 0) return ['status' => 'invalid'];

    $hi = $fill; $lo = $fill; $held = 0;
    $result = function (string $status, float $exit, string $date) use (&$hi, &$lo, $fill, $risk, $short, $enteredDate, &$held) {
        return [
            'status' => $status, 'entered_date' => $enteredDate, 'exit_date' => $date,
            'exit_price' => $short ? -$exit : $exit,
            'r_multiple' => round(($exit - $fill) / $risk, 3),
            'mfe_r' => round(($hi - $fill) / $risk, 3), 'mae_r' => round(($lo - $fill) / $risk, 3),
            'days_held' => $held,
        ];
    };
    for ($i = $start; $i < count($bars); $i++) {
        $b = $bars[$i];
        $held = $i - $start + ($p['entry_type'] === 'market' ? 1 : 0);
        $onEntryBar = $i === $start && $p['entry_type'] !== 'market';
        // On the entry candle we only know price reached the entry; check the stop, not the target.
        if (!$onEntryBar && $b['o'] <= $stop) { $lo = min($lo, $b['l']); return $result('stop_hit', $b['o'], $b['d']); }
        if ($b['l'] <= $stop) { $lo = min($lo, $b['l']); $hi = max($hi, $onEntryBar ? $fill : $b['h']); return $result('stop_hit', $stop, $b['d']); }
        if ($onEntryBar) { $hi = max($hi, $b['c']); $lo = min($lo, $b['l']); continue; }
        $hi = max($hi, $b['h']); $lo = min($lo, $b['l']);
        if ($b['o'] >= $target) return $result('target_hit', $b['o'], $b['d']);
        if ($b['h'] >= $target) return $result('target_hit', $target, $b['d']);
        if ($held >= MG_HOLD_MAX) return $result('expired', $b['c'], $b['d']);
    }
    return null;
}

// ---------- learning run ----------
// Judges pending projections whose signal day has passed, a few symbols at a time.
function mg_evaluate(PDO $pdo, int $maxSymbols = 15, int $budgetSeconds = 20): array {
    $t0 = microtime(true);
    $today = mg_ist_today();
    $st = $pdo->prepare("SELECT symbol, MIN(COALESCE(checked_at, '2000-01-01')) AS oldest FROM predictions
        WHERE status = 'pending' AND signal_date < ? AND (checked_at IS NULL OR checked_at < ?)
        GROUP BY symbol ORDER BY oldest LIMIT " . (int) $maxSymbols);
    $recheckBefore = gmdate('Y-m-d H:i:s', time() - 3 * 3600);
    $st->execute([$today, $recheckBefore]);
    $symbols = $st->fetchAll(PDO::FETCH_COLUMN);
    $resolved = 0; $errors = [];
    $sel = $pdo->prepare("SELECT * FROM predictions WHERE symbol = ? AND status = 'pending' AND signal_date < ?");
    $upd = $pdo->prepare('UPDATE predictions SET status = ?, entered_date = ?, exit_date = ?, exit_price = ?, r_multiple = ?, mfe_r = ?, mae_r = ?, days_held = ?, checked_at = ?, resolved_at = ? WHERE id = ?');
    $touch = $pdo->prepare('UPDATE predictions SET checked_at = ? WHERE id = ?');
    foreach ($symbols as $sym) {
        if (microtime(true) - $t0 > $budgetSeconds) break;
        try { $candles = mg_daily_candles($sym); }
        catch (Throwable $e) {
            $errors[] = $sym . ': ' . $e->getMessage();
            $pdo->prepare("UPDATE predictions SET checked_at = ? WHERE symbol = ? AND status = 'pending'")->execute([mm_now(), $sym]);
            continue;
        }
        $sel->execute([$sym, $today]);
        $pdo->beginTransaction();
        foreach ($sel->fetchAll() as $p) {
            $r = mg_judge($p, $candles);
            if ($r === null) { $touch->execute([mm_now(), $p['id']]); continue; }
            $upd->execute([$r['status'], $r['entered_date'] ?? null, $r['exit_date'] ?? null, $r['exit_price'] ?? null, $r['r_multiple'] ?? null,
                $r['mfe_r'] ?? null, $r['mae_r'] ?? null, $r['days_held'] ?? null, mm_now(), mm_now(), $p['id']]);
            $resolved++;
        }
        $pdo->commit();
    }
    $st = $pdo->prepare("SELECT COUNT(DISTINCT symbol) FROM predictions WHERE status = 'pending' AND signal_date < ? AND (checked_at IS NULL OR checked_at < ?)");
    $st->execute([$today, $recheckBefore]);
    $left = (int) $st->fetchColumn();
    return ['resolved' => $resolved, 'symbolsLeft' => $left, 'errors' => array_slice($errors, 0, 5)];
}

// ---------- turning results into weights ----------
function mg_weight(int $trades, float $avgR): float {
    $f = $trades / ($trades + MG_PRIOR_N);
    return round(max(0.25, min(2.0, 1 + 1.2 * $avgR * $f)), 3);
}

function mg_ks_bucket($score): ?string {
    if ($score === null) return null;
    $s = (float) $score;
    return $s >= 9 ? 'ks:9-10' : ($s >= 8 ? 'ks:8' : ($s >= 7 ? 'ks:7' : 'ks:<7'));
}

// Rebuilds strategy_stats from every judged projection and logs what changed.
function mg_recompute(PDO $pdo): array {
    $prev = [];
    foreach ($pdo->query("SELECT strategy_id, strategy_name, trades, win_rate, weight FROM strategy_stats WHERE bucket = 'all'") as $r) $prev[$r['strategy_id']] = $r;

    $agg = [];
    $rows = $pdo->query("SELECT strategy_id, strategy_name, status, r_multiple, trend, ks_score, source FROM predictions WHERE status IN ('target_hit','stop_hit','expired','no_entry')");
    foreach ($rows as $r) {
        $buckets = ['all', 'src:' . $r['source']];
        if ($r['trend'] !== '') $buckets[] = 'trend:' . $r['trend'];
        if ($b = mg_ks_bucket($r['ks_score'])) $buckets[] = $b;
        foreach ($buckets as $b) {
            $a = &$agg[$r['strategy_id']][$b];
            $a = $a ?? ['name' => $r['strategy_name'], 'trades' => 0, 'wins' => 0, 'losses' => 0, 'expired' => 0, 'no_entry' => 0, 'sumR' => 0.0];
            if ($r['status'] === 'no_entry') { $a['no_entry']++; unset($a); continue; }
            $R = (float) $r['r_multiple'];
            $a['trades']++; $a['sumR'] += $R;
            if ($r['status'] === 'expired') $a['expired']++;
            if ($R > 0) $a['wins']++; else $a['losses']++;
            unset($a);
        }
    }

    $now = mm_now();
    $pdo->beginTransaction();
    $pdo->exec('DELETE FROM strategy_stats');
    $ins = $pdo->prepare('INSERT INTO strategy_stats (strategy_id, bucket, strategy_name, trades, wins, losses, expired, no_entry, win_rate, avg_r, weight, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $total = 0;
    foreach ($agg as $sid => $buckets) {
        foreach ($buckets as $b => $a) {
            $n = $a['trades'];
            $avg = $n ? $a['sumR'] / $n : 0.0;
            $ins->execute([$sid, $b, $a['name'], $n, $a['wins'], $a['losses'], $a['expired'], $a['no_entry'], $n ? round($a['wins'] / $n, 4) : 0, round($avg, 3), mg_weight($n, $avg), $now]);
            if ($b === 'all') $total += $n;
        }
    }
    $pdo->commit();

    // What changed since the last generation
    $notes = [];
    foreach ($agg as $sid => $buckets) {
        $a = $buckets['all'] ?? null;
        if (!$a || !$a['trades']) continue;
        $wr = $a['wins'] / $a['trades'];
        $w = mg_weight($a['trades'], $a['sumR'] / $a['trades']);
        $p = $prev[$sid] ?? null;
        $newTrades = $a['trades'] - (int) ($p['trades'] ?? 0);
        if ($newTrades <= 0) continue;
        $notes[] = [
            'strategy' => $a['name'], 'newTrades' => $newTrades, 'trades' => $a['trades'],
            'winRate' => round($wr * 100), 'winRateBefore' => $p ? round((float) $p['win_rate'] * 100) : null,
            'weight' => $w, 'weightBefore' => $p ? (float) $p['weight'] : null,
        ];
    }
    $meta = mm_get_meta($pdo, 'mindguru') ?? ['generation' => 0];
    if ($notes) {
        usort($notes, fn($x, $y) => $y['newTrades'] <=> $x['newTrades']);
        $meta['generation'] = (int) $meta['generation'] + 1;
        $outcomes = array_sum(array_column($notes, 'newTrades'));
        $pdo->prepare('INSERT INTO mindguru_log (generation, created_at, outcomes, notes_json) VALUES (?, ?, ?, ?)')
            ->execute([$meta['generation'], $now, $outcomes, json_encode($notes)]);
    }
    $meta['learnedAt'] = $now;
    $meta['trades'] = $total;
    mm_set_meta($pdo, 'mindguru', $meta);
    return $meta;
}

// ---------- what the app reads ----------
// Learned weights per strategy, overall and per trend / KS-001 score bucket.
function mg_brain(PDO $pdo): array {
    $out = [];
    foreach ($pdo->query('SELECT * FROM strategy_stats') as $r) {
        $s = &$out[$r['strategy_id']];
        $s = $s ?? ['name' => $r['strategy_name']];
        $s['buckets'][$r['bucket']] = [
            'trades' => (int) $r['trades'], 'wins' => (int) $r['wins'], 'winRate' => (float) $r['win_rate'],
            'avgR' => (float) $r['avg_r'], 'weight' => (float) $r['weight'], 'noEntry' => (int) $r['no_entry'],
        ];
        unset($s);
    }
    $meta = mm_get_meta($pdo, 'mindguru') ?? ['generation' => 0, 'trades' => 0, 'learnedAt' => null];
    return ['generation' => (int) $meta['generation'], 'trades' => (int) ($meta['trades'] ?? 0), 'learnedAt' => $meta['learnedAt'] ?? null, 'strategies' => (object) $out];
}

// Plain-English lessons from the stats: where a strategy clearly works better or worse.
function mg_insights(array $brain): array {
    $out = [];
    foreach ($brain['strategies'] as $sid => $s) {
        $b = $s['buckets'] ?? [];
        $all = $b['all'] ?? null;
        if (!$all || $all['trades'] < 10) continue;
        if ($all['avgR'] >= 0.25) $out[] = ['tone' => 'good', 'text' => sprintf('%s has earned %+.2fR per trade over %d trades (%d%% winners). MindGuru trusts it more.', $s['name'], $all['avgR'], $all['trades'], round($all['winRate'] * 100))];
        elseif ($all['avgR'] <= -0.15) $out[] = ['tone' => 'bad', 'text' => sprintf('%s has lost %.2fR per trade over %d trades. MindGuru gives its signals less say.', $s['name'], abs($all['avgR']), $all['trades'])];
        $groups = ['trend' => ['when the higher-timeframe trend is', 'when it is'], 'ks' => ['for zones scoring', 'for zones scoring']];
        foreach ($groups as $prefix => [$phrase, $phrase2]) {
            $sub = [];
            foreach ($b as $k => $v) if (strpos($k, "$prefix:") === 0 && $v['trades'] >= 8) $sub[substr($k, strlen($prefix) + 1)] = $v;
            if (count($sub) < 2) continue;
            uasort($sub, fn($x, $y) => $y['avgR'] <=> $x['avgR']);
            $best = array_key_first($sub); $worst = array_key_last($sub);
            if ($sub[$best]['avgR'] - $sub[$worst]['avgR'] >= 0.4) {
                $out[] = ['tone' => 'info', 'text' => sprintf('%s does better %s %s (%+.2fR over %d trades) than %s %s (%+.2fR over %d trades).',
                    $s['name'], $phrase, strtolower($best), $sub[$best]['avgR'], $sub[$best]['trades'], $phrase2, strtolower($worst), $sub[$worst]['avgR'], $sub[$worst]['trades'])];
            }
        }
        if ($all['trades'] + $all['noEntry'] >= 10 && $all['noEntry'] > $all['trades']) {
            $out[] = ['tone' => 'info', 'text' => sprintf('%s: price reached the planned entry only %d times out of %d. Its entry levels may be too far from price.', $s['name'], $all['trades'], $all['trades'] + $all['noEntry'])];
        }
    }
    return $out;
}

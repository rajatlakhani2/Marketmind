<?php
// MarketMind AI — one-tap trading (admin only).
//
// MarketMind proposes orders from the watchlist; nothing reaches ICICI until the admin
// approves it here. Approved orders go to ICICI through the order relay on a VPS with a
// dedicated static IP (SEBI requires API orders to come from a registered static IP).
// Until the relay is configured, every approved order runs in TEST mode: it is
// simulated against live prices and never sent to ICICI.
//
// GET  ?action=state                  -> settings, watchlist, orders, relay/session status
// POST ?action=settings     {..}      -> save limits and switches
// POST ?action=watch_add    {symbol, name, delivery, intraday, options}
// POST ?action=watch_update {id, delivery, intraday, options}
// POST ?action=watch_remove {id}
// POST ?action=propose      {orders:[..]}  scanner proposals (entries and exits)
// POST ?action=approve      {id}      -> risk checks, then send (live) or simulate (test)
// POST ?action=reject       {id}
// POST ?action=kill / resume          -> stop everything / allow trading again
// POST ?action=sync         {fills:[{id, price}]}  update open orders (live: ask ICICI; test: simulated fills)
//
// marketmind-config.php may hold:  'relay' => ['url' => 'https://relay.example.com/relay.php', 'secret' => '...']

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';

const BREEZE_SESSION = __DIR__ . '/.breeze-session.php';
const PENDING_MINUTES = 10;   // a proposal must be approved within this time (prices move)

$DEFAULTS = [
    'enabled' => false,          // master switch: no proposals are accepted while off
    'killed' => false,           // kill switch: blocks every approval
    'account' => 100000,         // capital MarketMind may use (₹)
    'riskPct' => 1,              // risk per trade (% of account) for stock positions
    'maxPerTrade' => 25000,      // max order value (₹); options: max premium per trade
    'maxOrdersDay' => 3,         // max new entries approved per day
    'maxOpen' => 3,              // max open positions
    'optionStopPct' => 40,       // options: stop when the premium falls this much
    'optionTargetPct' => 80,     // options: target when the premium rises this much
    'manual' => false,           // without a relay: true = you place approved orders in the ICICI app yourself
    'automation' => 'onetap',    // onetap = you approve every order; semi = new trades need you, stop-loss / target / exit orders go by themselves
    'optionRiskPct' => 5,        // option buying: most of the capital one trade may lose (premium × stop %)
    'futuresRiskPct' => 2,       // futures: most of the capital one trade may lose at the stop
    'futuresLive' => false,      // futures stay simulated (paper) until you switch this on with enough margin
];

// F&O orders go to the NFO segment
function is_fo(array $o): bool { return in_array($o['product'], ['option', 'future'], true); }
function exch(array $o): string { return is_fo($o) ? 'NFO' : 'NSE'; }

// ---------- helpers ----------
function ist_now(): DateTime { return new DateTime('now', new DateTimeZone('Asia/Kolkata')); }
function market_open(): bool {
    $n = ist_now();
    $mins = (int) $n->format('G') * 60 + (int) $n->format('i');
    return (int) $n->format('N') <= 5 && $mins >= 555 && $mins <= 930; // Mon–Fri 9:15–15:30 IST
}
function ist_mins(): int { $n = ist_now(); return (int) $n->format('G') * 60 + (int) $n->format('i'); }

function settings(PDO $pdo, array $defaults): array {
    $s = $defaults;
    foreach ($pdo->query('SELECT k, v FROM trade_settings')->fetchAll() as $r) {
        if (array_key_exists($r['k'], $defaults)) $s[$r['k']] = json_decode($r['v'], true);
    }
    return $s;
}
function save_setting(PDO $pdo, string $k, $v): void {
    $sql = mm_is_sqlite($pdo)
        ? 'INSERT OR REPLACE INTO trade_settings (k, v, updated_at) VALUES (?, ?, ?)'
        : 'INSERT INTO trade_settings (k, v, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)';
    $pdo->prepare($sql)->execute([$k, json_encode($v), mm_now()]);
}

// live = sent through the relay; man = you place it in the ICICI Direct app; test = simulated
function order_mode(array $S, ?array $o = null): string {
    // Futures are paper-only until switched on (they need far more margin than the current capital)
    if ($o && $o['product'] === 'future' && empty($S['futuresLive'])) return 'test';
    if (relay_cfg()) return 'live';
    return !empty($S['manual']) ? 'man' : 'test';
}

function relay_cfg(): ?array {
    $r = mm_config()['relay'] ?? null;
    if (!is_array($r) || empty($r['url']) || empty($r['secret']) || str_contains((string) $r['url'], 'PASTE')) return null;
    return $r;
}

function breeze_token(): ?string {
    if (!is_file(BREEZE_SESSION)) return null;
    $raw = (string) file_get_contents(BREEZE_SESSION);
    $raw = substr($raw, strpos($raw, "\n") + 1);
    $s = json_decode($raw, true);
    $today = ist_now()->format('Y-m-d');
    return is_array($s) && !empty($s['token']) && ($s['date'] ?? '') === $today ? (string) $s['token'] : null;
}

// Signed call to the order relay on the VPS: HMAC over time + body, rejected after 60 s.
function relay(string $action, array $payload): array {
    $cfg = relay_cfg();
    if (!$cfg) throw new RuntimeException('Order relay is not configured');
    $token = breeze_token();
    if (!$token) throw new RuntimeException('ICICI is not logged in today');
    $body = json_encode(['action' => $action, 'session' => $token, 'payload' => $payload], JSON_UNESCAPED_SLASHES);
    $t = (string) time();
    $ch = curl_init($cfg['url']);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-MM-Time: ' . $t, 'X-MM-Sig: ' . hash_hmac('sha256', $t . "\n" . $body, (string) $cfg['secret'])],
    ]);
    $resp = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    $j = is_string($resp) ? json_decode($resp, true) : null;
    if (!is_array($j)) throw new RuntimeException('Relay did not answer' . ($err ? ": $err" : " (HTTP $status)"));
    if ($status !== 200 || !empty($j['error'])) throw new RuntimeException('Relay: ' . ($j['error'] ?? "HTTP $status"));
    return $j;
}

function order_row(PDO $pdo, int $id): array {
    $st = $pdo->prepare('SELECT * FROM trade_orders WHERE id = ?');
    $st->execute([$id]);
    $o = $st->fetch();
    if (!$o) mm_json(404, ['error' => 'Order not found']);
    return $o;
}

// The ICICI order body for one of our orders
function breeze_order(array $o): array {
    $isOpt = $o['product'] === 'option';
    $isFut = $o['product'] === 'future';
    $b = [
        'stock_code' => is_fo($o) ? $o['opt_isec'] : $o['symbol'],
        'exchange_code' => exch($o),
        'product' => $isOpt ? 'options' : ($isFut ? 'futures' : ($o['product'] === 'mis' ? 'margin' : 'cash')),
        'action' => $o['side'],
        'order_type' => $o['order_type'] === 'stoploss' ? 'stoploss' : 'limit',
        'stoploss' => $o['order_type'] === 'stoploss' ? (string) $o['trigger_price'] : '',
        'quantity' => (string) $o['qty'],
        'price' => (string) $o['limit_price'],
        'validity' => 'day',
        'disclosed_quantity' => '0',
        'user_remark' => 'MarketMind' . $o['id'],
    ];
    if ($isOpt) {
        $b += [
            'validity_date' => ist_now()->format('Y-m-d') . 'T06:00:00.000Z',
            'expiry_date' => $o['opt_expiry'] . 'T06:00:00.000Z',
            'right' => $o['opt_right'] === 'put' ? 'put' : 'call',
            'strike_price' => (string) (0 + $o['opt_strike']),
        ];
    }
    if ($isFut) {
        $b += [
            'validity_date' => ist_now()->format('Y-m-d') . 'T06:00:00.000Z',
            'expiry_date' => $o['opt_expiry'] . 'T06:00:00.000Z',
            'right' => 'others',
            'strike_price' => '0',
        ];
    }
    return $b;
}

function close_parent(PDO $pdo, array $exit, float $price): void {
    if (!$exit['parent_id']) return;
    $p = order_row($pdo, (int) $exit['parent_id']);
    if ($p['status'] !== 'filled') return;
    $pnl = ($price - (float) $p['fill_price']) * (int) $p['qty'];
    $pdo->prepare("UPDATE trade_orders SET status = 'closed', exit_price = ?, closed_at = ?, pnl = ? WHERE id = ?")
        ->execute([$price, mm_now(), round($pnl, 2), $p['id']]);
    // Any other exit for this position (e.g. the resting stop-loss) is no longer needed
    $st = $pdo->prepare("SELECT * FROM trade_orders WHERE parent_id = ? AND id <> ? AND status IN ('pending','open')");
    $st->execute([$p['id'], $exit['id']]);
    foreach ($st->fetchAll() as $sib) {
        if ($sib['status'] === 'open' && $sib['mode'] === 'live' && $sib['broker_order_id']) {
            try { relay('cancel', ['exchange_code' => exch($sib), 'order_id' => $sib['broker_order_id']]); } catch (Throwable $e) { /* reported on next sync */ }
        }
        $pdo->prepare("UPDATE trade_orders SET status = 'cancelled', decided_at = ? WHERE id = ?")->execute([mm_now(), $sib['id']]);
    }
}

// After an entry fills, propose the protective stop-loss so it can rest at ICICI
function propose_stop(PDO $pdo, array $entry): void {
    if ($entry['stop'] === null) return;
    $stop = (float) $entry['stop'];
    $limit = round($stop * 0.99, 1);  // a little below the trigger so it fills in a fast fall
    $pdo->prepare("INSERT INTO trade_orders (parent_id, symbol, name, product, purpose, side, order_type, qty, lot, limit_price, trigger_price, stop, target, opt_isec, opt_expiry, opt_strike, opt_right, timeframe, verdict, reason, status, mode, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'stoploss', 'sell', 'stoploss', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, '', ?, 'pending', ?, ?, ?)")
        ->execute([$entry['id'], $entry['symbol'], $entry['name'], $entry['product'], $entry['qty'], $entry['lot'], $limit, $stop,
            $entry['opt_isec'], $entry['opt_expiry'], $entry['opt_strike'], $entry['opt_right'], $entry['timeframe'],
            "Protect the position: a stop-loss order resting at ICICI sells if price falls to ₹$stop, even when MarketMind is closed.",
            $entry['mode'], mm_now(), (new DateTime('+8 hours'))->format('Y-m-d H:i:s')]);
}

function mark_filled(PDO $pdo, array $o, float $price): void {
    $pdo->prepare("UPDATE trade_orders SET status = 'filled', fill_price = ?, filled_at = ? WHERE id = ?")->execute([$price, mm_now(), $o['id']]);
    if ($o['purpose'] === 'entry') propose_stop($pdo, order_row($pdo, (int) $o['id']));
    else close_parent($pdo, $o, $price);
}

function state(PDO $pdo, array $defaults): array {
    // Proposals not approved in time expire
    $pdo->prepare("UPDATE trade_orders SET status = 'expired' WHERE status = 'pending' AND expires_at < ?")->execute([mm_now()]);
    $orders = $pdo->query("SELECT * FROM trade_orders WHERE status IN ('pending','open','filled') OR created_at >= '" . gmdate('Y-m-d H:i:s', time() - 7 * 86400) . "' ORDER BY id DESC LIMIT 200")->fetchAll();
    // ICICI's own stock code (e.g. RELIND for RELIANCE) helps find the stock in the ICICI app
    $syms = array_values(array_unique(array_column($orders, 'symbol')));
    $codes = [];
    if ($syms) {
        $st = $pdo->prepare("SELECT symbol, isec_code FROM stocks WHERE exchange = 'NSE' AND symbol IN (" . implode(',', array_fill(0, count($syms), '?')) . ')');
        $st->execute($syms);
        foreach ($st->fetchAll() as $r) $codes[$r['symbol']] = $r['isec_code'];
    }
    foreach ($orders as &$o) $o['icici_code'] = is_fo($o) ? $o['opt_isec'] : ($codes[$o['symbol']] ?? '');
    unset($o);
    return [
        'settings' => settings($pdo, $defaults),
        'watchlist' => $pdo->query('SELECT * FROM trade_watchlist ORDER BY symbol')->fetchAll(),
        'orders' => $orders,
        'mode' => order_mode(settings($pdo, $defaults)),
        'icici' => (bool) breeze_token(),
        'marketOpen' => market_open(),
        'serverTime' => time(),
    ];
}

// ---------- actions ----------
$action = (string) ($_GET['action'] ?? '');
try {
    $admin = mm_require_admin();
    $pdo = mm_db();

    if ($action === 'state') mm_json(200, state($pdo, $DEFAULTS));

    $body = mm_require_post();
    $S = settings($pdo, $DEFAULTS);

    if ($action === 'settings') {
        $num = fn($k, $min, $max) => isset($body[$k]) && is_numeric($body[$k]) ? max($min, min($max, (float) $body[$k])) : $S[$k];
        save_setting($pdo, 'account', $num('account', 1000, 1e9));
        save_setting($pdo, 'riskPct', $num('riskPct', 0.1, 5));
        save_setting($pdo, 'maxPerTrade', $num('maxPerTrade', 500, 1e8));
        save_setting($pdo, 'maxOrdersDay', (int) $num('maxOrdersDay', 1, 20));
        save_setting($pdo, 'maxOpen', (int) $num('maxOpen', 1, 20));
        save_setting($pdo, 'optionStopPct', $num('optionStopPct', 10, 90));
        save_setting($pdo, 'optionTargetPct', $num('optionTargetPct', 10, 500));
        save_setting($pdo, 'optionRiskPct', $num('optionRiskPct', 0.5, 10));
        save_setting($pdo, 'futuresRiskPct', $num('futuresRiskPct', 0.5, 10));
        if (array_key_exists('automation', $body)) save_setting($pdo, 'automation', $body['automation'] === 'semi' ? 'semi' : 'onetap');
        if (array_key_exists('futuresLive', $body)) save_setting($pdo, 'futuresLive', (bool) $body['futuresLive']);
        if (array_key_exists('enabled', $body)) save_setting($pdo, 'enabled', (bool) $body['enabled']);
        if (array_key_exists('manual', $body)) save_setting($pdo, 'manual', (bool) $body['manual']);
        mm_json(200, state($pdo, $DEFAULTS));
    }

    if ($action === 'watch_add') {
        $sym = strtoupper(mm_str($body, 'symbol', 20));
        if (!preg_match('/^[A-Z0-9&\-]{1,20}$/', $sym) || preg_match('/^\d{6}$/', $sym)) mm_json(400, ['error' => 'Use an NSE symbol (BSE-only stocks can\'t be traded here)']);
        $sql = mm_is_sqlite($pdo) ? 'INSERT OR IGNORE' : 'INSERT IGNORE';
        $pdo->prepare("$sql INTO trade_watchlist (symbol, name, delivery, intraday, options, futures, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            ->execute([$sym, mm_str($body, 'name', 150), empty($body['delivery']) ? 0 : 1, empty($body['intraday']) ? 0 : 1, empty($body['options']) ? 0 : 1, empty($body['futures']) ? 0 : 1, mm_now()]);
        mm_json(200, state($pdo, $DEFAULTS));
    }
    if ($action === 'watch_update') {
        $pdo->prepare('UPDATE trade_watchlist SET delivery = ?, intraday = ?, options = ?, futures = ? WHERE id = ?')
            ->execute([empty($body['delivery']) ? 0 : 1, empty($body['intraday']) ? 0 : 1, empty($body['options']) ? 0 : 1, empty($body['futures']) ? 0 : 1, (int) ($body['id'] ?? 0)]);
        mm_json(200, state($pdo, $DEFAULTS));
    }
    if ($action === 'watch_remove') {
        $pdo->prepare('DELETE FROM trade_watchlist WHERE id = ?')->execute([(int) ($body['id'] ?? 0)]);
        mm_json(200, state($pdo, $DEFAULTS));
    }

    // Scanner proposals. Entries need trading switched on; exits are always accepted.
    if ($action === 'propose') {
        $added = 0;
        $mode = order_mode($S);
        foreach (array_slice((array) ($body['orders'] ?? []), 0, 20) as $p) {
            if (!is_array($p)) continue;
            $purpose = in_array($p['purpose'] ?? '', ['entry', 'target', 'squareoff', 'exit'], true) ? $p['purpose'] : null;
            $product = in_array($p['product'] ?? '', ['cnc', 'mis', 'option', 'future'], true) ? $p['product'] : null;
            $sym = strtoupper((string) ($p['symbol'] ?? ''));
            $qty = (int) ($p['qty'] ?? 0);
            $limit = (float) ($p['limit'] ?? 0);
            if (!$purpose || !$product || !preg_match('/^[A-Z0-9&\-]{1,20}$/', $sym) || $qty < 1 || $limit <= 0) continue;
            if ($purpose === 'entry') {
                if (!$S['enabled'] || $S['killed']) continue;
                // One live idea per symbol and product: skip if one is pending, open or held, or was turned down in the last hour
                $st = $pdo->prepare("SELECT COUNT(*) FROM trade_orders WHERE symbol = ? AND product = ? AND purpose = 'entry' AND (status IN ('pending','open','filled') OR (status IN ('rejected','expired') AND created_at > ?))");
                $st->execute([$sym, $product, gmdate('Y-m-d H:i:s', time() - 3600)]);
                if ((int) $st->fetchColumn() > 0) continue;
                $parent = null;
                $side = 'buy';
            } else {
                $parent = (int) ($p['parentId'] ?? 0);
                $par = $pdo->prepare("SELECT * FROM trade_orders WHERE id = ? AND status = 'filled' AND purpose = 'entry'");
                $par->execute([$parent]);
                $po = $par->fetch();
                if (!$po) continue;
                $dup = $pdo->prepare("SELECT COUNT(*) FROM trade_orders WHERE parent_id = ? AND purpose <> 'stoploss' AND status IN ('pending','open')");
                $dup->execute([$parent]);
                if ((int) $dup->fetchColumn() > 0) continue;
                $qty = (int) $po['qty'];
                $side = 'sell';
            }
            $opt = in_array($product, ['option', 'future'], true) ? $p['option'] ?? [] : [];
            $pdo->prepare("INSERT INTO trade_orders (parent_id, symbol, name, product, purpose, side, order_type, qty, lot, limit_price, trigger_price, stop, target, opt_isec, opt_expiry, opt_strike, opt_right, timeframe, verdict, reason, status, mode, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, 'limit', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
                ->execute([
                    $parent ?: null, $sym, mb_substr((string) ($p['name'] ?? ''), 0, 150), $product, $purpose, $side, $qty, max(1, (int) ($p['lot'] ?? 1)),
                    round($limit, 2), isset($p['stop']) ? round((float) $p['stop'], 2) : null, isset($p['target']) ? round((float) $p['target'], 2) : null,
                    $opt['isec'] ?? null, $opt['expiry'] ?? null, $opt['strike'] ?? null, $opt['right'] ?? null,
                    in_array($p['timeframe'] ?? '', ['1d', '15m', '5m'], true) ? $p['timeframe'] : '1d',
                    mb_substr((string) ($p['verdict'] ?? ''), 0, 40), mb_substr((string) ($p['reason'] ?? ''), 0, 2000),
                    $mode, mm_now(), (new DateTime('+' . PENDING_MINUTES . ' minutes'))->format('Y-m-d H:i:s'),
                ]);
            $added++;
        }
        mm_json(200, ['added' => $added] + state($pdo, $DEFAULTS));
    }

    if ($action === 'reject') {
        $o = order_row($pdo, (int) ($body['id'] ?? 0));
        if ($o['status'] === 'pending') $pdo->prepare("UPDATE trade_orders SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?")->execute([mm_now(), $admin['id'], $o['id']]);
        mm_json(200, state($pdo, $DEFAULTS));
    }

    if ($action === 'approve') {
        $o = order_row($pdo, (int) ($body['id'] ?? 0));
        $fail = fn(string $m) => mm_json(400, ['error' => $m]);
        if ($o['status'] !== 'pending') $fail('This order is no longer waiting for approval');
        if (strtotime($o['expires_at'] . ' UTC') < time()) {
            $pdo->prepare("UPDATE trade_orders SET status = 'expired' WHERE id = ?")->execute([$o['id']]);
            $fail('This proposal is more than ' . PENDING_MINUTES . ' minutes old, so the price may have moved. Wait for a fresh one.');
        }
        if ($S['killed']) $fail('The kill switch is on. Turn trading back on first.');
        if (!market_open()) $fail('The market is closed (9:15 am – 3:30 pm IST, Mon–Fri).');
        if ($o['purpose'] === 'entry') {
            if (!$S['enabled']) $fail('Trading is switched off in Settings.');
            if ($o['product'] === 'mis' && ist_mins() > 14 * 60 + 45) $fail('Too late in the day for a new intraday position (after 2:45 pm).');
            $value = (float) $o['limit_price'] * (int) $o['qty'];
            $risk = $o['stop'] !== null ? abs((float) $o['limit_price'] - (float) $o['stop']) * (int) $o['qty'] : null;
            $riskCap = ['option' => 'optionRiskPct', 'future' => 'futuresRiskPct'][$o['product']] ?? 'riskPct';
            $paperFut = $o['product'] === 'future' && empty($S['futuresLive']);
            if ($risk !== null && !$paperFut && $risk > (float) $S['account'] * (float) $S[$riskCap] / 100 * 1.02) $fail('This trade could lose ₹' . number_format($risk) . ', above your limit of ' . $S[$riskCap] . '% of capital per trade.');
            if ($o['product'] === 'future') { /* futures: notional is far above the per-trade value cap; the risk check above applies */ }
            elseif ($value > (float) $S['maxPerTrade'] * 1.001) $fail('Order value ₹' . number_format($value) . ' is above your limit of ₹' . number_format((float) $S['maxPerTrade']) . ' per trade.');
            $todayStart = (new DateTime(ist_now()->format('Y-m-d') . ' 00:00:00', new DateTimeZone('Asia/Kolkata')))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
            $st = $pdo->prepare("SELECT COUNT(*) FROM trade_orders WHERE purpose = 'entry' AND decided_at >= ? AND status IN ('open','filled','closed')");
            $st->execute([$todayStart]);
            if ((int) $st->fetchColumn() >= (int) $S['maxOrdersDay']) $fail("You've reached today's limit of {$S['maxOrdersDay']} new trades.");
            $open = (int) $pdo->query("SELECT COUNT(*) FROM trade_orders WHERE purpose = 'entry' AND status IN ('open','filled')")->fetchColumn();
            if ($open >= (int) $S['maxOpen']) $fail("You already have $open open positions (limit {$S['maxOpen']}).");
        }

        $mode = order_mode($S, $o);
        $pdo->prepare("UPDATE trade_orders SET mode = ?, decided_at = ?, decided_by = ? WHERE id = ?")->execute([$mode, mm_now(), $admin['id'], $o['id']]);
        if ($mode === 'man') {
            $pdo->prepare("UPDATE trade_orders SET status = 'open', broker_status = 'Place in ICICI app' WHERE id = ?")->execute([$o['id']]);
            mm_json(200, ['message' => 'Approved. Now place it in the ICICI Direct app using the order ticket, then record the fill here.'] + state($pdo, $DEFAULTS));
        }
        if ($mode === 'test') {
            $pdo->prepare("UPDATE trade_orders SET status = 'open', broker_status = 'Simulated' WHERE id = ?")->execute([$o['id']]);
            mm_json(200, ['message' => 'Test mode: order simulated, nothing was sent to ICICI.'] + state($pdo, $DEFAULTS));
        }
        try {
            $r = relay('place', breeze_order($o));
            $oid = (string) ($r['Success']['order_id'] ?? '');
            if ($oid === '') throw new RuntimeException('ICICI returned no order id');
            $pdo->prepare("UPDATE trade_orders SET status = 'open', broker_order_id = ?, broker_status = 'Ordered' WHERE id = ?")->execute([$oid, $o['id']]);
            mm_json(200, ['message' => "Sent to ICICI (order $oid)."] + state($pdo, $DEFAULTS));
        } catch (Throwable $e) {
            $pdo->prepare("UPDATE trade_orders SET status = 'failed', error = ? WHERE id = ?")->execute([$e->getMessage(), $o['id']]);
            mm_json(502, ['error' => 'ICICI did not accept the order: ' . $e->getMessage()]);
        }
    }

    if ($action === 'kill') {
        save_setting($pdo, 'killed', true);
        $pdo->exec("UPDATE trade_orders SET status = 'rejected' WHERE status = 'pending' AND purpose = 'entry'");
        $cancelled = 0;
        // Unfilled entry orders at ICICI are cancelled; filled positions and their stop-losses stay
        foreach ($pdo->query("SELECT * FROM trade_orders WHERE status = 'open' AND purpose = 'entry'")->fetchAll() as $o) {
            if ($o['mode'] === 'live' && $o['broker_order_id']) {
                try { relay('cancel', ['exchange_code' => exch($o), 'order_id' => $o['broker_order_id']]); } catch (Throwable $e) { continue; }
            }
            $pdo->prepare("UPDATE trade_orders SET status = 'cancelled' WHERE id = ?")->execute([$o['id']]);
            $cancelled++;
        }
        mm_json(200, ['message' => "Kill switch on. $cancelled unfilled order(s) cancelled. Open positions and their stop-losses were left in place."] + state($pdo, $DEFAULTS));
    }
    // Manual mode: you tell MarketMind what happened in the ICICI app
    if ($action === 'manual_fill') {
        $o = order_row($pdo, (int) ($body['id'] ?? 0));
        $price = (float) ($body['price'] ?? 0);
        if ($o['status'] !== 'open' || $o['mode'] !== 'man') mm_json(400, ['error' => 'This order is not waiting to be placed in the ICICI app']);
        if ($price <= 0) mm_json(400, ['error' => 'Enter the price it filled at']);
        // Exits: remind to cancel the other exit order still sitting in the ICICI app
        $remind = '';
        if ($o['parent_id']) {
            $st = $pdo->prepare("SELECT purpose FROM trade_orders WHERE parent_id = ? AND id <> ? AND status = 'open' AND mode = 'man'");
            $st->execute([$o['parent_id'], $o['id']]);
            if ($st->fetchColumn()) $remind = ' Also cancel your other open exit order for ' . $o['symbol'] . ' (the stop-loss) in the ICICI app.';
        }
        mark_filled($pdo, $o, $price);
        mm_json(200, ['message' => 'Fill recorded at ₹' . number_format($price, 2) . '.' . $remind] + state($pdo, $DEFAULTS));
    }
    if ($action === 'manual_cancel') {
        $o = order_row($pdo, (int) ($body['id'] ?? 0));
        if ($o['status'] !== 'open' || $o['mode'] !== 'man') mm_json(400, ['error' => 'This order is not waiting to be placed in the ICICI app']);
        $pdo->prepare("UPDATE trade_orders SET status = 'cancelled', decided_at = ? WHERE id = ?")->execute([mm_now(), $o['id']]);
        mm_json(200, state($pdo, $DEFAULTS));
    }

    if ($action === 'resume') {
        save_setting($pdo, 'killed', false);
        mm_json(200, state($pdo, $DEFAULTS));
    }

    if ($action === 'sync') {
        $fills = [];
        foreach ((array) ($body['fills'] ?? []) as $f) if (is_array($f)) $fills[(int) ($f['id'] ?? 0)] = (float) ($f['price'] ?? 0);
        foreach ($pdo->query("SELECT * FROM trade_orders WHERE status = 'open'")->fetchAll() as $o) {
            if ($o['mode'] === 'test') {
                // The scanner reports when the live price crossed a simulated order's level
                if (!empty($fills[(int) $o['id']]) && $fills[(int) $o['id']] > 0) mark_filled($pdo, $o, $fills[(int) $o['id']]);
                continue;
            }
            if (!$o['broker_order_id']) continue;
            try {
                $r = relay('detail', ['exchange_code' => exch($o), 'order_id' => $o['broker_order_id']]);
                $d = ($r['Success'] ?? [])[0] ?? null;
                if (!$d) continue;
                $status = (string) ($d['status'] ?? '');
                $pdo->prepare('UPDATE trade_orders SET broker_status = ? WHERE id = ?')->execute([$status, $o['id']]);
                if (preg_match('/execut|complete|traded/i', $status)) {
                    $avg = (float) ($d['average_price'] ?? 0) ?: (float) $o['limit_price'];
                    mark_filled($pdo, $o, $avg);
                } elseif (preg_match('/cancel|reject|expire/i', $status)) {
                    $pdo->prepare("UPDATE trade_orders SET status = ?, error = ? WHERE id = ?")
                        ->execute([stripos($status, 'reject') !== false ? 'failed' : 'cancelled', (string) ($d['exchange_remark'] ?? $d['remarks'] ?? '') ?: null, $o['id']]);
                }
            } catch (Throwable $e) { /* try again next sync */ }
        }
        mm_json(200, state($pdo, $DEFAULTS));
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    mm_json(502, ['error' => $e->getMessage()]);
}

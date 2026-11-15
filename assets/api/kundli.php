<?php
// MarketMind AI — data for the kundli pages.
//
// GET ?action=fundamentals&symbol=TCS -> { price, q: [{period, revenue, profit, eps}], pe, epsTtm, roe, de, debt, equity,
//                                         holding: [{date, promoter, public}], pledge: {pct, date}|null, notes }
// GET ?action=delivery&symbol=TCS     -> { date, pct, qty, traded }   (NSE daily file "sec_bhavdata_full")
// GET ?action=mf_search&q=parag       -> { funds: [{code, name}] }    (mfapi.in)
// GET ?action=mf&code=122639          -> { meta, nav: [[YYYY-MM-DD, nav], ...] oldest first }
// Amounts from Yahoo are in rupees; P/E uses the last four quarters' diluted EPS.

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';

const KD_CACHE = __DIR__ . '/.kundli-cache2'; // v2: P/E sanity check
const KD_NSE = 'https://www.nseindia.com';
const KD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function kd_cache_get(string $key, int $ttl): ?array {
    $f = KD_CACHE . '/' . md5($key) . '.php';
    if (!is_file($f) || time() - filemtime($f) >= $ttl) return null;
    $raw = (string) file_get_contents($f);
    $d = json_decode(substr($raw, strpos($raw, "\n") + 1), true);
    return is_array($d) ? $d : null;
}
function kd_cache_put(string $key, array $data): void {
    if (!is_dir(KD_CACHE)) @mkdir(KD_CACHE, 0700, true);
    @file_put_contents(KD_CACHE . '/' . md5($key) . '.php', "<?php exit; ?>\n" . json_encode($data), LOCK_EX);
}
function kd_get(string $url, array $headers = [], bool $cookies = false, int $timeout = 20): array {
    $ch = curl_init($url);
    $o = [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $timeout, CURLOPT_FOLLOWLOCATION => true, CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => array_merge(['User-Agent: ' . KD_UA, 'Accept-Language: en-US,en;q=0.9'], $headers)];
    if ($cookies) { if (!is_dir(KD_CACHE)) @mkdir(KD_CACHE, 0700, true); $o[CURLOPT_COOKIEJAR] = $o[CURLOPT_COOKIEFILE] = KD_CACHE . '/nse-cookies.txt'; }
    curl_setopt_array($ch, $o);
    $b = curl_exec($ch); $s = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    return [$s, $b === false ? '' : (string) $b];
}
function kd_nse(string $path, string $warm): ?array {
    $h = ['Accept: application/json, text/plain, */*', 'Referer: ' . KD_NSE . $warm];
    [$s, $b] = kd_get(KD_NSE . $path, $h, true);
    if ($s !== 200) { kd_get(KD_NSE . '/', ['Accept: text/html'], true); kd_get(KD_NSE . $warm, ['Accept: text/html'], true); [$s, $b] = kd_get(KD_NSE . $path, $h, true); }
    $j = json_decode($b, true);
    return $s === 200 && is_array($j) ? $j : null;
}
function kd_num($v): ?float { return is_numeric($v) ? (float) $v : (is_string($v) && is_numeric(str_replace(',', '', $v)) ? (float) str_replace(',', '', $v) : null); }

function kd_fundamentals(string $sym): array {
    $notes = [];
    $types = ['quarterlyTotalRevenue', 'quarterlyNetIncome', 'quarterlyDilutedEPS', 'quarterlyBasicEPS', 'annualTotalDebt', 'annualStockholdersEquity', 'annualNetIncome', 'quarterlyTotalDebt', 'quarterlyStockholdersEquity'];
    $now = time();
    [$st, $b] = kd_get('https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/' . rawurlencode($sym . '.NS') . '?type=' . implode(',', $types) . '&period1=' . ($now - 6 * 365 * 86400) . '&period2=' . $now, ['Accept: application/json']);
    $by = [];
    foreach ((array) (json_decode($b, true)['timeseries']['result'] ?? []) as $res) {
        $t = $res['meta']['type'][0] ?? '';
        foreach ((array) ($res[$t] ?? []) as $v) if (is_array($v) && isset($v['asOfDate'], $v['reportedValue']['raw'])) $by[$t][$v['asOfDate']] = (float) $v['reportedValue']['raw'];
    }
    if (!$by) $notes[] = 'Yahoo returned no financial figures (HTTP ' . $st . ')';
    $q = [];
    $dates = array_unique(array_merge(array_keys($by['quarterlyTotalRevenue'] ?? []), array_keys($by['quarterlyNetIncome'] ?? [])));
    sort($dates);
    foreach ($dates as $d) $q[] = ['period' => $d, 'revenue' => $by['quarterlyTotalRevenue'][$d] ?? null, 'profit' => $by['quarterlyNetIncome'][$d] ?? null,
        'eps' => $by['quarterlyDilutedEPS'][$d] ?? $by['quarterlyBasicEPS'][$d] ?? null];
    $last = fn($k) => isset($by[$k]) && $by[$k] ? $by[$k][max(array_keys($by[$k]))] : null;
    $eps4 = array_values(array_filter(array_map(fn($x) => $x['eps'], array_slice($q, -4)), fn($v) => $v !== null));
    $epsTtm = count($eps4) === 4 ? array_sum($eps4) : null;
    // Price from Yahoo chart meta
    [, $cb] = kd_get('https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($sym . '.NS') . '?range=5d&interval=1d', ['Accept: application/json']);
    $meta = json_decode($cb, true)['chart']['result'][0]['meta'] ?? [];
    $price = isset($meta['regularMarketPrice']) ? (float) $meta['regularMarketPrice'] : null;
    $debt = $last('quarterlyTotalDebt') ?? $last('annualTotalDebt');
    $equity = $last('quarterlyStockholdersEquity') ?? $last('annualStockholdersEquity');
    $ni4 = array_values(array_filter(array_map(fn($x) => $x['profit'], array_slice($q, -4)), fn($v) => $v !== null));
    $niTtm = count($ni4) === 4 ? array_sum($ni4) : $last('annualNetIncome');
    $out = [
        'price' => $price, 'q' => array_slice($q, -12), 'epsTtm' => $epsTtm,
        // P/E above 300 usually means Yahoo reports this company's EPS in another currency (e.g. Infosys in USD): leave it out
        'pe' => $price && $epsTtm && $epsTtm > 0 && $price / $epsTtm <= 300 ? round($price / $epsTtm, 1) : null,
        'roe' => $niTtm !== null && $equity && abs($niTtm / $equity) <= 2 ? round($niTtm / $equity * 100, 1) : null,
        'de' => $debt !== null && $equity ? round($debt / $equity, 2) : null,
        'debt' => $debt, 'equity' => $equity,
    ];
    // Shareholding (NSE): promoter and public %, last 6 quarters
    $sh = kd_nse('/api/corporate-share-holdings-master?index=equities&symbol=' . rawurlencode($sym), '/companies-listing/corporate-filings-shareholding-pattern');
    $out['holding'] = [];
    if (is_array($sh)) foreach (array_slice(array_is_list($sh) ? $sh : ($sh['data'] ?? []), 0, 6) as $r) {
        if (!is_array($r)) continue;
        $d = DateTime::createFromFormat('d-M-Y', ucfirst(strtolower((string) ($r['date'] ?? ''))));
        $out['holding'][] = ['date' => $d ? $d->format('Y-m-d') : (string) ($r['date'] ?? ''), 'promoter' => kd_num($r['pr_and_prgrp'] ?? null), 'public' => kd_num($r['public_val'] ?? null)];
    } else $notes[] = 'NSE shareholding not available';
    // Pledged promoter shares (NSE)
    $pl = kd_nse('/api/corporate-pledgedata?index=equities&symbol=' . rawurlencode($sym), '/companies-listing/corporate-filings-pledged-data');
    $row = is_array($pl) ? (($pl['data'] ?? [])[0] ?? null) : null;
    $out['pledge'] = is_array($row) ? ['pct' => kd_num($row['percSharesPledged'] ?? $row['per3'] ?? $row['pledgedPercentage'] ?? null), 'date' => (string) ($row['shp'] ?? $row['date'] ?? ''), 'keys' => array_keys($row)]
        : (is_array($pl) ? ['pct' => 0.0, 'date' => '', 'none' => true] : null);
    $out['notes'] = $notes;
    return $out;
}

// Delivery % from NSE's daily "full bhavcopy" file (latest available trading day, cached for the day)
function kd_delivery_map(): ?array {
    $tz = new DateTimeZone('Asia/Kolkata');
    for ($i = 0; $i < 6; $i++) {
        $d = new DateTime("-$i days", $tz);
        if ((int) $d->format('N') >= 6) continue;
        $key = 'bhav|' . $d->format('Ymd');
        if ($hit = kd_cache_get($key, 86400 * 7)) return $hit;
        [$s, $b] = kd_get('https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_' . $d->format('dmY') . '.csv', ['Accept: text/csv,*/*'], false, 30);
        if ($s !== 200 || strpos($b, 'DELIV_PER') === false) continue;
        $lines = preg_split('/\r?\n/', trim($b));
        $hdr = array_map('trim', str_getcsv(array_shift($lines)));
        $ix = array_flip($hdr);
        $map = ['date' => $d->format('Y-m-d'), 'rows' => []];
        foreach ($lines as $ln) {
            $c = array_map('trim', str_getcsv($ln));
            if (($c[$ix['SERIES']] ?? '') !== 'EQ') continue;
            $map['rows'][$c[$ix['SYMBOL']]] = [kd_num($c[$ix['DELIV_PER']] ?? null), kd_num($c[$ix['DELIV_QTY']] ?? null), kd_num($c[$ix['TTL_TRD_QNTY']] ?? null), kd_num($c[$ix['TURNOVER_LACS']] ?? null)];
        }
        kd_cache_put($key, $map);
        return $map;
    }
    return null;
}

$action = (string) ($_GET['action'] ?? '');
try {
    mm_require_user();
    $sym = strtoupper(trim((string) ($_GET['symbol'] ?? '')));
    if (in_array($action, ['fundamentals', 'delivery'], true) && !preg_match('/^[A-Z0-9&\-]{1,20}$/', $sym)) mm_json(400, ['error' => 'Invalid symbol']);

    if ($action === 'fundamentals') {
        if (!($d = kd_cache_get("fund|$sym", 6 * 3600))) { $d = kd_fundamentals($sym) + ['at' => time()]; kd_cache_put("fund|$sym", $d); }
        mm_json(200, $d);
    }
    if ($action === 'delivery') {
        $m = kd_delivery_map();
        if (!$m) mm_json(200, ['pct' => null, 'note' => 'NSE daily file not reachable from the server']);
        $r = $m['rows'][$sym] ?? null;
        mm_json(200, $r ? ['date' => $m['date'], 'pct' => $r[0], 'qty' => $r[1], 'traded' => $r[2], 'turnoverLakh' => $r[3]] : ['date' => $m['date'], 'pct' => null, 'note' => 'not in the EQ series that day']);
    }
    if ($action === 'mf_search') {
        $q = trim((string) ($_GET['q'] ?? ''));
        if (mb_strlen($q) < 3) mm_json(200, ['funds' => []]);
        if (!($d = kd_cache_get('mfs|' . strtolower($q), 86400))) {
            [, $b] = kd_get('https://api.mfapi.in/mf/search?q=' . rawurlencode($q), ['Accept: application/json']);
            $d = ['funds' => array_slice(array_map(fn($r) => ['code' => (int) $r['schemeCode'], 'name' => (string) $r['schemeName']], (array) json_decode($b, true)), 0, 40)];
            kd_cache_put('mfs|' . strtolower($q), $d);
        }
        mm_json(200, $d);
    }
    if ($action === 'mf') {
        $code = (int) ($_GET['code'] ?? 0);
        if ($code <= 0) mm_json(400, ['error' => 'Invalid fund code']);
        if (!($d = kd_cache_get("mf|$code", 6 * 3600))) {
            [$s, $b] = kd_get('https://api.mfapi.in/mf/' . $code, ['Accept: application/json'], false, 30);
            $j = json_decode($b, true);
            if ($s !== 200 || empty($j['data'])) mm_json(502, ['error' => 'Fund data not available right now']);
            $nav = [];
            foreach (array_reverse($j['data']) as $r) { $dt = DateTime::createFromFormat('d-m-Y', (string) $r['date']); if ($dt && is_numeric($r['nav'])) $nav[] = [$dt->format('Y-m-d'), (float) $r['nav']]; }
            $d = ['meta' => $j['meta'] ?? [], 'nav' => $nav];
            kd_cache_put("mf|$code", $d);
        }
        mm_json(200, $d);
    }
    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind kundli error: ' . $e->getMessage());
    mm_json(502, ['error' => $e->getMessage()]);
}

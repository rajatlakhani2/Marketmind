<?php
// MarketMind AI — full NSE + BSE equity list: download, import into MySQL, search.
//
// Sources, in order:
//   1. ICICI Direct security master (NSEScripMaster.txt + BSEScripMaster.txt) — also
//      gives the ICICI stock codes the Breeze connector needs
//   2. NSE's EQUITY_L.csv / SME list and BSE's scrip list, if ICICI can't be reached

declare(strict_types=1);

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === realpath(__FILE__)) { http_response_code(404); exit; }

const MM_ICICI_MASTER = 'https://directlink.icicidirect.com/MotherAppMaster/SecurityMaster.zip';
const MM_NSE_LISTS = [
    'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',
    'https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv',
];
const MM_BSE_LIST = 'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active';

function mm_http_get(string $url, array $headers = [], int $timeout = 60): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_ENCODING       => '',
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        CURLOPT_HTTPHEADER     => $headers,
    ]);
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    return [$status, $body === false ? null : (string) $body, $err];
}

// Equity shares have ISINs like INE + 4 issuer chars + "01" (security type) + ...
function mm_is_equity_isin(string $isin): bool {
    return (bool) preg_match('/^IN[EF][A-Z0-9]{4}01[A-Z0-9]{3}$/', $isin);
}

function mm_clean(string $s): string { return trim($s, " \"\t\r\n"); }

// Parse a comma-separated file with a header row into rows keyed by header name.
function mm_csv_rows(string $text): array {
    $lines = preg_split('/\r\n|\n|\r/', $text);
    $header = array_map(fn($h) => mm_clean((string) $h), str_getcsv((string) array_shift($lines)));
    $rows = [];
    foreach ($lines as $line) {
        if (trim($line) === '') continue;
        $c = str_getcsv($line);
        $r = [];
        foreach ($header as $i => $h) $r[$h] = mm_clean((string) ($c[$i] ?? ''));
        $rows[] = $r;
    }
    return $rows;
}

// First non-empty value among several possible column names.
function mm_col(array $row, array $names): string {
    foreach ($names as $n) if (isset($row[$n]) && $row[$n] !== '') return $row[$n];
    return '';
}

// Returns [list of stocks, source description]. Each stock:
// [exchange, symbol, name, isin, series, isec_code]
function mm_download_stock_list(): array {
    $stocks = [];
    $notes = [];

    // 1. ICICI security master
    try {
        if (!class_exists('ZipArchive')) throw new RuntimeException('PHP zip extension missing');
        [$st, $zipData, $err] = mm_http_get(MM_ICICI_MASTER, [], 120);
        if ($zipData === null || $st !== 200) throw new RuntimeException($err ?: "HTTP $st");
        $tmp = tempnam(sys_get_temp_dir(), 'mmsm');
        file_put_contents($tmp, $zipData);
        $zip = new ZipArchive();
        if ($zip->open($tmp) !== true) { @unlink($tmp); throw new RuntimeException('not a valid zip'); }
        $nse = $zip->getFromName('NSEScripMaster.txt');
        $bse = $zip->getFromName('BSEScripMaster.txt');
        $zip->close();
        @unlink($tmp);
        if ($nse !== false) {
            foreach (mm_csv_rows($nse) as $r) {
                $sym = strtoupper(mm_col($r, ['ExchangeCode', 'Symbol']));
                $isin = strtoupper(mm_col($r, ['ISINCode', 'ISIN', 'ISIN Code']));
                $series = strtoupper(mm_col($r, ['Series']));
                if ($sym === '' || !mm_is_equity_isin($isin)) continue;
                if (!in_array($series, ['EQ', 'BE', 'BZ', 'SM', 'ST', 'SZ', ''], true)) continue;
                $stocks['NSE|' . $sym] = ['NSE', $sym, mm_col($r, ['CompanyName', 'ScripName', 'Name']), $isin, $series, strtoupper(mm_col($r, ['ShortName']))];
            }
        }
        if ($bse !== false) {
            foreach (mm_csv_rows($bse) as $r) {
                $code = mm_col($r, ['Token', 'ScripCode', 'Scrip Code']);
                $isin = strtoupper(mm_col($r, ['ISINCode', 'ISIN', 'ISIN Code']));
                if (!preg_match('/^\d{6}$/', $code) || !mm_is_equity_isin($isin)) continue;
                $stocks['BSE|' . $code] = ['BSE', $code, mm_col($r, ['CompanyName', 'ScripName', 'Name']), $isin, strtoupper(mm_col($r, ['Series', 'ScripGroup', 'Group'])), strtoupper(mm_col($r, ['ShortName']))];
            }
        }
        $notes[] = 'ICICI security master';
    } catch (Throwable $e) {
        $notes[] = 'ICICI master failed: ' . $e->getMessage();
    }

    $haveNse = (bool) array_filter(array_keys($stocks), fn($k) => strpos($k, 'NSE|') === 0);
    $haveBse = (bool) array_filter(array_keys($stocks), fn($k) => strpos($k, 'BSE|') === 0);

    // 2a. NSE's own lists
    if (!$haveNse) {
        foreach (MM_NSE_LISTS as $url) {
            [$st, $csv] = mm_http_get($url, ['Accept: text/csv,*/*', 'Referer: https://www.nseindia.com/']);
            if ($csv === null || $st !== 200) { $notes[] = "NSE list failed (HTTP $st)"; continue; }
            foreach (mm_csv_rows($csv) as $r) {
                $sym = strtoupper(mm_col($r, ['SYMBOL']));
                $isin = strtoupper(mm_col($r, ['ISIN NUMBER', 'ISIN']));
                if ($sym === '' || !mm_is_equity_isin($isin)) continue;
                $stocks['NSE|' . $sym] = ['NSE', $sym, mm_col($r, ['NAME OF COMPANY', 'NAME_OF_COMPANY']), $isin, strtoupper(mm_col($r, ['SERIES'])), ''];
            }
            $notes[] = 'NSE ' . basename($url);
        }
    }

    // 2b. BSE's own list
    if (!$haveBse) {
        [$st, $json] = mm_http_get(MM_BSE_LIST, ['Accept: application/json', 'Referer: https://www.bseindia.com/', 'Origin: https://www.bseindia.com']);
        $rows = $json ? json_decode($json, true) : null;
        if (is_array($rows)) {
            foreach ($rows as $r) {
                $code = (string) ($r['SCRIP_CD'] ?? '');
                $isin = strtoupper((string) ($r['ISIN_NUMBER'] ?? ''));
                if (!preg_match('/^\d{6}$/', $code) || !mm_is_equity_isin($isin)) continue;
                $stocks['BSE|' . $code] = ['BSE', $code, trim((string) ($r['Issuer_Name'] ?? $r['Scrip_Name'] ?? '')), $isin, strtoupper(trim((string) ($r['GROUP'] ?? ''))), ''];
            }
            $notes[] = 'BSE scrip list';
        } else {
            $notes[] = "BSE list failed (HTTP $st)";
        }
    }

    return [array_values($stocks), implode('; ', $notes)];
}

// Download and save the list. Returns a summary.
function mm_refresh_stocks(PDO $pdo): array {
    @set_time_limit(300);
    [$list, $source] = mm_download_stock_list();
    if (count($list) < 500) throw new RuntimeException('Stock list download failed or looked incomplete (' . count($list) . ' rows). ' . $source);

    $existing = [];
    foreach ($pdo->query('SELECT id, exchange, symbol, name, isin, series, isec_code, is_active FROM stocks') as $r) {
        $existing[$r['exchange'] . '|' . $r['symbol']] = $r;
    }
    $now = mm_now();
    $ins = $pdo->prepare('INSERT INTO stocks (exchange, symbol, name, isin, series, isec_code, is_active, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
    $upd = $pdo->prepare('UPDATE stocks SET name = ?, isin = ?, series = ?, isec_code = ?, is_active = 1, updated_at = ? WHERE id = ?');
    $added = $changed = 0;
    $seen = [];
    $pdo->beginTransaction();
    try {
        foreach ($list as [$exch, $sym, $name, $isin, $series, $isec]) {
            $key = "$exch|$sym";
            $seen[$key] = true;
            $name = mb_substr($name !== '' ? $name : $sym, 0, 150);
            $series = substr($series, 0, 5);
            $isec = substr($isec, 0, 20);
            if (!isset($existing[$key])) { $ins->execute([$exch, $sym, $name, $isin, $series, $isec, $now]); $added++; continue; }
            $e = $existing[$key];
            if ($e['name'] !== $name || $e['isin'] !== $isin || $e['series'] !== $series || ($isec !== '' && $e['isec_code'] !== $isec) || !(int) $e['is_active']) {
                $upd->execute([$name, $isin, $series, $isec !== '' ? $isec : $e['isec_code'], $now, $e['id']]);
                $changed++;
            }
        }
        // Delisted / no longer in the lists
        $off = $pdo->prepare('UPDATE stocks SET is_active = 0, updated_at = ? WHERE id = ?');
        $removed = 0;
        foreach ($existing as $key => $e) {
            if (!isset($seen[$key]) && (int) $e['is_active']) { $off->execute([$now, $e['id']]); $removed++; }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    $counts = $pdo->query("SELECT exchange, COUNT(*) AS n FROM stocks WHERE is_active = 1 GROUP BY exchange")->fetchAll(PDO::FETCH_KEY_PAIR);
    $summary = ['nse' => (int) ($counts['NSE'] ?? 0), 'bse' => (int) ($counts['BSE'] ?? 0), 'added' => $added, 'changed' => $changed, 'removed' => $removed, 'source' => $source, 'at' => $now];
    mm_set_meta($pdo, 'stocks_refresh', $summary);
    return $summary;
}

// Small key/value store for app-wide state (last refresh, MindGuru generation, ...)
function mm_get_meta(PDO $pdo, string $key): ?array {
    $st = $pdo->prepare('SELECT value_json FROM app_meta WHERE meta_key = ?');
    $st->execute([$key]);
    $v = $st->fetchColumn();
    return $v === false ? null : json_decode((string) $v, true);
}

function mm_set_meta(PDO $pdo, string $key, array $value): void {
    $pdo->prepare('DELETE FROM app_meta WHERE meta_key = ?')->execute([$key]);
    $pdo->prepare('INSERT INTO app_meta (meta_key, value_json, updated_at) VALUES (?, ?, ?)')->execute([$key, json_encode($value), mm_now()]);
}

// Search by symbol, BSE code or company name. One result per company: the NSE listing
// when there is one (with its BSE code alongside), otherwise the BSE listing.
function mm_search_stocks(PDO $pdo, string $q, int $limit = 20): array {
    $q = trim($q);
    if ($q === '') return [];
    $like = str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $q); // '!' escapes LIKE wildcards (works in MySQL and SQLite)
    $st = $pdo->prepare("SELECT exchange, symbol, name, isin, series FROM stocks
        WHERE is_active = 1 AND (symbol LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!')
        ORDER BY (symbol = ?) DESC, (symbol LIKE ? ESCAPE '!') DESC, (name LIKE ? ESCAPE '!') DESC, LENGTH(symbol), symbol
        LIMIT 200");
    $st->execute([$like . '%', '%' . $like . '%', strtoupper($q), $like . '%', $like . '%']);
    $rows = $st->fetchAll();

    // Pair NSE and BSE listings of the same company (same ISIN)
    $isins = array_values(array_unique(array_filter(array_column($rows, 'isin'))));
    $pair = [];
    if ($isins) {
        $in = implode(',', array_fill(0, count($isins), '?'));
        $p = $pdo->prepare("SELECT exchange, symbol, isin FROM stocks WHERE is_active = 1 AND isin IN ($in)");
        $p->execute($isins);
        foreach ($p->fetchAll() as $r) $pair[$r['isin']][$r['exchange']] = $r['symbol'];
    }
    $out = [];
    $done = [];
    foreach ($rows as $r) {
        $key = $r['isin'] ?: $r['exchange'] . $r['symbol'];
        if (isset($done[$key])) continue;
        $done[$key] = true;
        $nse = $pair[$r['isin']]['NSE'] ?? ($r['exchange'] === 'NSE' ? $r['symbol'] : null);
        $bse = $pair[$r['isin']]['BSE'] ?? ($r['exchange'] === 'BSE' ? $r['symbol'] : null);
        $out[] = [
            'symbol' => $nse ?? $bse, 'exchange' => $nse ? 'NSE' : 'BSE',
            'nse' => $nse, 'bse' => $bse, 'name' => $r['name'], 'series' => $r['series'],
        ];
        if (count($out) >= $limit) break;
    }
    return $out;
}

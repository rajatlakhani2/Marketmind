<?php
// MarketMind AI — weekly database backup (optional, command line only).
//
// cPanel → Cron Jobs, once a week, e.g. Sunday night:
//   php /home/YOURACCOUNT/public_html/marketmind/api/backup.php
//
// Writes a gzipped SQL dump of every MarketMind table to a "marketmind-backups"
// folder ABOVE public_html (never reachable from the web) and keeps the newest 8.
// It reads the database settings from marketmind-config.php, so no password ever
// appears in the cron command.
//
// To restore: cPanel → phpMyAdmin → select the database → Import → choose the .sql.gz file.

declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require __DIR__ . '/lib/bootstrap.php';

const MM_BACKUPS_KEEP = 8;

$log = fn(string $m) => fwrite(STDOUT, '[' . gmdate('Y-m-d H:i:s') . " UTC] $m\n");

try {
    $pdo = mm_db();
    if (mm_is_sqlite($pdo)) throw new RuntimeException('Backups are for the MySQL database on the host');

    // Above public_html: .../public_html/marketmind/api -> account home
    $dir = dirname(__DIR__, 3) . '/marketmind-backups';
    if (!is_dir($dir) && !mkdir($dir, 0700, true)) throw new RuntimeException("Cannot create $dir");

    $file = $dir . '/marketmind-' . gmdate('Y-m-d-His') . '.sql.gz';
    $gz = gzopen($file, 'wb6');
    if (!$gz) throw new RuntimeException("Cannot write $file");

    $dbName = (string) (mm_config()['db']['name'] ?? '');
    gzwrite($gz, "-- MarketMind AI backup of `$dbName`, " . gmdate('Y-m-d H:i:s') . " UTC\n");
    gzwrite($gz, "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n");

    $tables = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
    $totalRows = 0;
    foreach ($tables as $t) {
        $q = '`' . str_replace('`', '``', $t) . '`';
        $create = $pdo->query("SHOW CREATE TABLE $q")->fetch(PDO::FETCH_NUM)[1];
        gzwrite($gz, "DROP TABLE IF EXISTS $q;\n$create;\n\n");

        $stmt = $pdo->query("SELECT * FROM $q");
        $batch = [];
        $rows = 0;
        while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
            $batch[] = '(' . implode(',', array_map(fn($v) => $v === null ? 'NULL' : $pdo->quote((string) $v), $row)) . ')';
            $rows++;
            if (count($batch) >= 200) {
                gzwrite($gz, "INSERT INTO $q VALUES\n" . implode(",\n", $batch) . ";\n");
                $batch = [];
            }
        }
        if ($batch) gzwrite($gz, "INSERT INTO $q VALUES\n" . implode(",\n", $batch) . ";\n");
        gzwrite($gz, "\n");
        $totalRows += $rows;
    }
    gzwrite($gz, "SET FOREIGN_KEY_CHECKS = 1;\n");
    gzclose($gz);
    chmod($file, 0600);

    // Keep only the newest MM_BACKUPS_KEEP files
    $all = glob($dir . '/marketmind-*.sql.gz') ?: [];
    rsort($all);
    foreach (array_slice($all, MM_BACKUPS_KEEP) as $old) @unlink($old);

    $log(sprintf('Backup written: %s (%d tables, %d rows, %.1f KB)', basename($file), count($tables), $totalRows, filesize($file) / 1024));
} catch (Throwable $e) {
    $log('Backup failed: ' . $e->getMessage());
    exit(1);
}

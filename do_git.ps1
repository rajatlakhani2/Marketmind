$g = 'C:\Users\Honey\AppData\Local\Programs\Git\cmd\git.exe'
$d = 'C:\Users\Honey\OneDrive - G. K. Choksi & Co\Rajat work\1. AI\Share Market\Share Market'
Set-Location $d
& $g --version
& $g rev-parse --is-inside-work-tree
if ($LASTEXITCODE -ne 0) {
  & $g init
  Write-Output 'INIT_DONE'
}
& $g add .
& $g commit -m 'Initial commit: MarketMind AI with KS-001 Demand & Supply analysis'
Write-Output 'COMMIT_DONE'

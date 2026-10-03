$g = 'C:\Users\Honey\AppData\Local\Programs\Git\cmd\git.exe'
$fso = New-Object -ComObject Scripting.FileSystemObject
$folder = $fso.GetFolder('C:\Users\Honey\OneDrive - G. K. Choksi & Co\Rajat work\1. AI\Share Market\Share Market')
Write-Output $folder.ShortPath

$ErrorActionPreference = 'Stop'
$traeRoot = Split-Path -Parent $PSScriptRoot
$traeStart = Join-Path $traeRoot 'Start-TraeAPI.ps1'
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'Trae Enterprise Local.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $traeStart + '"'
$shortcut.WorkingDirectory = $traeRoot
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Output 'Installed current-user login startup: Trae Enterprise Local.lnk'

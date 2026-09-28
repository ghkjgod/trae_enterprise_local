$ErrorActionPreference = 'Stop'
$traePidFile = Join-Path $PSScriptRoot 'data\service.pid.json'
if (!(Test-Path -LiteralPath $traePidFile)) { exit 0 }
$record = Get-Content -LiteralPath $traePidFile -Raw | ConvertFrom-Json
$expectedScript = Join-Path $PSScriptRoot 'src\enterprise-server.js'
if ($record.script -ne $expectedScript) { throw 'PID file belongs to another checkout.' }
$traeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
if (!$traeProcess) { exit 0 }
if ($traeProcess.ExecutablePath -ne $record.executable -or $traeProcess.CommandLine -notmatch [regex]::Escape($expectedScript)) { throw 'PID belongs to another process; refusing to stop it.' }
Stop-Process -Id ([int]$record.pid)
Write-Output 'Trae enterprise API stopped.'

$ErrorActionPreference = 'Stop'
$state = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $state -Force | Out-Null
$port = 19900
foreach ($line in Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env')) { if ($line -match '^PORT=(\d+)\s*$') { $port = [int]$Matches[1] } }
$mutex = New-Object System.Threading.Mutex($false, "Local\TraeEnterpriseLocal-$port")
$locked = $false
try {
    try { $locked = $mutex.WaitOne(60000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw 'Startup is busy; try stopping again after it completes.' }
    Set-Content -LiteralPath (Join-Path $state 'service.paused') -Value 'Stopped manually; run Start-TraeAPI.ps1 to resume.'
    $pidFile = Join-Path $state 'service.pid.json'
    if (!(Test-Path -LiteralPath $pidFile)) { exit 0 }
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $script = Join-Path $PSScriptRoot 'src\enterprise-server.js'
    if ($record.script -ne $script) { throw 'PID file belongs to another checkout.' }
    $owned = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
    if (!$owned) { exit 0 }
    if ($owned.ExecutablePath -ne $record.executable -or $owned.CommandLine -notmatch [regex]::Escape('"' + $script + '"') -or ($record.createdTicks -and $owned.CreationDate.ToUniversalTime().Ticks.ToString() -ne $record.createdTicks)) { throw 'PID belongs to another process; refusing to stop it.' }
    Stop-Process -Id ([int]$record.pid)
    Write-Output 'Trae enterprise API stopped; automatic recovery paused.'
} finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }

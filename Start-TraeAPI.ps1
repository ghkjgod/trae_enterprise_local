param([switch]$Scheduled)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$state = Join-Path $root 'data'
$logs = Join-Path $root 'service-logs'
New-Item -ItemType Directory -Path $state,$logs -Force | Out-Null
$paused = Join-Path $state 'service.paused'
$pidFile = Join-Path $state 'service.pid.json'
$port = 19900
foreach ($line in Get-Content -LiteralPath (Join-Path $root '.env')) { if ($line -match '^PORT=(\d+)\s*$') { $port = [int]$Matches[1] } }
if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid PORT.' }
$mutex = New-Object System.Threading.Mutex($false, "Local\TraeEnterpriseLocal-$port")
$locked = $false
function Write-ServiceLog([string]$message) { Add-Content -LiteralPath (Join-Path $logs 'startup.log') -Value ("{0} {1}" -f (Get-Date -Format o), $message) }
function Sync-ClientModels {
    if (!(Test-Path -LiteralPath (Join-Path $root 'scripts\sync-opencode-models.cjs'))) { return }
    $runtime = Join-Path $root 'runtime\node.exe'
    if (!(Test-Path -LiteralPath $runtime)) { $runtime = (Get-Command node.exe -ErrorAction Stop).Source }
    # The synchronizer checks its five-minute interval before making requests.
    # Catalog/auth failures preserve client configuration and do not stop the proxy.
    try {
        $syncOutput = & $runtime (Join-Path $root 'scripts\sync-opencode-models.cjs') 2>&1
        if ($LASTEXITCODE -ne 0) { Write-ServiceLog 'model sync failed; inspect data/model-sync-state.json' }
        elseif ($syncOutput) { Write-ServiceLog ("model sync: " + ($syncOutput -join ' ')) }
    } catch { Write-ServiceLog 'model sync failed; inspect data/model-sync-state.json' }
}
function Get-LocalHealth {
    # Liveness uses no HTTP proxy, account credentials or model quota.
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/health")
    $request.Proxy = $null; $request.Timeout = 2000; $request.ReadWriteTimeout = 2000
    $response = $null
    try {
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { $result = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        if ($result.adapter -ne 'zedex-trae-cn-enterprise') { return 'foreign' }
        return 'healthy'
    } catch { return 'unreachable' }
    finally { if ($response) { $response.Dispose() } }
}
try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { exit 0 }
    if ($Scheduled -and (Test-Path -LiteralPath $paused)) { exit 0 }
    if (!$Scheduled -and (Test-Path -LiteralPath $paused)) { Remove-Item -LiteralPath $paused }
    $health = Get-LocalHealth
    if ($health -eq 'healthy') { Sync-ClientModels; exit 0 }
    if ($health -eq 'foreign') { throw 'The configured port is used by another service.' }
    $script = Join-Path $root 'src\enterprise-server.js'
    # Only restart our exact process, after three failed local probes.
    if (Test-Path -LiteralPath $pidFile) {
        $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
        $owned = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
        if ($owned) {
            if ($record.script -ne $script -or $owned.ExecutablePath -ne $record.executable -or $owned.CommandLine -notmatch [regex]::Escape('"' + $script + '"') -or $owned.CreationDate.ToUniversalTime().Ticks.ToString() -ne $record.createdTicks) {
                # Windows may reuse an old PID after reboot. Leave that process alone
                # and allow the missing proxy to start with a fresh identity.
                Write-ServiceLog 'ignoring stale PID record; the recorded process is not our proxy'
                $owned = $null
            }
        }
        if ($owned) {
            for ($attempt=0; $attempt -lt 2; $attempt++) {
                Start-Sleep -Seconds 2
                $health = Get-LocalHealth
                if ($health -eq 'healthy') { Sync-ClientModels; exit 0 }
                if ($health -eq 'foreign') { throw 'The configured port is used by another service.' }
            }
            Write-ServiceLog "restarting unresponsive proxy pid=$($record.pid)"
            Stop-Process -Id ([int]$record.pid)
            Wait-Process -Id ([int]$record.pid) -Timeout 5 -ErrorAction SilentlyContinue
        }
    }
    $node = Join-Path $root 'runtime\node.exe'
    if (!(Test-Path -LiteralPath $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
    if ([int]((& $node --version).TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node.js 24+ is required (runtime/node.exe or PATH).' }
    # Preserve the last ten stdout/stderr files for diagnosis.
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    foreach ($name in @('stdout','stderr')) {
        $current = Join-Path $logs "$name.log"
        if (Test-Path -LiteralPath $current) { Move-Item -LiteralPath $current -Destination (Join-Path $logs "$name-$stamp.log") }
        Get-ChildItem -LiteralPath $logs -Filter "$name-*.log" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
    }
    $child = Start-Process -FilePath $node -ArgumentList ('"' + $script + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'stdout.log') -RedirectStandardError (Join-Path $logs 'stderr.log') -PassThru
    $identity = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)"
    @{ pid=$child.Id; executable=$node; script=$script; createdTicks=$identity.CreationDate.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json | Set-Content -LiteralPath $pidFile
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ((Get-LocalHealth) -eq 'healthy') { Write-ServiceLog "ready pid=$($child.Id) port=$port"; Sync-ClientModels; Write-Output "Trae enterprise API ready on port $port."; exit 0 }
        $child.Refresh()
        if ($child.HasExited) { throw 'Proxy exited during startup; inspect service-logs/stderr.log.' }
    }
    throw 'Proxy did not become ready; inspect service-logs.'
} catch { Write-ServiceLog ("startup failure: " + $_.Exception.Message); throw }
finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }

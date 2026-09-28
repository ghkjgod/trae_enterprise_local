$ErrorActionPreference = 'Stop'
$traeRoot = $PSScriptRoot
$traeEnvFile = Join-Path $traeRoot '.env'
if (!(Test-Path -LiteralPath $traeEnvFile)) { throw 'Run npm run setup first.' }
$traePort = 19900
foreach ($line in Get-Content -LiteralPath $traeEnvFile) {
    if ($line -match '^PORT=(\d+)\s*$') { $traePort = [int]$Matches[1] }
}
if ($traePort -lt 1 -or $traePort -gt 65535) { throw 'Invalid PORT.' }
$traeHealthUrl = "http://127.0.0.1:$traePort/health"
try {
    $health = Invoke-RestMethod -Uri $traeHealthUrl -TimeoutSec 2
    if ($health.adapter -eq 'zedex-trae-cn-enterprise') { Write-Output 'Trae enterprise API is already running.'; exit 0 }
    throw 'The configured port is used by a different service.'
} catch {
    if ($_.Exception.Message -eq 'The configured port is used by a different service.') { throw }
}
$traeNode = (Get-Command node.exe -ErrorAction Stop).Source
$traeMajor = [int]((& $traeNode --version).TrimStart('v').Split('.')[0])
if ($traeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
$traeScript = Join-Path $traeRoot 'src\enterprise-server.js'
$traeState = Join-Path $traeRoot 'data'
$traeLogs = Join-Path $traeRoot 'service-logs'
New-Item -ItemType Directory -Path $traeLogs,$traeState -Force | Out-Null
$traeProcess = Start-Process -FilePath $traeNode -ArgumentList ('"' + $traeScript + '"') -WorkingDirectory $traeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $traeLogs 'stdout.log') -RedirectStandardError (Join-Path $traeLogs 'stderr.log') -PassThru
@{ pid=$traeProcess.Id; executable=$traeNode; script=$traeScript } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $traeState 'service.pid.json')
for ($attempt=0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri $traeHealthUrl -TimeoutSec 2
        if ($health.adapter -eq 'zedex-trae-cn-enterprise') { Write-Output "Trae enterprise API is ready on port $traePort."; exit 0 }
    } catch { }
    $traeProcess.Refresh()
    if ($traeProcess.HasExited) { throw 'Proxy exited; inspect service-logs/stderr.log locally.' }
}
throw 'Proxy did not become ready; inspect service-logs locally.'

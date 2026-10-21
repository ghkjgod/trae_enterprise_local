$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$start = Join-Path $root 'Start-TraeAPI-Hidden.vbs'
if (!(Test-Path -LiteralPath $start)) { throw 'Missing hidden startup launcher.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument ('//B //Nologo "' + $start + '"') -WorkingDirectory $root
$login = New-ScheduledTaskTrigger -AtLogOn -User $user
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'Trae Enterprise Local Recovery' -Action $action -Trigger @($login,$periodic) -Principal $principal -Settings $settings -Description 'Current-user login startup, one-minute proxy recovery, five-minute enterprise model synchronization into OpenCode and CC Switch. No inference calls.' -Force | Out-Null
# Retire one-shot shortcuts only after successful registration.
$backup = Join-Path $root 'data\startup-shortcut-backup'
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($name in @('Trae Local API.lnk','Trae Enterprise Local.lnk')) {
    $old = Join-Path ([Environment]::GetFolderPath('Startup')) $name
    if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination (Join-Path $backup ($name + '.' + (Get-Date -Format yyyyMMddHHmmss))) }
}
Start-ScheduledTask -TaskName 'Trae Enterprise Local Recovery'
Write-Output 'Installed login startup, one-minute recovery and five-minute model synchronization. Manual Stop pauses recovery; manual Start resumes it.'

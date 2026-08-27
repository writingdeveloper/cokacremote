param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$TaskPrefix = "cokacremote",
    [switch]$NoStart
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
$config = Read-CokacConfig $ConfigPath
$configPathResolved = Get-CokacRequired $config "__CONFIG_PATH"
$tunnelEnabled = ConvertTo-CokacBool (Get-CokacValue $config "TUNNEL_ENABLED" "false")
$currentUser = "$env:USERDOMAIN\$env:USERNAME"

function New-SupervisorSettings {
    return New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -MultipleInstances IgnoreNew
}

function Register-CokacTask {
    param(
        [string]$Name,
        [string]$ScriptPath,
        [string]$ExtraArgs,
        [object]$Trigger,
        [object]$Settings
    )
    $arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ScriptPath + '" -ConfigPath "' + $configPathResolved + '"' + $ExtraArgs
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Settings $Settings -Description ("cokacremote managed task: " + $Name) -Force | Out-Null
}

$logon = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
Register-CokacTask -Name $TaskPrefix -ScriptPath (Join-Path $PSScriptRoot "server-supervisor.ps1") -ExtraArgs "" -Trigger $logon -Settings (New-SupervisorSettings)
if ($tunnelEnabled) {
    Register-CokacTask -Name "$TaskPrefix-tunnel" -ScriptPath (Join-Path $PSScriptRoot "tunnel-supervisor.ps1") -ExtraArgs "" -Trigger $logon -Settings (New-SupervisorSettings)
} else {
    Unregister-ScheduledTask -TaskName "$TaskPrefix-tunnel" -Confirm:$false -ErrorAction SilentlyContinue
}

$watchdogTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$watchdogSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
Register-CokacTask `
    -Name "$TaskPrefix-watchdog" `
    -ScriptPath (Join-Path $PSScriptRoot "watchdog.ps1") `
    -ExtraArgs (' -TaskPrefix "' + $TaskPrefix + '"') `
    -Trigger $watchdogTrigger `
    -Settings $watchdogSettings

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskPrefix
    if ($tunnelEnabled) { Start-ScheduledTask -TaskName "$TaskPrefix-tunnel" }
}
Write-Output ("Installed Windows runtime tasks with prefix " + $TaskPrefix)

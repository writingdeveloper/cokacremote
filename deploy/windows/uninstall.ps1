param(
    [string]$TaskPrefix = "cokacremote",
    [string]$ConfigPath = ""
)
$ErrorActionPreference = "Continue"

$config = $null
if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
    . (Join-Path $PSScriptRoot "common.ps1")
    try {
        $config = Read-CokacConfig $ConfigPath
    } catch {
        Write-Warning ("Could not load runtime config for child cleanup: " + $_.Exception.Message)
    }
}

foreach ($name in @($TaskPrefix, "$TaskPrefix-tunnel", "$TaskPrefix-watchdog")) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}

if ($config) {
    try {
        foreach ($node in @(Get-CokacServerProcesses $config)) {
            Stop-Process -Id $node.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warning ("Could not remove server child processes: " + $_.Exception.Message)
    }
    try {
        foreach ($tunnel in @(Get-CokacTunnelProcesses $config)) {
            Stop-Process -Id $tunnel.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warning ("Could not remove tunnel child processes: " + $_.Exception.Message)
    }
}

Write-Output ("Removed Windows runtime tasks with prefix " + $TaskPrefix)

param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$TaskPrefix = "cokacremote",
    [switch]$JsonOnly
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")
$config = Read-CokacConfig $ConfigPath
$tunnelEnabled = ConvertTo-CokacBool (Get-CokacValue $config "TUNNEL_ENABLED" "false")
$taskNames = @($TaskPrefix, "$TaskPrefix-watchdog")
if ($tunnelEnabled) { $taskNames += "$TaskPrefix-tunnel" }
$tasks = @()
foreach ($name in $taskNames) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    $info = if ($task) { Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue } else { $null }
    $tasks += [pscustomobject]@{
        name = $name
        exists = [bool]$task
        state = if ($task) { [string]$task.State } else { "Missing" }
        lastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
    }
}
$listener = $null
try { $listener = Get-CokacServerListener $config } catch {}
$nodes = @(Get-CokacServerProcesses $config)
$tunnels = @(Get-CokacTunnelProcesses $config)
$healthy = Test-CokacHealth $config
$status = [pscustomobject]@{
    taskPrefix = $TaskPrefix
    configPath = Get-CokacRequired $config "__CONFIG_PATH"
    tasks = $tasks
    server = [pscustomobject]@{
        listenerPid = if ($listener) { [int]$listener.OwningProcess } else { $null }
        matchingProcesses = $nodes.Count
        duplicateCount = [Math]::Max(0, $nodes.Count - 1)
        health = $healthy
    }
    tunnel = [pscustomobject]@{
        enabled = $tunnelEnabled
        matchingProcesses = $tunnels.Count
        duplicateCount = [Math]::Max(0, $tunnels.Count - 1)
    }
}
$json = $status | ConvertTo-Json -Depth 6 -Compress
if ($JsonOnly) {
    Write-Output $json
    exit 0
}
Write-Output ("Tasks: " + (($tasks | ForEach-Object { $_.name + "=" + $_.state }) -join ", "))
Write-Output ("Server: health=" + $healthy + " listenerPid=" + $status.server.listenerPid + " matches=" + $nodes.Count)
Write-Output ("Tunnel: enabled=" + $tunnelEnabled + " matches=" + $tunnels.Count)
Write-Output ("STATUS_JSON=" + $json)

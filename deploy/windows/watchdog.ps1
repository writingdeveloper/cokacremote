param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$TaskPrefix = "cokacremote"
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")
$config = Read-CokacConfig $ConfigPath
$tunnelEnabled = ConvertTo-CokacBool (Get-CokacValue $config "TUNNEL_ENABLED" "false")
$taskNames = @($TaskPrefix)
if ($tunnelEnabled) { $taskNames += "$TaskPrefix-tunnel" }
foreach ($taskName in $taskNames) {
    try {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        if ($task.State -ne "Running") {
            Write-CokacRuntimeLog $config ("watchdog restarting " + $taskName + " from state " + $task.State)
            Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
        }
    } catch {
        Write-CokacRuntimeLog $config ("watchdog task error for " + $taskName + ": " + $_.Exception.Message)
    }
}
try {
    $listener = Get-CokacServerListener $config
    $nodes = @(Get-CokacServerProcesses $config)
    if ($nodes.Count -gt 1) {
        $keepPid = if ($listener) { [int]$listener.OwningProcess } else { [int]$nodes[0].ProcessId }
        foreach ($node in $nodes) {
            if ([int]$node.ProcessId -ne $keepPid) {
                Write-CokacRuntimeLog $config ("watchdog removing duplicate node PID " + $node.ProcessId)
                Stop-Process -Id $node.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
} catch {
    Write-CokacRuntimeLog $config ("watchdog server duplicate check error: " + $_.Exception.Message)
}
$failPath = Resolve-CokacPath $config (Get-CokacValue $config "WATCHDOG_FAILCOUNT_FILE" ".watchdog-server-failcount")
$healthUrl = if ($env:COKACREMOTE_WATCHDOG_HEALTH_URL) { $env:COKACREMOTE_WATCHDOG_HEALTH_URL } else { Get-CokacRequired $config "HEALTH_URL" }
$healthy = $false
try {
    $health = Invoke-WebRequest -UseBasicParsing $healthUrl -TimeoutSec 5
    $healthy = ([int]$health.StatusCode -eq 200)
} catch {}
if ($healthy) {
    Remove-Item -LiteralPath $failPath -Force -ErrorAction SilentlyContinue
} else {
    $failCount = 0
    if (Test-Path -LiteralPath $failPath) {
        [void][int]::TryParse((Get-Content -LiteralPath $failPath -Raw).Trim(), [ref]$failCount)
    }
    $failCount++
    Set-Content -LiteralPath $failPath -Value $failCount -Encoding ASCII
    Write-CokacRuntimeLog $config ("server health failure " + $failCount + " at " + $healthUrl)
    if ($failCount -ge 2) {
        foreach ($node in @(Get-CokacServerProcesses $config)) {
            Write-CokacRuntimeLog $config ("watchdog recycling unhealthy node PID " + $node.ProcessId)
            Stop-Process -Id $node.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $failPath -Force -ErrorAction SilentlyContinue
    }
}
if ($tunnelEnabled) {
    try {
        $tunnels = @(Get-CokacTunnelProcesses $config)
        if ($tunnels.Count -gt 1) {
            $wrapper = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
                $_.Name -eq "powershell.exe" -and $_.CommandLine -and $_.CommandLine -like "*tunnel-supervisor.ps1*" -and $_.CommandLine -like ("*" + $ConfigPath + "*")
            } | Select-Object -First 1
            $owned = if ($wrapper) { $tunnels | Where-Object { [int]$_.ParentProcessId -eq [int]$wrapper.ProcessId } | Select-Object -First 1 } else { $null }
            $keepPid = if ($owned) { [int]$owned.ProcessId } else { [int]$tunnels[0].ProcessId }
            foreach ($tunnel in $tunnels) {
                if ([int]$tunnel.ProcessId -ne $keepPid) {
                    Write-CokacRuntimeLog $config ("watchdog removing duplicate tunnel PID " + $tunnel.ProcessId)
                    Stop-Process -Id $tunnel.ProcessId -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } catch {
        Write-CokacRuntimeLog $config ("watchdog tunnel duplicate check error: " + $_.Exception.Message)
    }
}

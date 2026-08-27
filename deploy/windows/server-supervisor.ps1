param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
$config = Read-CokacConfig $ConfigPath
$repo = [System.IO.Path]::GetFullPath((Get-CokacRequired $config "REPO_PATH"))
$entry = Get-CokacServerEntry $config
$nodeSetting = Get-CokacValue $config "NODE_EXE" "node"
$nodeExe = if ([System.IO.Path]::IsPathRooted($nodeSetting)) { $nodeSetting } else { (Get-Command $nodeSetting -ErrorAction Stop).Source }
$envFileValue = Get-CokacValue $config "MCP_ENV_FILE" ""
$envFile = if ($envFileValue) { Resolve-CokacPath $config $envFileValue } else { "" }
$restartSeconds = [int](Get-CokacValue $config "SUPERVISOR_RESTART_SECONDS" "5")
$stdoutLog = Resolve-CokacPath $config (Get-CokacValue $config "SERVER_STDOUT_LOG" "server.out.log")
$stderrLog = Resolve-CokacPath $config (Get-CokacValue $config "SERVER_STDERR_LOG" "server.err.log")
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stdoutLog) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stderrLog) | Out-Null
Set-Location $repo

while ($true) {
    try {
        $child = Get-CokacServerProcess $config
        if ($child) {
            Write-CokacRuntimeLog $config ("server supervisor adopting PID " + $child.Id)
        } else {
            $args = @()
            if ($envFile) { $args += ("--env-file=" + $envFile) }
            $args += $entry
            $child = Start-Process -FilePath $nodeExe -ArgumentList $args -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
            Write-CokacRuntimeLog $config ("server supervisor started PID " + $child.Id)
        }
        $child.WaitForExit()
        Write-CokacRuntimeLog $config ("server child PID " + $child.Id + " exited; restarting")
    } catch {
        Write-CokacRuntimeLog $config ("server supervisor error: " + $_.Exception.Message)
    }
    Start-Sleep -Seconds $restartSeconds
}

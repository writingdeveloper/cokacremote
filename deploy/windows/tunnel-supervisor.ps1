param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
$config = Read-CokacConfig $ConfigPath
if (-not (ConvertTo-CokacBool (Get-CokacValue $config "TUNNEL_ENABLED" "false"))) { exit 0 }
$repo = [System.IO.Path]::GetFullPath((Get-CokacRequired $config "REPO_PATH"))
$spec = Get-CokacTunnelSpec $config
$restartSeconds = [int](Get-CokacValue $config "SUPERVISOR_RESTART_SECONDS" "5")
Set-Location $repo
while ($true) {
    try {
        $matches = @(Get-CokacTunnelProcesses $config)
        $child = if ($matches.Count -gt 0) { Get-Process -Id $matches[0].ProcessId -ErrorAction SilentlyContinue } else { $null }
        if ($child) {
            Write-CokacRuntimeLog $config ("tunnel supervisor adopting PID " + $child.Id)
        } else {
            $child = Start-Process -FilePath $spec.executable -ArgumentList $spec.arguments -WorkingDirectory $repo -WindowStyle Hidden -PassThru
            Write-CokacRuntimeLog $config ("tunnel supervisor started PID " + $child.Id + " mode=" + $spec.mode)
        }
        $child.WaitForExit()
        Write-CokacRuntimeLog $config ("tunnel child PID " + $child.Id + " exited; restarting")
    } catch {
        Write-CokacRuntimeLog $config ("tunnel supervisor error: " + $_.Exception.Message)
    }
    Start-Sleep -Seconds $restartSeconds
}

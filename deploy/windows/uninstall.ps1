param([string]$TaskPrefix = "cokacremote")
$ErrorActionPreference = "Continue"
foreach ($name in @($TaskPrefix, "$TaskPrefix-tunnel", "$TaskPrefix-watchdog")) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
Write-Output ("Removed Windows runtime tasks with prefix " + $TaskPrefix)

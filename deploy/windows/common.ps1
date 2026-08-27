Set-StrictMode -Version Latest

function Read-CokacConfig {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved)) { throw "Config file not found: $resolved" }
    $config = @{}
    foreach ($rawLine in Get-Content -LiteralPath $resolved) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith("#")) { continue }
        $index = $line.IndexOf("=")
        if ($index -lt 1) { throw "Invalid config line: $rawLine" }
        $key = $line.Substring(0, $index).Trim()
        $value = $line.Substring($index + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $config[$key] = [Environment]::ExpandEnvironmentVariables($value)
    }
    $config["__CONFIG_PATH"] = $resolved
    return $config
}

function Get-CokacRequired {
    param([hashtable]$Config, [string]$Name)
    if (-not $Config.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace([string]$Config[$Name])) {
        throw "Missing required config key: $Name"
    }
    return [string]$Config[$Name]
}

function Get-CokacValue {
    param([hashtable]$Config, [string]$Name, [string]$Default = "")
    if ($Config.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace([string]$Config[$Name])) {
        return [string]$Config[$Name]
    }
    return $Default
}

function ConvertTo-CokacBool {
    param([string]$Value, [bool]$Default = $false)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $Default }
    switch ($Value.Trim().ToLowerInvariant()) {
        { $_ -in @("1", "true", "yes", "on") } { return $true }
        { $_ -in @("0", "false", "no", "off") } { return $false }
        default { throw "Invalid boolean value: $Value" }
    }
}

function Resolve-CokacPath {
    param([hashtable]$Config, [string]$Value)
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    $repo = Get-CokacRequired $Config "REPO_PATH"
    return [System.IO.Path]::GetFullPath((Join-Path $repo $Value))
}

function Get-CokacServerEntry {
    param([hashtable]$Config)
    return Resolve-CokacPath $Config (Get-CokacValue $Config "SERVER_ENTRY" "dist\src\server.js")
}

function Get-CokacServerProcesses {
    param([hashtable]$Config)
    $entry = Get-CokacServerEntry $Config
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq "node.exe" -and $_.CommandLine -and $_.CommandLine.IndexOf($entry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

function Get-CokacServerListener {
    param([hashtable]$Config)
    $port = [int](Get-CokacRequired $Config "SERVER_PORT")
    return Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-CokacServerProcess {
    param([hashtable]$Config)
    $listener = Get-CokacServerListener $Config
    if (-not $listener) { return $null }
    $entry = Get-CokacServerEntry $Config
    $procInfo = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $listener.OwningProcess) -ErrorAction SilentlyContinue
    if ($procInfo -and $procInfo.Name -eq "node.exe" -and $procInfo.CommandLine -and $procInfo.CommandLine.IndexOf($entry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    }
    throw ("Port {0} is occupied by an unrelated process (PID {1})." -f $listener.LocalPort, $listener.OwningProcess)
}

function Get-CokacTunnelProcesses {
    param([hashtable]$Config)
    $enabled = ConvertTo-CokacBool (Get-CokacValue $Config "TUNNEL_ENABLED" "false")
    if (-not $enabled) { return @() }
    $exe = Resolve-CokacPath $Config (Get-CokacRequired $Config "TUNNEL_EXE")
    $configPath = Resolve-CokacPath $Config (Get-CokacRequired $Config "TUNNEL_CONFIG")
    $name = [System.IO.Path]::GetFileName($exe)
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq $name -and $_.CommandLine -and $_.CommandLine.IndexOf($configPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

function Test-CokacHealth {
    param([hashtable]$Config)
    $url = Get-CokacRequired $Config "HEALTH_URL"
    try {
        $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 5
        return ([int]$response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Write-CokacRuntimeLog {
    param([hashtable]$Config, [string]$Message)
    $repo = Get-CokacRequired $Config "REPO_PATH"
    $path = Resolve-CokacPath $Config (Get-CokacValue $Config "WATCHDOG_LOG" "watchdog.log")
    $parent = Split-Path -Parent $path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Add-Content -LiteralPath $path -Value ((Get-Date -Format o) + " " + $Message)
}

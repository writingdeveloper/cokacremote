import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const scripts = [
  "common.ps1",
  "server-supervisor.ps1",
  "tunnel-supervisor.ps1",
  "watchdog.ps1",
  "install.ps1",
  "uninstall.ps1",
  "status.ps1",
];
const deployRoot = path.resolve("deploy/windows");

describe.runIf(process.platform === "win32")("portable Windows deployment", () => {
  it("ships every runtime script and parses them with the PowerShell AST parser", () => {
    for (const script of scripts) {
      const scriptPath = path.join(deployRoot, script);
      expect(existsSync(scriptPath), script).toBe(true);
      const escaped = scriptPath.replaceAll("'", "''");
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      expect(output.trim(), script).toBe("");
    }
  });

  it("installs, reports, and removes an isolated scheduled-task runtime", () => {
    const prefix = `cokacremote-test-${process.pid}`;
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cokacremote-windows-deploy-"));
    const configPath = path.join(tempDir, "windows.env");
    const installPath = path.join(deployRoot, "install.ps1");
    const statusPath = path.join(deployRoot, "status.ps1");
    const uninstallPath = path.join(deployRoot, "uninstall.ps1");
    writeFileSync(
      configPath,
      [
        `REPO_PATH=${process.cwd()}`,
        "NODE_EXE=node",
        "SERVER_ENTRY=dist\src\server.js",
        "SERVER_PORT=65530",
        "HEALTH_URL=http://127.0.0.1:65530/health",
        "TUNNEL_ENABLED=false",
      ].join("\n"),
      "utf8",
    );
    const ps = (script: string, args: string[]) =>
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
        { encoding: "utf8", windowsHide: true },
      );

    try {
      ps(installPath, ["-ConfigPath", configPath, "-TaskPrefix", prefix, "-NoStart"]);
      const status = JSON.parse(
        ps(statusPath, ["-ConfigPath", configPath, "-TaskPrefix", prefix, "-JsonOnly"]).trim(),
      ) as { tasks: Array<{ name: string; exists: boolean; state: string }> };
      expect(status.tasks.map((task) => task.name).sort()).toEqual(
        [prefix, `${prefix}-watchdog`].sort(),
      );
      expect(status.tasks.every((task) => task.exists)).toBe(true);

      const escapedPrefix = prefix.replaceAll("'", "''");
      const settingsJson = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$server=Get-ScheduledTask -TaskName '${escapedPrefix}';$watchdog=Get-ScheduledTask -TaskName '${escapedPrefix}-watchdog';[pscustomobject]@{serverMultiple=[string]$server.Settings.MultipleInstances;serverLimit=[string]$server.Settings.ExecutionTimeLimit;serverStartWhenAvailable=$server.Settings.StartWhenAvailable;serverDisallowBattery=$server.Settings.DisallowStartIfOnBatteries;serverStopBattery=$server.Settings.StopIfGoingOnBatteries;serverRestartCount=$server.Settings.RestartCount;watchdogInterval=[string]$watchdog.Triggers[0].Repetition.Interval}|ConvertTo-Json -Compress`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      expect(JSON.parse(settingsJson)).toMatchObject({
        serverMultiple: "IgnoreNew",
        serverLimit: "PT0S",
        serverStartWhenAvailable: true,
        serverDisallowBattery: false,
        serverStopBattery: false,
        serverRestartCount: 999,
        watchdogInterval: "PT1M",
      });
    } finally {
      ps(uninstallPath, ["-TaskPrefix", prefix]);
      const escapedPrefix = prefix.replaceAll("'", "''");
      const remaining = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `$items=@(Get-ScheduledTask -TaskName '${escapedPrefix}*' -ErrorAction SilentlyContinue);Write-Output $items.Count`],
        { encoding: "utf8", windowsHide: true },
      ).trim();
      expect(remaining).toBe("0");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("provides a machine-neutral config example", () => {
    expect(existsSync(path.join(deployRoot, "windows.env.example"))).toBe(true);
  });
});

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
    expect(existsSync(path.join(deployRoot, "hidden-powershell.vbs"))).toBe(true);
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
          `$server=Get-ScheduledTask -TaskName '${escapedPrefix}';$watchdog=Get-ScheduledTask -TaskName '${escapedPrefix}-watchdog';[pscustomobject]@{serverMultiple=[string]$server.Settings.MultipleInstances;serverLimit=[string]$server.Settings.ExecutionTimeLimit;serverStartWhenAvailable=$server.Settings.StartWhenAvailable;serverDisallowBattery=$server.Settings.DisallowStartIfOnBatteries;serverStopBattery=$server.Settings.StopIfGoingOnBatteries;serverRestartCount=$server.Settings.RestartCount;watchdogInterval=[string]$watchdog.Triggers[0].Repetition.Interval;watchdogExecute=[string]$watchdog.Actions[0].Execute;watchdogArguments=[string]$watchdog.Actions[0].Arguments}|ConvertTo-Json -Compress`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      const settings = JSON.parse(settingsJson) as {
        serverMultiple: string;
        serverLimit: string;
        serverStartWhenAvailable: boolean;
        serverDisallowBattery: boolean;
        serverStopBattery: boolean;
        serverRestartCount: number;
        watchdogInterval: string;
        watchdogExecute: string;
        watchdogArguments: string;
      };
      expect(settings).toMatchObject({
        serverMultiple: "IgnoreNew",
        serverLimit: "PT0S",
        serverStartWhenAvailable: true,
        serverDisallowBattery: false,
        serverStopBattery: false,
        serverRestartCount: 999,
        watchdogInterval: "PT1M",
      });
      expect(settings.watchdogExecute).toMatch(/wscript\.exe$/i);
      expect(settings.watchdogArguments).toContain("hidden-powershell.vbs");
      expect(settings.watchdogArguments).toContain("watchdog.ps1");
      expect(settings.watchdogArguments).toContain("-TaskPrefix");
      expect(settings.watchdogArguments).toContain(prefix);
    } finally {
      ps(uninstallPath, ["-TaskPrefix", prefix, "-ConfigPath", configPath]);
      const escapedPrefix = prefix.replaceAll("'", "''");
      const remaining = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `$items=@(Get-ScheduledTask -TaskName '${escapedPrefix}*' -ErrorAction SilentlyContinue);Write-Output $items.Count`],
        { encoding: "utf8", windowsHide: true },
      ).trim();
      expect(remaining).toBe("0");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 90_000);

  it("supports Cloudflare token-file and config tunnel modes without exposing a token in arguments", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cokacremote-tunnel-spec-"));
    const tokenPath = path.join(tempDir, "tunnel.token");
    const tunnelConfigPath = path.join(tempDir, "cloudflared.yml");
    const fakeExe = path.join(tempDir, "cloudflared.exe");
    const runtimeConfig = path.join(tempDir, "windows.env");
    writeFileSync(tokenPath, "secret-not-command-line", "utf8");
    writeFileSync(tunnelConfigPath, "tunnel: example\n", "utf8");
    writeFileSync(fakeExe, "", "utf8");
    const commonPath = path.join(deployRoot, "common.ps1").replaceAll("'", "''");
    const ps = (configLines: string[]) => {
      writeFileSync(runtimeConfig, configLines.join("\n"), "utf8");
      const escapedConfig = runtimeConfig.replaceAll("'", "''");
      const raw = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `. '${commonPath}';$c=Read-CokacConfig '${escapedConfig}';Get-CokacTunnelSpec $c|ConvertTo-Json -Depth 5 -Compress`],
        { encoding: "utf8", windowsHide: true },
      );
      return JSON.parse(raw.trim()) as { mode: string; identity: string; url: string | null; arguments: string[] };
    };
    try {
      const base = [
        `REPO_PATH=${tempDir}`,
        "SERVER_PORT=3000",
        "TUNNEL_ENABLED=true",
        `TUNNEL_EXE=${fakeExe}`,
        "TUNNEL_LOG=tunnel.log",
      ];
      const tokenSpec = ps([...base, `TUNNEL_TOKEN_FILE=${tokenPath}`, "TUNNEL_URL=http://127.0.0.1:3000"]);
      expect(tokenSpec).toMatchObject({ mode: "token-file", url: "http://127.0.0.1:3000" });
      expect(path.win32.isAbsolute(tokenSpec.identity)).toBe(true);
      expect(path.win32.basename(tokenSpec.identity)).toBe("tunnel.token");
      expect(tokenSpec.arguments).toEqual(expect.arrayContaining(["--token-file", tokenSpec.identity, "--url", "http://127.0.0.1:3000"]));
      expect(tokenSpec.arguments.join(" ")).not.toContain("secret-not-command-line");

      const configSpec = ps([...base, `TUNNEL_CONFIG=${tunnelConfigPath}`]);
      expect(configSpec).toMatchObject({ mode: "config", url: null });
      expect(path.win32.isAbsolute(configSpec.identity)).toBe(true);
      expect(path.win32.basename(configSpec.identity)).toBe("cloudflared.yml");
      expect(configSpec.arguments).toEqual(expect.arrayContaining(["--config", configSpec.identity]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("provides a machine-neutral config example", () => {
    expect(existsSync(path.join(deployRoot, "windows.env.example"))).toBe(true);
  });
});

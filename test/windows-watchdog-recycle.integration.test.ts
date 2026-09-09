import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const deployRoot = path.resolve("deploy/windows");
const installPath = path.join(deployRoot, "install.ps1");
const uninstallPath = path.join(deployRoot, "uninstall.ps1");
const watchdogPath = path.join(deployRoot, "watchdog.ps1");
const statusPath = path.join(deployRoot, "status.ps1");

describe.runIf(process.platform === "win32")("Windows watchdog recycle recovery", () => {
  it("restarts the server scheduled task after the second catalog invariant failure even when HTTP is 200", async () => {
    const prefix = `cokacremote-watchdog-test-${process.pid}`;
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cokacremote-watchdog-recycle-"));
    const port = 65527;
    const entryPath = path.join(tempDir, "probe.mjs");
    const configPath = path.join(tempDir, "windows.env");
    writeFileSync(
      entryPath,
      `import http from "node:http";\nhttp.createServer((_, res) => { res.statusCode = 200; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ registeredToolCount: 21, toolCatalogRevision: "legacy-catalog" })); }).listen(${port}, "127.0.0.1");\n`,
      "utf8",
    );
    writeFileSync(
      configPath,
      [
        `REPO_PATH=${tempDir}`,
        `NODE_EXE=${process.execPath}`,
        `SERVER_ENTRY=${path.basename(entryPath)}`,
        `SERVER_PORT=${port}`,
        `HEALTH_URL=http://127.0.0.1:${port}/health`,
        "EXPECTED_TOOL_COUNT=27",
        "EXPECTED_CATALOG_REVISION=core-media-2026-09-09.1",
        "SERVER_STDOUT_LOG=stdout.log",
        "SERVER_STDERR_LOG=stderr.log",
        "WATCHDOG_LOG=watchdog.log",
        "WATCHDOG_FAILCOUNT_FILE=failcount",
        "SUPERVISOR_RESTART_SECONDS=1",
        "TUNNEL_ENABLED=false",
      ].join("\n"),
      "utf8",
    );
    const ps = (script: string, args: string[], env = process.env) =>
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
        { encoding: "utf8", windowsHide: true, env },
      );
    const taskLastRunMs = () => {
      const escaped = prefix.replaceAll("'", "''");
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-ScheduledTaskInfo -TaskName '${escaped}').LastRunTime.ToUniversalTime().Ticks`,
        ],
        { encoding: "utf8", windowsHide: true },
      ).trim();
      return BigInt(output);
    };

    try {
      ps(installPath, ["-ConfigPath", configPath, "-TaskPrefix", prefix, "-NoStart"]);
      execFileSync("powershell.exe", ["-NoProfile", "-Command", `Start-ScheduledTask -TaskName '${prefix}'`], {
        windowsHide: true,
        stdio: "ignore",
      });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:${port}/health -TimeoutSec 1).StatusCode`], {
            windowsHide: true,
            stdio: "ignore",
          });
          break;
        } catch {
          await delay(250);
        }
      }
      const invariantStatus = JSON.parse(
        ps(statusPath, ["-ConfigPath", configPath, "-TaskPrefix", prefix, "-JsonOnly"]).trim(),
      ) as {
        server: {
          health: boolean;
          healthReason: string;
          registeredToolCount: number | null;
          expectedToolCount: number | null;
          toolCatalogRevision: string | null;
          expectedCatalogRevision: string;
        };
      };
      expect(invariantStatus.server).toMatchObject({
        health: false,
        registeredToolCount: 21,
        expectedToolCount: 27,
        toolCatalogRevision: "legacy-catalog",
        expectedCatalogRevision: "core-media-2026-09-09.1",
      });
      expect(invariantStatus.server.healthReason).toContain("registeredToolCount expected 27 but got 21");
      expect(invariantStatus.server.healthReason).toContain("toolCatalogRevision expected core-media-2026-09-09.1 but got legacy-catalog");

      const before = taskLastRunMs();
      await delay(1200);
      ps(watchdogPath, ["-ConfigPath", configPath, "-TaskPrefix", prefix]);
      ps(watchdogPath, ["-ConfigPath", configPath, "-TaskPrefix", prefix]);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (taskLastRunMs() > before) break;
        await delay(250);
      }
      expect(taskLastRunMs()).toBeGreaterThan(before);
    } finally {
      ps(uninstallPath, ["-TaskPrefix", prefix, "-ConfigPath", configPath]);
      await delay(1500);
      try {
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      } catch {}
    }
  }, 120_000);
});

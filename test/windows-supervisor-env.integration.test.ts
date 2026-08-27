import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const supervisor = path.resolve("deploy/windows/server-supervisor.ps1");

describe.runIf(process.platform === "win32")("Windows server supervisor environment", () => {
  it("lets MCP_ENV_FILE override conflicting inherited variables", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cokacremote-supervisor-env-"));
    const resultPath = path.join(tempDir, "result.json");
    const entryPath = path.join(tempDir, "probe.mjs");
    const envPath = path.join(tempDir, "server.env");
    const configPath = path.join(tempDir, "windows.env");
    writeFileSync(
      entryPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ endpoint: process.env.MCP_ENDPOINT }));\nsetInterval(() => {}, 1000);\n`,
      "utf8",
    );
    writeFileSync(envPath, "MCP_ENDPOINT=/mcp\n", "utf8");
    writeFileSync(
      configPath,
      [
        `REPO_PATH=${tempDir}`,
        `MCP_ENV_FILE=${envPath}`,
        `NODE_EXE=${process.execPath}`,
        `SERVER_ENTRY=${path.basename(entryPath)}`,
        "SERVER_PORT=65529",
        "HEALTH_URL=http://127.0.0.1:65529/health",
        "SERVER_STDOUT_LOG=stdout.log",
        "SERVER_STDERR_LOG=stderr.log",
        "WATCHDOG_LOG=watchdog.log",
        "SUPERVISOR_RESTART_SECONDS=1",
        "TUNNEL_ENABLED=false",
      ].join("\n"),
      "utf8",
    );
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", supervisor, "-ConfigPath", configPath],
      {
        windowsHide: true,
        env: { ...process.env, MCP_ENDPOINT: "C:/Program Files/Git/mcp" },
        stdio: "ignore",
      },
    );
    try {
      for (let attempt = 0; attempt < 50 && !existsSync(resultPath); attempt += 1) {
        await delay(100);
      }
      expect(existsSync(resultPath)).toBe(true);
      expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({ endpoint: "/mcp" });
    } finally {
      if (child.pid) {
        try {
          execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {}
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});

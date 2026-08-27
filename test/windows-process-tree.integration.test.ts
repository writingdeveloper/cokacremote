import { execFile } from "node:child_process";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import { ProcessManager } from "../src/process-manager.js";
import { nodeCommand } from "./helpers/cross-platform-command.js";

function createManager(): ProcessManager {
  return new ProcessManager({
    maxRetainedOutputBytes: 1024 * 1024,
    processRetentionMs: 60_000,
    maxProcesses: 16,
    defaultMaxOutputBytes: 1024 * 1024,
  });
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(pidExists(pid), `PID ${pid} should have exited`).toBe(false);
}

async function forceCleanup(pid: number): Promise<void> {
  if (!pidExists(pid) || process.platform !== "win32") {
    return;
  }
  await new Promise<void>((resolve) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

const parentWithChildSource = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  console.log(child.pid);
  setInterval(() => {}, 1000);
`;

describe.runIf(process.platform === "win32")("Windows managed process trees", () => {
  let manager: ProcessManager | undefined;
  const cleanupPids = new Set<number>();

  afterEach(async () => {
    await manager?.shutdown();
    await Promise.all([...cleanupPids].map((pid) => forceCleanup(pid)));
    cleanupPids.clear();
  });

  it("terminates a parent and its descendant through ProcessManager.terminate", async () => {
    manager = createManager();
    const sessionId = manager.start({ ...nodeCommand(parentWithChildSource), cwd: process.cwd() });
    const started = await manager.read(sessionId, { waitMs: 3000 });
    const childPid = Number(started.output.trim().split(/\s+/).at(-1));
    const parentPid = started.pid;
    expect(parentPid).toEqual(expect.any(Number));
    expect(childPid).toBeGreaterThan(0);
    cleanupPids.add(childPid);

    await manager.terminate(sessionId, "SIGTERM", 250, "metadata");
    await waitForPidExit(parentPid!, 8000);
    await waitForPidExit(childPid, 8000);
    cleanupPids.delete(childPid);
  }, 15_000);

  it("removes descendants when a managed process times out", async () => {
    manager = createManager();
    const sessionId = manager.start({
      ...nodeCommand(parentWithChildSource),
      cwd: process.cwd(),
      timeoutMs: 1000,
    });
    const started = await manager.read(sessionId, { waitMs: 3000 });
    const childPid = Number(started.output.trim().split(/\s+/).at(-1));
    expect(childPid).toBeGreaterThan(0);
    cleanupPids.add(childPid);

    await manager.waitForExit(sessionId, 9000);
    const result = await manager.read(sessionId);
    expect(result.timedOut).toBe(true);
    expect(result.running).toBe(false);
    await waitForPidExit(childPid, 8000);
    cleanupPids.delete(childPid);
  }, 20_000);
});

import { spawn } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { signalProcessTree } from "../src/process-tree.js";

describe("signalProcessTree", () => {
  it.runIf(process.platform === "win32")(
    "starts Windows tree termination without blocking the Node event loop",
    async () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (child.pid === undefined) {
        throw new Error("Expected child PID");
      }

      const startedAt = Date.now();
      const termination = signalProcessTree(child.pid, "SIGTERM");
      const callDurationMs = Date.now() - startedAt;

      expect(callDurationMs).toBeLessThan(250);
      await termination;
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });
      expect(child.exitCode).not.toBeNull();
    },
    10_000,
  );
});

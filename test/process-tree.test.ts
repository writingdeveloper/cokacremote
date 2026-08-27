import { spawn } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { signalProcessTree } from "../src/process-tree.js";

describe("signalProcessTree", () => {
  it.runIf(process.platform === "win32")(
    "keeps graceful and forced Windows tree signaling asynchronous",
    async () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (child.pid === undefined) {
        throw new Error("Expected child PID");
      }

      const gracefulStartedAt = Date.now();
      await signalProcessTree(child.pid, "SIGTERM");
      expect(Date.now() - gracefulStartedAt).toBeLessThan(2000);

      if (child.exitCode === null) {
        const forceStartedAt = Date.now();
        await signalProcessTree(child.pid, "SIGKILL");
        expect(Date.now() - forceStartedAt).toBeLessThan(3000);
      }

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

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

      const assertNonBlocking = async (signal: NodeJS.Signals) => {
        const startedAt = Date.now();
        const signalPromise = signalProcessTree(child.pid!, signal);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(Date.now() - startedAt).toBeLessThan(1000);
        await Promise.race([
          signalPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`signalProcessTree ${signal} timed out`)), 10_000),
          ),
        ]);
      };

      await assertNonBlocking("SIGTERM");

      if (child.exitCode === null) {
        await assertNonBlocking("SIGKILL");
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

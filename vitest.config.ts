import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["codex/**", "node_modules/**", "dist/**"],
    // Windows integration tests exercise real process trees and Scheduled Tasks.
    // Running those files in parallel causes host-level contention and timing flakes.
    fileParallelism: process.platform !== "win32",
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});

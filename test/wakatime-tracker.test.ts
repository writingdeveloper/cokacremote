import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  WakaTimeTracker,
  type WakaTimeCommandRunner,
} from "../src/wakatime-tracker.js";

const execFileAsync = promisify(execFile);

class RecordingRunner implements WakaTimeCommandRunner {
  readonly calls: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv | undefined;
  }> = [];

  async run(
    command: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<void> {
    this.calls.push({ command, args: [...args], env: env ? { ...env } : undefined });
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createGitWorkspace(): Promise<{ directory: string; sourcePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cokacremote-wakatime-process-"));
  temporaryDirectories.push(directory);
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: directory });
  const sourcePath = path.join(directory, "src.ts");
  await writeFile(sourcePath, "export const value = 1;\n", "utf8");
  await execFileAsync("git", ["add", "src.ts"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
  return { directory, sourcePath };
}

describe("WakaTimeTracker", () => {
  it("labels file writes as ChatGPT AI coding without syncing Claude or Codex transcripts", async () => {
    const runner = new RecordingRunner();
    const tracker = new WakaTimeTracker({
      enabled: true,
      cliPath: "wakatime-test-cli",
      model: "gpt/5.6-sol",
      plugin: "chatgpt-web/0.1.0",
      trackReads: true,
      runner,
    });

    await tracker.trackFile("C:\\projects\\demo\\src\\index.ts", {
      write: true,
      aiLineChanges: 3,
    });

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.command).toBe("wakatime-test-cli");
    expect(call.args).toEqual(
      expect.arrayContaining([
        "--entity",
        "C:\\projects\\demo\\src\\index.ts",
        "--category",
        "ai coding",
        "--plugin",
        "gpt/5.6-sol chatgpt-web/0.1.0",
        "--sync-ai-disabled",
        "--ai-line-changes",
        "3",
        "--write",
      ]),
    );
  });

  it("isolates Cokacremote WakaTime state while reusing the existing config", async () => {
    const runner = new RecordingRunner();
    const home = path.join(os.tmpdir(), "cokacremote-wakatime-isolated");
    const configPath = "C:\\Users\\test\\.wakatime.cfg";
    const tracker = new WakaTimeTracker({
      enabled: true,
      cliPath: "wakatime-test-cli",
      home,
      configPath,
      plugin: "chatgpt-web/0.1.0",
      trackReads: true,
      runner,
    });

    await tracker.trackFile("C:\\projects\\demo\\src\\index.ts", { write: false });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args).toEqual(
      expect.arrayContaining(["--config", configPath]),
    );
    expect(runner.calls[0]!.env?.WAKATIME_HOME).toBe(home);
  });

  it("deduplicates repeated non-write heartbeats for the same file within two minutes", async () => {
    const runner = new RecordingRunner();
    let now = 1_000_000;
    const tracker = new WakaTimeTracker({
      enabled: true,
      cliPath: "wakatime-test-cli",
      plugin: "chatgpt-web/0.1.0",
      trackReads: true,
      runner,
      now: () => now,
    });

    await tracker.trackFile("C:\\projects\\demo\\src\\index.ts", { write: false });
    now += 30_000;
    await tracker.trackFile("C:\\projects\\demo\\src\\index.ts", { write: false });
    now += 91_000;
    await tracker.trackFile("C:\\projects\\demo\\src\\index.ts", { write: false });

    expect(runner.calls).toHaveLength(2);
  });
  it("can track reads without marking them as writes", async () => {
    const runner = new RecordingRunner();
    const tracker = new WakaTimeTracker({
      enabled: true,
      cliPath: "wakatime-test-cli",
      plugin: "chatgpt-web/0.1.0",
      trackReads: true,
      runner,
    });

    await tracker.trackFile("C:\\projects\\demo\\src\\index.ts", { write: false });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args).not.toContain("--write");
    expect(runner.calls[0]!.args).toContain("--sync-ai-disabled");
  });

  it("detects source files changed by an exec command in a git workspace", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cokacremote-wakatime-git-"));
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: directory });
    const sourcePath = path.join(directory, "src.ts");
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["add", "src.ts"], { cwd: directory });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });

    const runner = new RecordingRunner();
    const tracker = new WakaTimeTracker({
      enabled: true,
      cliPath: "wakatime-test-cli",
      plugin: "chatgpt-web/0.1.0",
      trackReads: true,
      runner,
    });

    const snapshot = await tracker.captureWorkspace(directory);
    await writeFile(sourcePath, "export const value = 2;\n", "utf8");
    await tracker.trackWorkspaceChanges(directory, snapshot);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args).toEqual(
      expect.arrayContaining(["--entity", sourcePath, "--write"]),
    );
  });

  it("drops stale process snapshots instead of tracking changes forever", async () => {
    const { directory, sourcePath } = await createGitWorkspace();
    const runner = new RecordingRunner();
    let now = 1_000;
    const tracker = new WakaTimeTracker({
      enabled: true,
      cliPath: "wakatime-test-cli",
      plugin: "chatgpt-web/0.1.0",
      trackReads: true,
      runner,
      now: () => now,
      processSnapshotRetentionMs: 1_000,
    });
    const snapshot = await tracker.captureWorkspace(directory);
    tracker.rememberProcess("stale", directory, snapshot);
    await writeFile(sourcePath, "export const value = 2;\n", "utf8");
    now += 1_001;

    await tracker.trackProcessCompletion("stale", false);

    expect(runner.calls).toHaveLength(0);
  });

  it("caps retained process snapshots and evicts the oldest session", async () => {
    const { directory, sourcePath } = await createGitWorkspace();
    const runner = new RecordingRunner();
    const tracker = new WakaTimeTracker({
      enabled: true,
      cliPath: "wakatime-test-cli",
      plugin: "chatgpt-web/0.1.0",
      trackReads: true,
      runner,
      maxProcessSnapshots: 2,
    });
    const snapshot = await tracker.captureWorkspace(directory);
    tracker.rememberProcess("first", directory, snapshot);
    tracker.rememberProcess("second", directory, snapshot);
    tracker.rememberProcess("third", directory, snapshot);
    await writeFile(sourcePath, "export const value = 3;\n", "utf8");

    await tracker.trackProcessCompletion("first", false);
    expect(runner.calls).toHaveLength(0);
    await tracker.trackProcessCompletion("third", false);
    expect(runner.calls).toHaveLength(1);
  });

  it("marks deleted files as unsaved write entities", async () => {
    const runner = new RecordingRunner();
    const tracker = new WakaTimeTracker({
      enabled: true,
      cliPath: "wakatime-test-cli",
      plugin: "chatgpt-web/0.1.0",
      trackReads: true,
      runner,
    });

    await tracker.trackFile("C:\\projects\\demo\\src\\deleted.ts", {
      write: true,
      unsaved: true,
      aiLineChanges: 4,
    });

    expect(runner.calls[0]!.args).toEqual(
      expect.arrayContaining([
        "--is-unsaved-entity",
        "--ai-line-changes",
        "4",
        "--write",
      ]),
    );
  });

  it("does nothing when disabled", async () => {
    const runner = new RecordingRunner();
    const tracker = new WakaTimeTracker({
      enabled: false,
      cliPath: "wakatime-test-cli",
      plugin: "chatgpt-web/0.1.0",
      trackReads: true,
      runner,
    });

    await tracker.trackFile("C:\\projects\\demo\\src\\index.ts", { write: true });

    expect(runner.calls).toHaveLength(0);
  });
});

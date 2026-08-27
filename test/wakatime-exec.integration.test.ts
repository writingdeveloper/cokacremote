import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { FileService } from "../src/file-service.js";
import { createMcpServer, type McpServices } from "../src/mcp-server.js";
import { ProcessManager } from "../src/process-manager.js";
import {
  WakaTimeTracker,
  type WakaTimeCommandRunner,
} from "../src/wakatime-tracker.js";

const execFileAsync = promisify(execFile);

class RecordingRunner implements WakaTimeCommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<void> {
    this.calls.push({ command, args: [...args] });
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

describe("exec tool WakaTime integration", () => {
  it("tracks a source file changed by exec_command, including completion through read_process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cokacremote-wakatime-exec-"));
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: directory });
    const sourcePath = path.join(directory, "src.ts");
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["add", "src.ts"], { cwd: directory });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });

    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "test-secret",
        MCP_DEFAULT_CWD: directory,
        MCP_DEFAULT_SHELL: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        MCP_WAKATIME_ENABLED: "true",
        MCP_WAKATIME_CLI: "wakatime-test-cli",
      },
      directory,
    );
    const runner = new RecordingRunner();
    const tracker = new WakaTimeTracker({
      enabled: true,
      cliPath: "wakatime-test-cli",
      plugin: "chatgpt-cokacremote/0.1.0",
      trackReads: true,
      trackShellChanges: true,
      runner,
    });
    const processManager = new ProcessManager({
      maxRetainedOutputBytes: config.maxRetainedProcessOutputBytes,
      processRetentionMs: config.processRetentionMs,
      maxProcesses: config.maxProcesses,
      defaultMaxOutputBytes: config.maxOutputBytes,
    });
    const fileService = new FileService({
      defaultCwd: directory,
      maxChunkBytes: config.maxFileChunkBytes,
      maxEditFileBytes: config.maxEditFileBytes,
      maxOutputBytes: config.maxOutputBytes,
      activityTracker: tracker,
    });
    const services = {
      processManager,
      fileService,
      wakatimeTracker: tracker,
    } as McpServices;
    const server = createMcpServer(config, services);
    const client = new Client({ name: "wakatime-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const started = await client.callTool({
        name: "exec_command",
        arguments: {
          cmd: "node -e \"setTimeout(() => require('fs').writeFileSync('src.ts', 'export const value = 2;\\n'), 100)\"",
          workdir: directory,
          yieldTimeMs: 0,
        },
      });
      expect(started.structuredContent).toMatchObject({ running: true, completed: false });
      const startedContent = started.structuredContent as { sessionId?: unknown } | undefined;
      const sessionId = String(startedContent?.sessionId);
      expect(runner.calls).toHaveLength(0);

      const completed = await client.callTool({
        name: "read_process",
        arguments: { sessionId, waitMs: 3000 },
      });
      expect(completed.structuredContent).toMatchObject({ running: false, completed: true });

      const deadline = Date.now() + 2000;
      while (runner.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]!.args).toEqual(
        expect.arrayContaining(["--entity", sourcePath, "--write"]),
      );
    } finally {
      await client.close();
      await server.close();
      await processManager.shutdown();
    }
  });
});

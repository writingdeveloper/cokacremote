import { McpServer } from "@modelcontextprotocol/server";
import type { AppConfig } from "./config.js";
import { registerExecTools } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { registerFileTools } from "./file-tools.js";
import { ProcessManager } from "./process-manager.js";
import { WakaTimeTracker } from "./wakatime-tracker.js";

export interface McpServices {
  processManager: ProcessManager;
  fileService: FileService;
  wakatimeTracker: WakaTimeTracker;
}

export function createServices(config: AppConfig): McpServices {
  const wakatimeTracker = new WakaTimeTracker({
    enabled: config.wakatimeEnabled,
    cliPath: config.wakatimeCli,
    model: config.wakatimeModel,
    plugin: config.wakatimePlugin,
    trackReads: config.wakatimeTrackReads,
    trackShellChanges: config.wakatimeTrackShellChanges,
  });
  return {
    processManager: new ProcessManager({
      maxRetainedOutputBytes: config.maxRetainedProcessOutputBytes,
      processRetentionMs: config.processRetentionMs,
      maxProcesses: config.maxProcesses,
      maxConcurrentProcesses: config.maxConcurrentProcesses,
      defaultMaxOutputBytes: config.maxOutputBytes,
    }),
    fileService: new FileService({
      defaultCwd: config.defaultCwd,
      maxChunkBytes: config.maxFileChunkBytes,
      maxEditFileBytes: config.maxEditFileBytes,
      maxOutputBytes: config.maxOutputBytes,
      activityTracker: wakatimeTracker,
    }),
    wakatimeTracker,
  };
}

export function createMcpServer(config: AppConfig, services: McpServices): McpServer {
  const server = new McpServer(
    {
      name: "cokacremote",
      version: "0.1.0",
    },
    {
      instructions:
        "This server is an unrestricted remote development environment. Tools operate directly on the host with the MCP service process's full OS permissions. Use exec_command for shell, build, test, package, Git, service, and log workflows; run_script for complete Bash, Node.js, or Python scripts; and the file tools for direct file operations. For browser clients, batch related shell work into one exec_command or run_script call when practical. Let ordinary commands wait for their configured yield time, and poll genuinely long-running commands with read_process using afterSeq plus a long waitMs instead of frequent short polls. Use write_stdin only when interaction is required.",
      capabilities: { logging: {} },
      cacheHints: {
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
        "tools/list": { ttlMs: 300_000, cacheScope: "private" },
      },
    },
  );

  registerExecTools(
    server,
    config,
    services.processManager,
    services.fileService,
    services.wakatimeTracker,
  );
  registerFileTools(server, config, services.fileService);
  return server;
}

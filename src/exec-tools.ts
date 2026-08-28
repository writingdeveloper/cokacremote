import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { FileService } from "./file-service.js";
import { ProcessManager } from "./process-manager.js";
import { runScript } from "./script-runner.js";
import { runTool } from "./tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";
import type { WakaTimeTracker } from "./wakatime-tracker.js";

const CLIENT_MAX_OUTPUT_BYTES = 1024 * 1024;

function processResult(result: Awaited<ReturnType<ProcessManager["read"]>>): Record<string, unknown> {
  return {
    ...result,
    completed: !result.running,
  };
}

function trackProcessCompletion(
  tracker: WakaTimeTracker,
  result: Awaited<ReturnType<ProcessManager["read"]>>,
): void {
  void tracker.trackProcessCompletion(result.sessionId, result.running).catch(() => undefined);
}

export function registerExecTools(
  server: McpServer,
  config: AppConfig,
  processManager: ProcessManager,
  fileService: FileService,
  wakatimeTracker: WakaTimeTracker,
): void {
  const authMetadata = toolAuthMetadata(config);
  const environmentSchema = z
    .record(z.string(), z.string())
    .optional()
    .describe("Environment variables added to or overriding the server process environment.");
  const sessionIdSchema = z
    .string()
    .uuid()
    .describe("Process session ID returned by exec_command or run_script.");
  const afterSeqSchema = z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Return only retained output chunks whose sequence number is greater than this value. Use the previous nextSeq value; zero starts with the earliest retained output.",
    );
  const timeoutSchema = z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Milliseconds before marking the process timed out and sending SIGTERM. Zero disables the timeout. A process still running five seconds after SIGTERM is sent SIGKILL.",
    );
  const maxOutputBytesSchema = z
    .number()
    .int()
    .min(16 * 1024)
    .max(CLIENT_MAX_OUTPUT_BYTES)
    .optional()
    .describe(
      "Maximum retained process-output bytes requested for this result. The server may return fewer bytes according to its runtime response budget.",
    );
  const outputModeSchema = z
    .enum(["compact", "streams", "metadata"])
    .default("compact")
    .describe(
      "Process output shape. compact returns canonical interleaved output, streams also includes stdout/stderr, and metadata returns state without output bytes.",
    );

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run an unrestricted shell command on the host. The command inherits the MCP server's full OS permissions, environment, filesystem, and network access. A successful start always returns a process session ID, current process state, and retained output; poll a running process with read_process or write_stdin.",
      inputSchema: z.object({
              cmd: z.string().min(1).describe("Shell command or script to execute."),
              workdir: z
                .string()
                .optional()
                .describe("Working directory. Relative paths resolve from the server configured default working directory."),
              shell: z
                .string()
                .optional()
                .describe("Shell executable. Defaults to the server configured shell."),
              login: z
                .boolean()
                .default(true)
                .describe("Use login-shell semantics (-lc) instead of -c."),
              env: environmentSchema,
              stdin: z.string().optional().describe("Initial text written to stdin after spawn."),
              timeoutMs: timeoutSchema,
              yieldTimeMs: z
                .number()
                .int()
                .min(0)
                .max(30_000)
                .optional()
                .describe(
                  "How long to wait for the process to exit before returning its current state. Zero returns immediately. Longer waits reduce repeated browser polling/tool cards for ordinary commands.",
                ),
              maxOutputBytes: maxOutputBytesSchema,
              outputMode: outputModeSchema,
            }),
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async ({
      cmd,
      workdir,
      shell,
      login,
      env,
      stdin,
      timeoutMs,
      yieldTimeMs,
      maxOutputBytes,
      outputMode,
    }) =>
      runTool(async () => {
        const cwd = fileService.resolve(".", workdir);
        const snapshot = await wakatimeTracker.captureWorkspace(cwd).catch(() => undefined);
        const executable = shell || config.defaultShell;
        const sessionId = processManager.start({
          executable,
          args: [login ? "-lc" : "-c", cmd],
          commandForDisplay: cmd,
          cwd,
          env,
          timeoutMs,
          stdin,
        });
        wakatimeTracker.rememberProcess(sessionId, cwd, snapshot);
        await processManager.waitForExit(sessionId, yieldTimeMs ?? config.processYieldTimeMs);
        const result = await processManager.read(sessionId, {
          maxOutputBytes,
          outputMode,
        });
        trackProcessCompletion(wakatimeTracker, result);
        return processResult(result);
      }),
  );

  server.registerTool(
    "run_script",
    {
      title: "Run script",
      description:
        "Write a supplied script to a temporary executable file and run it with Bash, sh, Node.js, Python, or an arbitrary interpreter. Execution is unrestricted and has the MCP server's full host permissions. A successful start always returns a process session ID, current process state, and retained output.",
      inputSchema: z.object({
              runtime: z
                .enum(["bash", "sh", "node", "python", "custom"])
                .default("bash")
                .describe("Script runtime. Use custom with interpreter for any other runtime."),
              script: z.string().describe("Complete script source."),
              workdir: z
                .string()
                .optional()
                .describe("Working directory. Relative paths resolve from the server configured default working directory."),
              args: z.array(z.string()).default([]).describe("Arguments passed after the script path."),
              env: environmentSchema,
              interpreter: z
                .string()
                .optional()
                .describe("Interpreter executable override. Required for runtime=custom."),
              interpreterArgs: z
                .array(z.string())
                .default([])
                .describe("Arguments placed before the temporary script path."),
              stdin: z.string().optional().describe("Initial text written to the script stdin."),
              timeoutMs: timeoutSchema,
              yieldTimeMs: z
                .number()
                .int()
                .min(0)
                .max(30_000)
                .optional()
                .describe(
                  "How long to wait for the script process to exit before returning its current state. Zero returns immediately. Longer waits reduce repeated browser polling/tool cards for ordinary scripts.",
                ),
              maxOutputBytes: maxOutputBytesSchema,
              outputMode: outputModeSchema,
              keepScript: z
                .boolean()
                .default(false)
                .describe(
                  "Keep the temporary script after process exit and include its path in the result. When false, the temporary directory is removed after exit.",
                ),
            }),
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async ({
      runtime,
      script,
      workdir,
      args,
      env,
      interpreter,
      interpreterArgs,
      stdin,
      timeoutMs,
      yieldTimeMs,
      maxOutputBytes,
      outputMode,
      keepScript,
    }) =>
      runTool(async () => {
        const cwd = fileService.resolve(".", workdir);
        const snapshot = await wakatimeTracker.captureWorkspace(cwd).catch(() => undefined);
        const result = await runScript(processManager, {
          runtime,
          script,
          cwd,
          args,
          env,
          interpreter,
          interpreterArgs,
          stdin,
          timeoutMs,
          yieldTimeMs: yieldTimeMs ?? config.processYieldTimeMs,
          maxOutputBytes,
          outputMode,
          keepScript,
        });
        wakatimeTracker.rememberProcess(result.sessionId, cwd, snapshot);
        trackProcessCompletion(wakatimeTracker, result);
        return processResult(result);
      }),
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process stdin",
      description:
        "Write text to an existing process session, optionally close stdin, then return current process state and retained output with sequence numbers greater than afterSeq.",
      inputSchema: z.object({
              sessionId: sessionIdSchema,
              chars: z
                .string()
                .default("")
                .describe("Text to write to the process stdin. An empty value writes nothing."),
              closeStdin: z
                .boolean()
                .default(false)
                .describe("Close the process stdin after writing chars."),
              afterSeq: afterSeqSchema,
              yieldTimeMs: z
                .number()
                .int()
                .min(0)
                .max(300_000)
                .default(250)
                .describe(
                  "When stdin remains open, wait this long for output or process exit. When closeStdin=true, wait this long for process exit before returning.",
                ),
              maxOutputBytes: maxOutputBytesSchema,
              outputMode: outputModeSchema,
            }),
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async ({ sessionId, chars, closeStdin, afterSeq, yieldTimeMs, maxOutputBytes, outputMode }) =>
      runTool(async () => {
        await processManager.write(sessionId, chars, closeStdin);
        if (closeStdin) {
          await processManager.waitForExit(sessionId, yieldTimeMs);
        }
        const result = await processManager.read(sessionId, {
          afterSeq,
          waitMs: closeStdin ? 0 : yieldTimeMs,
          maxOutputBytes,
          outputMode,
        });
        trackProcessCompletion(wakatimeTracker, result);
        return processResult(result);
      }),
  );

  server.registerTool(
    "read_process",
    {
      title: "Read process output",
      description:
        "Poll a managed process for output and terminal state. Pass the previous nextSeq as afterSeq to receive only newer output.",
      inputSchema: z.object({
              sessionId: sessionIdSchema,
              afterSeq: afterSeqSchema,
              waitMs: z
                .number()
                .int()
                .min(0)
                .max(300_000)
                .optional()
                .describe(
                  "How long to wait for output newer than afterSeq or for process exit. Zero returns immediately. Prefer long-poll waits for browser clients instead of frequent polling.",
                ),
              maxOutputBytes: maxOutputBytesSchema,
              outputMode: outputModeSchema,
            }),
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ sessionId, afterSeq, waitMs, maxOutputBytes, outputMode }) =>
      runTool(async () => {
        const result = await processManager.read(sessionId, {
          afterSeq,
          waitMs: waitMs ?? config.processPollWaitMs,
          maxOutputBytes,
          outputMode,
        });
        trackProcessCompletion(wakatimeTracker, result);
        return processResult(result);
      }),
  );

  server.registerTool(
    "terminate_process",
    {
      title: "Terminate process",
      description:
        "Send a signal to a managed process tree. When graceMs is greater than zero, SIGINT and SIGTERM escalate to SIGKILL if the process is still running after the grace period. The call may return while escalation is still pending.",
      inputSchema: z.object({
              sessionId: sessionIdSchema,
              signal: z
                .enum(["SIGINT", "SIGTERM", "SIGKILL"])
                .default("SIGTERM")
                .describe("Signal sent to the managed process tree."),
              graceMs: z
                .number()
                .int()
                .min(0)
                .max(60_000)
                .default(3000)
                .describe(
                  "For SIGINT or SIGTERM, milliseconds before SIGKILL escalation; zero disables escalation. The call waits at most one second before returning.",
                ),
              outputMode: outputModeSchema,
            }),
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ sessionId, signal, graceMs, outputMode }) =>
      runTool(async () => {
        const result = await processManager.terminate(sessionId, signal, graceMs, outputMode);
        trackProcessCompletion(wakatimeTracker, result);
        return processResult(result);
      }),
  );

  server.registerTool(
    "list_processes",
    {
      title: "List managed processes",
      description:
        "List running and recently completed process sessions. Filters only affect the returned list and never mutate or terminate sessions.",
      inputSchema: z.object({
        runningOnly: z
          .boolean()
          .default(false)
          .describe("Return only currently running process sessions."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum number of matching sessions returned, preserving creation order."),
        since: z
          .string()
          .optional()
          .describe("Only return sessions started at or after this ISO-8601 timestamp."),
      }),
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ runningOnly, limit, since }) =>
      runTool(() => {
        let sinceMs: number | undefined;
        if (since !== undefined) {
          sinceMs = Date.parse(since);
          if (!Number.isFinite(sinceMs)) {
            throw new Error(`Invalid since timestamp: ${since}`);
          }
        }
        return {
          processes: processManager.list({ runningOnly, limit, since: sinceMs }),
          stats: processManager.stats(),
        };
      }),
  );

  server.registerTool(
    "forget_process",
    {
      title: "Forget completed process",
      description:
        "Remove one completed process session and its retained output. Running processes are rejected and are never terminated implicitly.",
      inputSchema: z.object({ sessionId: sessionIdSchema }),
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ sessionId }) =>
      runTool(() => ({ sessionId, forgotten: processManager.forget(sessionId) })),
  );

  server.registerTool(
    "clear_completed_processes",
    {
      title: "Clear completed processes",
      description:
        "Remove completed retained process sessions without affecting running processes.",
      inputSchema: z.object({
        olderThanMs: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Only clear sessions completed at least this many milliseconds ago. Zero clears all completed sessions.",
          ),
      }),
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ olderThanMs }) =>
      runTool(() => ({ cleared: processManager.clearCompleted(olderThanMs) })),
  );
}

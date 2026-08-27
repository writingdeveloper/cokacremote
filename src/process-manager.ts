import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAscii } from "node:buffer";

import { BusyError } from "./concurrency-gate.js";
import { errorMessage } from "./errors.js";
import { signalProcessTree } from "./process-tree.js";

const OUTPUT_CHUNK_BYTES = 16 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ProcessOutputStream = "stdout" | "stderr";

interface OutputChunk {
  seq: number;
  stream: ProcessOutputStream;
  data: Buffer;
}

interface ManagedProcess {
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number | undefined;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  error: string | undefined;
  timedOut: boolean;
  chunks: OutputChunk[];
  pendingOutput: Record<ProcessOutputStream, Buffer>;
  retainedBytes: number;
  totalOutputBytes: number;
  droppedOutputBytes: number;
  nextSeq: number;
  waiters: Set<() => void>;
  exitWaiters: Set<() => void>;
  timeoutHandle: NodeJS.Timeout | undefined;
  retentionHandle: NodeJS.Timeout | undefined;
  cleanup: (() => Promise<void>) | undefined;
}

function isContinuationByte(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}

function utf8SequenceLengthAt(
  data: Buffer,
  offset: number,
  final: boolean,
): number | undefined {
  const first = data[offset]!;
  if (first <= 0x7f) {
    return 1;
  }

  let length = 0;
  if (first >= 0xc2 && first <= 0xdf) {
    length = 2;
  } else if (first >= 0xe0 && first <= 0xef) {
    length = 3;
  } else if (first >= 0xf0 && first <= 0xf4) {
    length = 4;
  } else {
    return 1;
  }

  if (offset + 1 >= data.length) {
    return final ? 1 : undefined;
  }

  const second = data[offset + 1]!;
  if (!isContinuationByte(second)) {
    return 1;
  }
  if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second > 0x9f)) {
    return 1;
  }
  if ((first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) {
    return 1;
  }
  for (let index = 2; index < length; index += 1) {
    if (offset + index >= data.length) {
      return final ? 1 : undefined;
    }
    if (!isContinuationByte(data[offset + index]!)) {
      return 1;
    }
  }
  return length;
}

function splitOutputChunks(
  data: Buffer,
  final = false,
): { chunks: Buffer[]; remainder: Buffer } {
  if (isAscii(data)) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < data.length; offset += OUTPUT_CHUNK_BYTES) {
      chunks.push(Buffer.from(data.subarray(offset, offset + OUTPUT_CHUNK_BYTES)));
    }
    return { chunks, remainder: Buffer.alloc(0) };
  }

  const chunks: Buffer[] = [];
  let chunkStart = 0;
  let cursor = 0;
  while (cursor < data.length) {
    const sequenceLength = utf8SequenceLengthAt(data, cursor, final);
    if (sequenceLength === undefined) {
      break;
    }
    if (
      cursor > chunkStart &&
      cursor + sequenceLength - chunkStart > OUTPUT_CHUNK_BYTES
    ) {
      chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
      chunkStart = cursor;
      continue;
    }
    cursor += sequenceLength;
    if (cursor - chunkStart === OUTPUT_CHUNK_BYTES) {
      chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
      chunkStart = cursor;
    }
  }
  if (cursor > chunkStart) {
    chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
  }
  return {
    chunks,
    remainder: Buffer.from(data.subarray(cursor)),
  };
}

export interface StartProcessRequest {
  executable: string;
  args: string[];
  commandForDisplay: string;
  cwd: string;
  env?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  stdin?: string | undefined;
  cleanup?: (() => Promise<void>) | undefined;
}

export type ProcessOutputMode = "compact" | "streams" | "metadata";

export interface ReadProcessRequest {
  afterSeq?: number | undefined;
  waitMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  outputMode?: ProcessOutputMode | undefined;
}

export interface ProcessReadResult {
  sessionId: string;
  command: string;
  cwd: string;
  running: boolean;
  pid: number | undefined;
  startedAt: string;
  endedAt: string | undefined;
  wallTimeMs: number;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  timedOut: boolean;
  error: string | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  output: string;
  nextSeq: number;
  hasMore: boolean;
  totalOutputBytes: number;
  droppedOutputBytes: number;
}

export interface ProcessListOptions {
  runningOnly?: boolean | undefined;
  limit?: number | undefined;
  since?: number | undefined;
}

export interface ProcessManagerStats {
  running: number;
  completedRetained: number;
  capacity: number;
  maxConcurrentProcesses: number;
  runningCapacity: number;
  retainedOutputBytes: number;
  droppedOutputBytes: number;
}

export interface ProcessManagerOptions {
  maxRetainedOutputBytes: number;
  processRetentionMs: number;
  maxProcesses: number;
  maxConcurrentProcesses?: number | undefined;
  defaultMaxOutputBytes: number;
}

export class ProcessManager {
  readonly #processes = new Map<string, ManagedProcess>();
  readonly #options: ProcessManagerOptions;

  constructor(options: ProcessManagerOptions) {
    this.#options = options;
  }

  start(request: StartProcessRequest): string {
    this.prune();
    this.#makeCapacity();
    const maxConcurrentProcesses =
      this.#options.maxConcurrentProcesses ?? this.#options.maxProcesses;
    const runningProcesses = [...this.#processes.values()].filter((managed) =>
      this.#isRunning(managed),
    ).length;
    if (runningProcesses >= maxConcurrentProcesses) {
      throw new BusyError(
        `Maximum concurrent process count (${maxConcurrentProcesses}) reached; retry after a running process exits`,
      );
    }


    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const sessionId = randomUUID();
    const managed: ManagedProcess = {
      sessionId,
      child,
      command: request.commandForDisplay,
      cwd: request.cwd,
      startedAt: Date.now(),
      endedAt: undefined,
      exitCode: undefined,
      signal: undefined,
      error: undefined,
      timedOut: false,
      chunks: [],
      pendingOutput: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      retainedBytes: 0,
      totalOutputBytes: 0,
      droppedOutputBytes: 0,
      nextSeq: 1,
      waiters: new Set(),
      exitWaiters: new Set(),
      timeoutHandle: undefined,
      retentionHandle: undefined,
      cleanup: request.cleanup,
    };
    this.#processes.set(sessionId, managed);

    child.stdout.on("data", (data: Buffer | string) => {
      this.#appendOutput(managed, "stdout", Buffer.from(data));
    });
    child.stderr.on("data", (data: Buffer | string) => {
      this.#appendOutput(managed, "stderr", Buffer.from(data));
    });
    child.stdin.on("error", (error) => {
      this.#recordStdinError(managed, error);
    });
    child.on("error", (error) => {
      managed.error = errorMessage(error);
      this.#finish(managed, null, null);
    });
    child.on("close", (code, signal) => {
      this.#finish(managed, code, signal);
    });

    const timeoutMs = request.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      managed.timeoutHandle = setTimeout(() => {
        managed.timedOut = true;
        managed.error ??= `Process exceeded timeout of ${timeoutMs} ms`;
        void this.#signal(managed, "SIGTERM");
        const forceTimer = setTimeout(() => {
          if (this.#isRunning(managed)) {
            void this.#signal(managed, "SIGKILL");
          }
        }, 5000);
        forceTimer.unref();
      }, timeoutMs);
      managed.timeoutHandle.unref();
    }

    if (request.stdin !== undefined && request.stdin.length > 0) {
      try {
        child.stdin.write(request.stdin, (error) => {
          if (error) {
            this.#recordStdinError(managed, error);
          }
        });
      } catch (error) {
        this.#recordStdinError(managed, error);
      }
    }
    return sessionId;
  }

  async read(
    sessionId: string,
    request: ReadProcessRequest = {},
  ): Promise<ProcessReadResult> {
    const managed = this.#require(sessionId);
    const afterSeq = Math.max(0, request.afterSeq ?? 0);
    const waitMs = Math.max(0, request.waitMs ?? 0);
    if (waitMs > 0) {
      await this.#waitForOutput(managed, afterSeq, waitMs);
    }

    const outputMode = request.outputMode ?? "compact";
    const maxOutputBytes = Math.max(
      OUTPUT_CHUNK_BYTES,
      Math.min(
        request.maxOutputBytes ?? this.#options.defaultMaxOutputBytes,
        this.#options.defaultMaxOutputBytes,
      ),
    );
    const eligible = managed.chunks.filter((chunk) => chunk.seq > afterSeq);
    const selected: OutputChunk[] = [];
    let selectedBytes = 0;
    if (outputMode !== "metadata") {
      for (const chunk of eligible) {
        if (selectedBytes + chunk.data.length > maxOutputBytes) {
          break;
        }
        selected.push(chunk);
        selectedBytes += chunk.data.length;
      }
    }

    const output = outputMode === "metadata"
      ? ""
      : Buffer.concat(selected.map((chunk) => chunk.data)).toString("utf8");
    const stdout = outputMode === "streams"
      ? Buffer.concat(
          selected.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.data),
        ).toString("utf8")
      : undefined;
    const stderr = outputMode === "streams"
      ? Buffer.concat(
          selected.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.data),
        ).toString("utf8")
      : undefined;
    const nextSeq = selected.at(-1)?.seq ?? afterSeq;
    const now = managed.endedAt ?? Date.now();

    return {
      sessionId,
      command: managed.command,
      cwd: managed.cwd,
      running: this.#isRunning(managed),
      pid: managed.child.pid,
      startedAt: new Date(managed.startedAt).toISOString(),
      endedAt:
        managed.endedAt === undefined
          ? undefined
          : new Date(managed.endedAt).toISOString(),
      wallTimeMs: now - managed.startedAt,
      exitCode: managed.exitCode,
      signal: managed.signal,
      timedOut: managed.timedOut,
      error: managed.error,
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
      output,
      nextSeq,
      hasMore: eligible.length > selected.length,
      totalOutputBytes: managed.totalOutputBytes,
      droppedOutputBytes: managed.droppedOutputBytes,
    };
  }

  async write(
    sessionId: string,
    input: string,
    closeStdin = false,
  ): Promise<void> {
    const managed = this.#require(sessionId);
    if (input.length === 0 && !closeStdin) {
      return;
    }
    if (!this.#isRunning(managed)) {
      throw new Error(`Process ${sessionId} is not running`);
    }
    if (managed.child.stdin.destroyed || !managed.child.stdin.writable) {
      throw new Error(`stdin is closed for process ${sessionId}`);
    }

    if (input.length > 0) {
      await new Promise<void>((resolve, reject) => {
        managed.child.stdin.write(input, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
    if (closeStdin) {
      managed.child.stdin.end();
    }
  }

  async waitForExit(sessionId: string, waitMs: number): Promise<void> {
    const managed = this.#require(sessionId);
    if (!this.#isRunning(managed) || waitMs <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        managed.exitWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      managed.exitWaiters.add(finish);
      if (!this.#isRunning(managed)) {
        finish();
      }
    });
  }

  async terminate(
    sessionId: string,
    signal: NodeJS.Signals = "SIGTERM",
    graceMs = 3000,
    outputMode: ProcessOutputMode = "compact",
  ): Promise<ProcessReadResult> {
    const managed = this.#require(sessionId);
    if (this.#isRunning(managed)) {
      await this.#signal(managed, signal);

      if (signal !== "SIGKILL" && graceMs > 0 && this.#isRunning(managed)) {
        await this.waitForExit(sessionId, graceMs);
      }
      if (signal !== "SIGKILL" && this.#isRunning(managed)) {
        await this.#signal(managed, "SIGKILL");
      }
      if (this.#isRunning(managed)) {
        // Windows can report taskkill completion before Node receives the final
        // close event for inherited stdio handles. Bound that drain period so
        // terminate_process returns a stable final lifecycle state when possible.
        await this.waitForExit(sessionId, 3000);
      }
    }
    return this.read(sessionId, { outputMode });
  }

  list(options: ProcessListOptions = {}): Array<{
    sessionId: string;
    pid: number | undefined;
    command: string;
    cwd: string;
    running: boolean;
    startedAt: string;
    endedAt: string | undefined;
    exitCode: number | null | undefined;
  }> {
    let managedProcesses = [...this.#processes.values()];
    if (options.runningOnly) {
      managedProcesses = managedProcesses.filter((managed) => this.#isRunning(managed));
    }
    if (options.since !== undefined) {
      managedProcesses = managedProcesses.filter((managed) => managed.startedAt >= options.since!);
    }
    if (options.limit !== undefined) {
      const limit = Math.max(0, Math.floor(options.limit));
      managedProcesses = managedProcesses.slice(0, limit);
    }
    return managedProcesses.map((managed) => ({
      sessionId: managed.sessionId,
      pid: managed.child.pid,
      command: managed.command,
      cwd: managed.cwd,
      running: this.#isRunning(managed),
      startedAt: new Date(managed.startedAt).toISOString(),
      endedAt:
        managed.endedAt === undefined
          ? undefined
          : new Date(managed.endedAt).toISOString(),
      exitCode: managed.exitCode,
    }));
  }

  forget(sessionId: string): boolean {
    const managed = this.#processes.get(sessionId);
    if (!managed) {
      return false;
    }
    if (this.#isRunning(managed)) {
      throw new Error(
        `Cannot forget running process ${sessionId}; terminate it first`,
      );
    }
    this.#forget(managed);
    return true;
  }

  clearCompleted(olderThanMs = 0): number {
    const threshold = Math.max(0, olderThanMs);
    const cutoff = Date.now() - threshold;
    let cleared = 0;
    for (const managed of [...this.#processes.values()]) {
      if (managed.endedAt !== undefined && managed.endedAt <= cutoff) {
        this.#forget(managed);
        cleared += 1;
      }
    }
    return cleared;
  }

  stats(): ProcessManagerStats {
    let running = 0;
    let completedRetained = 0;
    let retainedOutputBytes = 0;
    let droppedOutputBytes = 0;
    for (const managed of this.#processes.values()) {
      if (this.#isRunning(managed)) {
        running += 1;
      } else {
        completedRetained += 1;
      }
      retainedOutputBytes +=
        managed.retainedBytes +
        managed.pendingOutput.stdout.length +
        managed.pendingOutput.stderr.length;
      droppedOutputBytes += managed.droppedOutputBytes;
    }
    return {
      running,
      completedRetained,
      capacity: this.#options.maxProcesses,
      maxConcurrentProcesses: this.#options.maxConcurrentProcesses ?? this.#options.maxProcesses,
      runningCapacity: Math.max(
        0,
        (this.#options.maxConcurrentProcesses ?? this.#options.maxProcesses) - running,
      ),
      retainedOutputBytes,
      droppedOutputBytes,
    };
  }

  prune(): void {
    const cutoff = Date.now() - this.#options.processRetentionMs;
    for (const managed of this.#processes.values()) {
      if (managed.endedAt !== undefined && managed.endedAt < cutoff) {
        this.#forget(managed);
      }
    }
  }

  async shutdown(): Promise<void> {
    const running = [...this.#processes.values()].filter((managed) =>
      this.#isRunning(managed),
    );
    await Promise.all(running.map((managed) => this.#signal(managed, "SIGTERM")));
    await new Promise((resolve) => setTimeout(resolve, running.length > 0 ? 500 : 0));
    await Promise.all(
      running
        .filter((managed) => this.#isRunning(managed))
        .map((managed) => this.#signal(managed, "SIGKILL")),
    );
  }

  #makeCapacity(): void {
    if (this.#processes.size < this.#options.maxProcesses) {
      return;
    }
    const completed = [...this.#processes.values()]
      .filter((managed) => managed.endedAt !== undefined)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    while (
      this.#processes.size >= this.#options.maxProcesses &&
      completed.length > 0
    ) {
      const managed = completed.shift();
      if (managed) {
        this.#forget(managed);
      }
    }
    if (this.#processes.size >= this.#options.maxProcesses) {
      throw new Error(
        `Maximum managed process count (${this.#options.maxProcesses}) reached`,
      );
    }
  }

  #require(sessionId: string): ManagedProcess {
    const managed = this.#processes.get(sessionId);
    if (!managed) {
      throw new Error(`Unknown process session: ${sessionId}`);
    }
    return managed;
  }

  #appendOutput(
    managed: ManagedProcess,
    stream: ProcessOutputStream,
    data: Buffer,
  ): void {
    managed.totalOutputBytes += data.length;
    const pending = managed.pendingOutput[stream];
    const combined = pending.length > 0 ? Buffer.concat([pending, data]) : data;
    const split = splitOutputChunks(combined);
    managed.pendingOutput[stream] = split.remainder;
    this.#storeOutputChunks(managed, stream, split.chunks);
    this.#trimRetainedOutput(managed);
    this.#notify(managed);
  }

  #storeOutputChunks(
    managed: ManagedProcess,
    stream: ProcessOutputStream,
    chunks: Buffer[],
  ): void {
    for (const data of chunks) {
      managed.chunks.push({ seq: managed.nextSeq, stream, data });
      managed.nextSeq += 1;
      managed.retainedBytes += data.length;
    }
  }

  #trimRetainedOutput(managed: ManagedProcess): void {
    while (
      managed.retainedBytes > this.#options.maxRetainedOutputBytes &&
      managed.chunks.length > 0
    ) {
      const removed = managed.chunks.shift();
      if (removed) {
        managed.retainedBytes -= removed.data.length;
        managed.droppedOutputBytes += removed.data.length;
      }
    }
  }

  #flushPendingOutput(managed: ManagedProcess): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const pending = managed.pendingOutput[stream];
      if (pending.length === 0) {
        continue;
      }
      const split = splitOutputChunks(pending, true);
      managed.pendingOutput[stream] = Buffer.alloc(0);
      this.#storeOutputChunks(managed, stream, split.chunks);
    }
    this.#trimRetainedOutput(managed);
  }

  #recordStdinError(managed: ManagedProcess, error: unknown): void {
    managed.error ??= `stdin write failed: ${errorMessage(error)}`;
    this.#notify(managed);
  }

  #finish(
    managed: ManagedProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (managed.endedAt !== undefined) {
      return;
    }
    this.#flushPendingOutput(managed);
    managed.endedAt = Date.now();
    managed.exitCode = code;
    managed.signal = signal;
    if (managed.timeoutHandle) {
      clearTimeout(managed.timeoutHandle);
      managed.timeoutHandle = undefined;
    }
    this.#notify(managed);
    const exitWaiters = [...managed.exitWaiters];
    managed.exitWaiters.clear();
    for (const waiter of exitWaiters) {
      waiter();
    }
    if (managed.cleanup) {
      void managed.cleanup().catch((error) => {
        managed.error ??= `Cleanup failed: ${errorMessage(error)}`;
      });
    }
    this.#scheduleRetention(managed);
  }

  #scheduleRetention(managed: ManagedProcess): void {
    const expiresAt = (managed.endedAt ?? Date.now()) + this.#options.processRetentionMs;
    const expireOrReschedule = () => {
      managed.retentionHandle = undefined;
      if (this.#processes.get(managed.sessionId) !== managed) {
        return;
      }
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        this.#processes.delete(managed.sessionId);
        return;
      }
      managed.retentionHandle = setTimeout(
        expireOrReschedule,
        Math.min(remainingMs, MAX_TIMER_DELAY_MS),
      );
      managed.retentionHandle.unref();
    };
    managed.retentionHandle = setTimeout(
      expireOrReschedule,
      Math.min(this.#options.processRetentionMs, MAX_TIMER_DELAY_MS),
    );
    managed.retentionHandle.unref();
  }

  #forget(managed: ManagedProcess): void {
    if (managed.retentionHandle) {
      clearTimeout(managed.retentionHandle);
      managed.retentionHandle = undefined;
    }
    if (this.#processes.get(managed.sessionId) === managed) {
      this.#processes.delete(managed.sessionId);
    }
  }

  #notify(managed: ManagedProcess): void {
    const waiters = [...managed.waiters];
    managed.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  #waitForOutput(
    managed: ManagedProcess,
    afterSeq: number,
    waitMs: number,
  ): Promise<void> {
    if (managed.nextSeq - 1 > afterSeq || !this.#isRunning(managed)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        managed.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      managed.waiters.add(finish);
      if (managed.nextSeq - 1 > afterSeq || !this.#isRunning(managed)) {
        finish();
      }
    });
  }

  #isRunning(managed: ManagedProcess): boolean {
    return managed.endedAt === undefined;
  }

  async #signal(managed: ManagedProcess, signal: NodeJS.Signals): Promise<void> {
    const pid = managed.child.pid;
    if (pid === undefined) {
      return;
    }
    try {
      await signalProcessTree(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        managed.error ??= `Failed to signal process: ${errorMessage(error)}`;
      }
    }
  }
}

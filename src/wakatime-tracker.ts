import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WakaTimeCommandRunner {
  run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void>;
}

class ExecFileWakaTimeCommandRunner implements WakaTimeCommandRunner {
  async run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
    await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
  }
}

interface FileFingerprint {
  size: number;
  modifiedAtMs: number;
  digest: string | undefined;
}

export interface WakaTimeWorkspaceSnapshot {
  root: string;
  head: string | undefined;
  files: Map<string, FileFingerprint | undefined>;
}

export interface WakaTimeTrackerOptions {
  enabled: boolean;
  cliPath: string | undefined;
  home?: string;
  configPath?: string;
  model?: string;
  plugin: string;
  trackReads: boolean;
  trackShellChanges?: boolean;
  processSnapshotRetentionMs?: number;
  maxProcessSnapshots?: number;
  runner?: WakaTimeCommandRunner;
  now?: () => number;
}

const HEARTBEAT_DEDUP_MS = 120_000;

const SHELL_CHANGE_EXCLUDES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
];

function isExcluded(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return SHELL_CHANGE_EXCLUDES.some(
    (segment) => normalized === segment || normalized.startsWith(`${segment}/`),
  );
}

function parsePorcelainPaths(output: string): string[] {
  const tokens = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.length < 4) {
      continue;
    }
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    if (filePath) {
      paths.push(filePath);
    }
    if ((status.includes("R") || status.includes("C")) && index + 1 < tokens.length) {
      const originalPath = tokens[index + 1]!;
      if (originalPath) {
        paths.push(originalPath);
      }
      index += 1;
    }
  }
  return [...new Set(paths)];
}

async function fileFingerprint(filePath: string): Promise<FileFingerprint | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return undefined;
    }
    let digest: string | undefined;
    if (info.size <= 2 * 1024 * 1024) {
      digest = createHash("sha256").update(await readFile(filePath)).digest("hex");
    }
    return {
      size: info.size,
      modifiedAtMs: info.mtimeMs,
      digest,
    };
  } catch {
    return undefined;
  }
}

function fingerprintChanged(
  before: FileFingerprint | undefined,
  after: FileFingerprint | undefined,
): boolean {
  if (!before && !after) {
    return false;
  }
  if (!before || !after) {
    return true;
  }
  return (
    before.size !== after.size ||
    before.modifiedAtMs !== after.modifiedAtMs ||
    before.digest !== after.digest
  );
}

export class WakaTimeTracker {
  readonly #enabled: boolean;
  readonly #cliPath: string | undefined;
  readonly #home: string | undefined;
  readonly #configPath: string | undefined;
  readonly #model: string | undefined;
  readonly #plugin: string;
  readonly #trackReads: boolean;
  readonly #trackShellChanges: boolean;
  readonly #processSnapshotRetentionMs: number;
  readonly #maxProcessSnapshots: number;
  readonly #runner: WakaTimeCommandRunner;
  readonly #now: () => number;
  #lastHeartbeatEntity: string | undefined;
  #lastHeartbeatAt = 0;
  readonly #processSnapshots = new Map<
    string,
    { cwd: string; snapshot: WakaTimeWorkspaceSnapshot; rememberedAt: number }
  >();

  constructor(options: WakaTimeTrackerOptions) {
    this.#enabled = options.enabled;
    this.#cliPath = options.cliPath;
    this.#home = options.home?.trim() || undefined;
    this.#configPath = options.configPath?.trim() || undefined;
    this.#model = options.model?.trim() || undefined;
    this.#plugin = options.plugin;
    this.#trackReads = options.trackReads;
    this.#trackShellChanges = options.trackShellChanges ?? true;
    this.#processSnapshotRetentionMs = Math.max(
      1_000,
      options.processSnapshotRetentionMs ?? 60 * 60 * 1000,
    );
    this.#maxProcessSnapshots = Math.max(1, options.maxProcessSnapshots ?? 128);
    this.#runner = options.runner ?? new ExecFileWakaTimeCommandRunner();
    this.#now = options.now ?? Date.now;
  }

  async trackFile(
    entity: string,
    options: { write: boolean; aiLineChanges?: number; unsaved?: boolean },
  ): Promise<void> {
    if (!this.#enabled || !this.#cliPath) {
      return;
    }
    if (!options.write && !this.#trackReads) {
      return;
    }

    const resolvedEntity = path.resolve(entity);
    const now = this.#now();
    if (
      !options.write &&
      this.#lastHeartbeatEntity === resolvedEntity &&
      now - this.#lastHeartbeatAt < HEARTBEAT_DEDUP_MS
    ) {
      return;
    }

    this.#lastHeartbeatEntity = resolvedEntity;
    this.#lastHeartbeatAt = now;
    if (this.#home) {
      await mkdir(this.#home, { recursive: true });
    }
    const args: string[] = [];
    if (this.#configPath) {
      args.push("--config", this.#configPath);
    }
    args.push(
      "--entity",
      resolvedEntity,
      "--category",
      "ai coding",
      "--plugin",
      this.#model ? `${this.#model} ${this.#plugin}` : this.#plugin,
      "--sync-ai-disabled",
      "--timeout",
      "5",
    );
    if (options.unsaved) {
      args.push("--is-unsaved-entity");
    }
    if (
      options.write &&
      options.aiLineChanges !== undefined &&
      Number.isFinite(options.aiLineChanges)
    ) {
      args.push(
        "--ai-line-changes",
        String(Math.max(0, Math.trunc(options.aiLineChanges))),
      );
    }
    if (options.write) {
      args.push("--write");
    }
    try {
      await this.#runner.run(
        this.#cliPath,
        args,
        this.#home ? { WAKATIME_HOME: this.#home } : undefined,
      );
    } catch (error) {
      if (this.#lastHeartbeatEntity === resolvedEntity && this.#lastHeartbeatAt === now) {
        this.#lastHeartbeatEntity = undefined;
        this.#lastHeartbeatAt = 0;
      }
      throw error;
    }
  }

  #pruneProcessSnapshots(now = this.#now()): void {
    for (const [sessionId, tracked] of this.#processSnapshots) {
      if (now - tracked.rememberedAt > this.#processSnapshotRetentionMs) {
        this.#processSnapshots.delete(sessionId);
      }
    }
  }

  rememberProcess(
    sessionId: string,
    cwd: string,
    snapshot: WakaTimeWorkspaceSnapshot | undefined,
  ): void {
    if (!snapshot) {
      return;
    }
    const now = this.#now();
    this.#pruneProcessSnapshots(now);
    this.#processSnapshots.delete(sessionId);
    while (this.#processSnapshots.size >= this.#maxProcessSnapshots) {
      const oldestSessionId = this.#processSnapshots.keys().next().value;
      if (oldestSessionId === undefined) {
        break;
      }
      this.#processSnapshots.delete(oldestSessionId);
    }
    this.#processSnapshots.set(sessionId, { cwd, snapshot, rememberedAt: now });
  }

  async trackProcessCompletion(sessionId: string, running: boolean): Promise<void> {
    this.#pruneProcessSnapshots();
    if (running) {
      return;
    }
    const tracked = this.#processSnapshots.get(sessionId);
    if (!tracked) {
      return;
    }
    this.#processSnapshots.delete(sessionId);
    await this.trackWorkspaceChanges(tracked.cwd, tracked.snapshot);
  }

  async captureWorkspace(cwd: string): Promise<WakaTimeWorkspaceSnapshot | undefined> {
    if (!this.#enabled || !this.#trackShellChanges) {
      return undefined;
    }
    let root: string;
    try {
      const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        windowsHide: true,
      });
      root = result.stdout.trim();
    } catch {
      return undefined;
    }

    let head: string | undefined;
    try {
      const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
      head = result.stdout.trim() || undefined;
    } catch {
      head = undefined;
    }

    const status = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    const files = new Map<string, FileFingerprint | undefined>();
    for (const relativePath of parsePorcelainPaths(status.stdout)) {
      if (isExcluded(relativePath)) {
        continue;
      }
      files.set(relativePath, await fileFingerprint(path.join(root, relativePath)));
    }
    return { root, head, files };
  }

  async trackWorkspaceChanges(
    cwd: string,
    before: WakaTimeWorkspaceSnapshot | undefined,
  ): Promise<void> {
    if (!before || !this.#enabled || !this.#trackShellChanges) {
      return;
    }
    const after = await this.captureWorkspace(cwd);
    if (!after || path.resolve(after.root) !== path.resolve(before.root)) {
      return;
    }

    const changed = new Set<string>();
    const paths = new Set([...before.files.keys(), ...after.files.keys()]);
    for (const relativePath of paths) {
      if (fingerprintChanged(before.files.get(relativePath), after.files.get(relativePath))) {
        changed.add(relativePath);
      }
    }

    if (before.head && after.head && before.head !== after.head) {
      try {
        const committed = await execFileAsync(
          "git",
          ["diff", "--name-only", "-z", `${before.head}..${after.head}`],
          { cwd: after.root, encoding: "utf8", windowsHide: true },
        );
        for (const relativePath of committed.stdout.split("\0").filter(Boolean)) {
          if (!isExcluded(relativePath)) {
            changed.add(relativePath);
          }
        }
      } catch {
        // A rewritten or unavailable commit range should not block MCP work.
      }
    }

    for (const relativePath of changed) {
      const absolutePath = path.join(after.root, relativePath);
      const info = await fileFingerprint(absolutePath);
      if (info) {
        await this.trackFile(absolutePath, { write: true });
      }
    }
  }
}

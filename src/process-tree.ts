import { execFile } from "node:child_process";
import process from "node:process";

const WINDOWS_TASKKILL_TIMEOUT_MS = 10_000;

function windowsProcessMissing(message: string): boolean {
  return /not found|no running instance|cannot find|찾을 수 없/i.test(message);
}

function terminatedPid(message: string, pid: number): boolean {
  return new RegExp(`PID\s+${pid}\b[^\r\n]*terminated`, "i").test(message);
}

function failedChildPids(message: string, rootPid: number): number[] {
  const pids = new Set<number>();
  for (const match of message.matchAll(/PID\s+(\d+)\s+\(child process of PID\s+\d+\)\s+could not be terminated/gi)) {
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0 && pid !== rootPid) {
      pids.add(pid);
    }
  }
  return [...pids];
}

async function taskkill(pid: number, retryFailedChildren: boolean): Promise<void> {
  const args = ["/PID", String(pid), "/T", "/F"];
  const { error, stdout, stderr } = await new Promise<{
    error: (Error & { code?: string | number | null }) | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    execFile(
      "taskkill.exe",
      args,
      {
        windowsHide: true,
        encoding: "utf8",
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ error, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

  const message = `${stdout}${stderr}`.trim();
  if (!error || windowsProcessMissing(message)) {
    return;
  }

  // MSYS/Git Bash can report a partial taskkill failure after the root process
  // has already been terminated. Retry any specifically reported descendants
  // once so they are not silently orphaned, then treat the root termination as
  // successful if taskkill confirms it.
  if (terminatedPid(stdout, pid)) {
    if (retryFailedChildren) {
      const failed = failedChildPids(stderr, pid);
      await Promise.allSettled(failed.map((childPid) => taskkill(childPid, false)));
    }
    return;
  }

  throw Object.assign(
    new Error(message || `taskkill failed for PID ${pid}`),
    { code: error.code },
  );
}

export function signalProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform !== "win32") {
    process.kill(-pid, signal);
    return Promise.resolve();
  }

  // Windows has no POSIX process-group signals. taskkill /T /F is intentionally
  // asynchronous so process termination never blocks the MCP server event loop.
  return taskkill(pid, true);
}

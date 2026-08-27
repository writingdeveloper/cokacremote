import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

export function nodeCommand(source: string) {
  return {
    executable: process.execPath,
    args: ["-e", source],
    commandForDisplay: `node -e ${JSON.stringify(source)}`,
  };
}

export function testBash(): string {
  if (process.platform !== "win32") {
    return "/bin/bash";
  }
  const candidates = [
    process.env.MCP_TEST_BASH,
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      "Git Bash is required for exec_command integration tests on Windows. Set MCP_TEST_BASH to bash.exe.",
    );
  }
  return found;
}

export function isPosixModeMeaningful(): boolean {
  return process.platform !== "win32";
}

export function normalizeTextNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function executableAvailable(executable: string): boolean {
  const result = spawnSync(executable, ["--version"], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 2_000,
  });
  return !result.error && result.status === 0;
}

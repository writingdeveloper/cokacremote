# ChatGPT Web + Windows Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cokacremote` efficient for high-volume ChatGPT Web use, robust on Windows, and ready for MCP 2026-07-28 cache/tasks/CIMD evolution, then deploy it safely to both Windows hosts.

**Architecture:** Keep the existing stateless MCP server and `ProcessManager` as the core runtime. Reduce output duplication at the tool-result boundary, add bounded process/request lifecycle controls around it, introduce Windows-specific process-tree and Scheduled Task deployment helpers, and layer new MCP 2026 features additively so existing clients keep working.

**Tech Stack:** TypeScript, Node.js 20+, Vitest, `@modelcontextprotocol/node`/`server` 2.x, Express 5, PowerShell 5.1+, Windows Task Scheduler, Cloudflare Tunnel where host topology requires it.

**Spec:** `docs/superpowers/specs/2026-08-27-chatgpt-web-windows-runtime-design.md`

## Global Constraints

- Do not touch `til-shorts`.
- Do not commit credentials, OAuth state, Cloudflare/Tailscale secrets, or machine-specific private config.
- `origin` is `writingdeveloper/cokacremote`; `upstream` is `kstost/cokacremote`; never push to upstream.
- Keep existing `exec_command`, `read_process`, `write_stdin`, and `terminate_process` APIs usable.
- Preserve deployed MCP 2026-07-28 discovery/list/call compatibility.
- Preserve DCR as a compatibility fallback while adding CIMD support.
- Use test-first development for every production behavior change.
- Never use `git reset --hard` or `git clean` on shared workspaces.
- Roll out to `SIHYEONG-4080` before `SIHYEONG-MAIN`.

---

### Task 1: Normalize the Windows Baseline

**Files:**
- Create: `test/helpers/cross-platform-command.ts`
- Modify: `test/process-manager.test.ts`
- Modify: `test/config.test.ts`
- Modify: `test/file-service.test.ts`
- Modify: `test/all-tools.integration.test.ts`
- Modify: `test/mcp.integration.test.ts`
- Modify: `test/oauth.integration.test.ts`

**Interfaces:**
- Produces: `nodeCommand(source: string): { executable: string; args: string[]; commandForDisplay: string }`
- Produces: `isPosixModeMeaningful(): boolean`
- Produces: `normalizeTextNewlines(text: string): string`

- [ ] **Step 1: Add a cross-platform command helper and write tests that use Node instead of `/bin/bash`.**

```ts
import process from "node:process";

export function nodeCommand(source: string) {
  return {
    executable: process.execPath,
    args: ["-e", source],
    commandForDisplay: `node -e ${JSON.stringify(source)}`,
  };
}

export function isPosixModeMeaningful(): boolean {
  return process.platform !== "win32";
}

export function normalizeTextNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
```

- [ ] **Step 2: Run only the currently failing process tests and verify failures are caused by old test fixtures.**

Run: `npx vitest run test/process-manager.test.ts`

Expected before fixture migration: failures referencing `/bin/bash`, EPIPE from a missing shell, or missing expected output.

- [ ] **Step 3: Replace shell-specific fixtures with `nodeCommand()` and gate POSIX-only mode assertions.**

For mode checks:

```ts
if (isPosixModeMeaningful()) {
  expect((await stat(path)).mode & 0o777).toBe(0o640);
}
```

For newline checks:

```ts
expect(normalizeTextNewlines(await readFile(path, "utf8"))).toBe("new\n");
```

For path expectations use `path.resolve()` rather than literal `/` or `/tmp`.

- [ ] **Step 4: Re-run the focused baseline.**

Run: `npx vitest run test/process-manager.test.ts test/config.test.ts test/file-service.test.ts test/mcp.integration.test.ts test/oauth.integration.test.ts test/all-tools.integration.test.ts`

Expected: all tests in these files pass on Windows.

- [ ] **Step 5: Run the full baseline and build.**

Run: `npm test && npm run build`

Expected: 0 failed tests and build exit code 0.

- [ ] **Step 6: Commit.**

```bash
git add test/
git commit -m "test: make Windows baseline cross-platform"
```

---

### Task 2: Compact Process Results and De-duplicate MCP Payloads

**Files:**
- Modify: `src/process-manager.ts`
- Modify: `src/exec-tools.ts`
- Modify: `src/tool-result.ts`
- Create: `test/tool-result.test.ts`
- Modify: `test/process-manager.test.ts`
- Modify: `test/all-tools.integration.test.ts`
- Modify: `test/mcp.integration.test.ts`

**Interfaces:**
- Produces: `ProcessOutputMode = "compact" | "streams" | "metadata"`
- `ProcessManager.read(sessionId, { afterSeq?, waitMs?, maxOutputBytes?, outputMode? })`
- `successResult(data, options?)` where content text is not a second JSON copy of large structured data.

- [ ] **Step 1: Write a failing serialization amplification test.**

```ts
it("does not duplicate a large process payload into text and structured content", () => {
  const output = "x".repeat(256 * 1024);
  const result = successResult(
    { sessionId: "s", output, nextSeq: 2, hasMore: false },
    { text: output },
  );
  const bytes = Buffer.byteLength(JSON.stringify(result));
  expect(bytes).toBeLessThan(output.length * 2.2);
});
```

- [ ] **Step 2: Run the test and verify it fails against the current double-serialized result.**

Run: `npx vitest run test/tool-result.test.ts`

Expected: size assertion fails.

- [ ] **Step 3: Implement explicit text selection in `successResult`.**

Target interface:

```ts
export interface SuccessResultOptions {
  text?: string;
}

export function successResult(
  data: Record<string, unknown>,
  options: SuccessResultOptions = {},
): CallToolResult {
  const text = options.text ?? summarizeStructuredResult(data);
  return {
    content: text ? [{ type: "text", text }] : [],
    structuredContent: data,
  };
}
```

`summaryStructuredResult()` must emit a short summary, not `JSON.stringify(data)`.

- [ ] **Step 4: Write failing tests for `outputMode`.**

```ts
expect((await manager.read(id, { outputMode: "compact" })).stdout).toBeUndefined();
expect((await manager.read(id, { outputMode: "compact" })).output).toContain("hello");
expect((await manager.read(id, { outputMode: "streams" })).stdout).toContain("hello");
expect((await manager.read(id, { outputMode: "metadata" })).output).toBe("");
```

- [ ] **Step 5: Implement output-mode shaping without changing retained chunk storage or `afterSeq`.**

`compact` returns interleaved `output`; `streams` also returns separated `stdout`/`stderr`; `metadata` selects no chunks but still returns state and byte counters.

- [ ] **Step 6: Expose `outputMode` in `exec_command`, `run_script`, `read_process`, `write_stdin`, and `terminate_process`.**

Default: `compact`.

- [ ] **Step 7: Update MCP integration expectations to read canonical `output` by default and separated streams only when `outputMode: "streams"` is requested.**

- [ ] **Step 8: Run focused tests and payload benchmark.**

Run: `npx vitest run test/tool-result.test.ts test/process-manager.test.ts test/mcp.integration.test.ts test/all-tools.integration.test.ts`

Run a Node one-liner that serializes a 256 KiB result and record amplification in test output or docs; target under 2.2x.

- [ ] **Step 9: Commit.**

```bash
git add src/process-manager.ts src/exec-tools.ts src/tool-result.ts test/
git commit -m "perf: compact MCP process results"
```

---

### Task 3: Add ChatGPT Web Runtime Profile

**Files:**
- Modify: `.env.example`
- Modify: `deploy/remote-dev-mcp.env.example`
- Modify: `README.md`
- Create: `deploy/profiles/chatgpt-web.env.example`
- Modify: `test/config.test.ts`

**Interfaces:**
- Profile values:
  - `MCP_MAX_OUTPUT_BYTES=131072`
  - `MCP_MAX_RETAINED_PROCESS_OUTPUT_BYTES=1048576`
  - `MCP_PROCESS_RETENTION_MS=900000`
  - `MCP_MAX_PROCESSES=32`
  - `MCP_MAX_FILE_CHUNK_BYTES=262144`

- [ ] **Step 1: Write a config test that loads the profile values and confirms all five values.**
- [ ] **Step 2: Run the test and verify the profile file/fixture does not yet exist.**
- [ ] **Step 3: Add the profile example and README guidance explaining cursor pagination and why small pages are safer for browser MCP clients.**
- [ ] **Step 4: Run `npx vitest run test/config.test.ts` and `npm run build`.**
- [ ] **Step 5: Commit.**

```bash
git add .env.example deploy README.md test/config.test.ts
git commit -m "docs: add ChatGPT Web runtime profile"
```

---

### Task 4: Process Cleanup, Filters, and Aggregate Stats

**Files:**
- Modify: `src/process-manager.ts`
- Modify: `src/exec-tools.ts`
- Modify: `src/http-server.ts`
- Modify: `test/process-manager.test.ts`
- Modify: `test/all-tools.integration.test.ts`
- Modify: `test/mcp.integration.test.ts`

**Interfaces:**
- `ProcessManager.list({ runningOnly?, limit?, since? })`
- `ProcessManager.forget(sessionId): boolean`
- `ProcessManager.clearCompleted(olderThanMs?: number): number`
- `ProcessManager.stats(): { running; completedRetained; capacity; retainedOutputBytes; droppedOutputBytes }`
- MCP tools: `forget_process`, `clear_completed_processes`

- [ ] **Step 1: Write failing unit tests for list filters, completed-only forgetting, clear count, and stats.**
- [ ] **Step 2: Run `npx vitest run test/process-manager.test.ts` and verify the new tests fail because methods do not exist.**
- [ ] **Step 3: Implement the minimal `ProcessManager` methods.**

`forget()` must throw or return an error for a running process; it must never terminate a process implicitly.

- [ ] **Step 4: Write failing MCP inventory/call tests for the two new maintenance tools and filtered `list_processes`.**
- [ ] **Step 5: Register the new tools and update exact tool inventory expectations.**
- [ ] **Step 6: Expand `/health` with `processes`, while retaining top-level `managedProcesses`.**
- [ ] **Step 7: Run unit + integration tests.**

Run: `npx vitest run test/process-manager.test.ts test/all-tools.integration.test.ts test/mcp.integration.test.ts`

- [ ] **Step 8: Commit.**

```bash
git add src test
git commit -m "feat: manage retained process sessions"
```

---

### Task 5: Request and Process Backpressure

**Files:**
- Modify: `src/config.ts`
- Create: `src/concurrency-gate.ts`
- Modify: `src/http-server.ts`
- Modify: `src/process-manager.ts`
- Modify: `.env.example`
- Modify: `deploy/profiles/chatgpt-web.env.example`
- Create: `test/concurrency-gate.test.ts`
- Modify: `test/config.test.ts`
- Modify: `test/mcp.integration.test.ts`

**Interfaces:**
- `MCP_MAX_CONCURRENT_TOOL_CALLS`
- `MCP_MAX_CONCURRENT_PROCESSES`
- `MCP_MAX_QUEUED_REQUESTS`
- `ConcurrencyGate.run<T>(operation: () => Promise<T>): Promise<T>`
- busy errors map to HTTP 429/JSON-RPC busy error without killing existing calls.

- [ ] **Step 1: Write failing config tests for the three new integer settings.**
- [ ] **Step 2: Write failing `ConcurrencyGate` tests for immediate execution, bounded queueing, and rejection after queue saturation.**
- [ ] **Step 3: Implement `ConcurrencyGate` with FIFO queue and explicit `BusyError`.**
- [ ] **Step 4: Wrap MCP POST execution with the request gate and expose active/queued counters to health metrics.**
- [ ] **Step 5: Enforce `maxConcurrentProcesses` in `ProcessManager.start()` based on running sessions, independent from retained completed sessions.**
- [ ] **Step 6: Add integration tests that hold long-running calls/processes and verify the next call receives a busy response while prior calls remain alive.**
- [ ] **Step 7: Add recommended profile values `8`, `8`, and `32`.**
- [ ] **Step 8: Run focused tests and commit.**

```bash
git add src test .env.example deploy/profiles/chatgpt-web.env.example
git commit -m "feat: bound MCP concurrency"
```

---

### Task 6: Windows Process-tree Termination

**Files:**
- Create: `src/process-tree.ts`
- Modify: `src/process-manager.ts`
- Create: `test/process-tree.test.ts`
- Modify: `test/process-manager.test.ts`

**Interfaces:**
- `terminateProcessTree(pid: number, options: { force: boolean }): Promise<void>`
- POSIX implementation uses process-group signaling.
- Windows implementation uses bounded `taskkill /PID <pid> /T` and `/F` for forced termination.

- [ ] **Step 1: Write a Windows-only failing test that spawns a parent Node process which spawns a long-lived child and records the child PID.**
- [ ] **Step 2: Terminate the parent through `ProcessManager.terminate()` and assert both PIDs disappear. Verify the test fails against direct `child.kill()` behavior.**
- [ ] **Step 3: Implement `process-tree.ts` and route timeout/terminate/shutdown signaling through it.**
- [ ] **Step 4: Add a timeout test that confirms descendants are also removed after escalation.**
- [ ] **Step 5: Run `npx vitest run test/process-tree.test.ts test/process-manager.test.ts`.**
- [ ] **Step 6: Commit.**

```bash
git add src/process-tree.ts src/process-manager.ts test/process-tree.test.ts test/process-manager.test.ts
git commit -m "fix: terminate Windows process trees"
```

---

### Task 7: Portable Windows Scheduled Task Runtime

**Files:**
- Create: `deploy/windows/common.ps1`
- Create: `deploy/windows/server-supervisor.ps1`
- Create: `deploy/windows/tunnel-supervisor.ps1`
- Create: `deploy/windows/watchdog.ps1`
- Create: `deploy/windows/install.ps1`
- Create: `deploy/windows/uninstall.ps1`
- Create: `deploy/windows/status.ps1`
- Create: `deploy/windows/windows.env.example`
- Create: `test/windows-deploy.test.ts`
- Modify: `README.md`

**Interfaces:**
- `install.ps1 -ConfigPath <path> [-TaskPrefix <prefix>]`
- `uninstall.ps1 -TaskPrefix <prefix>`
- `status.ps1 -ConfigPath <path> [-TaskPrefix <prefix>]`
- config keys include repo path, health URL, server task name, optional tunnel task, Node args, tunnel executable/config/log paths.

- [ ] **Step 1: Write a test that parses every PowerShell file with `System.Management.Automation.Language.Parser` and fails when files do not exist.**
- [ ] **Step 2: Create `common.ps1` config parsing and process matching helpers with no machine-specific values.**
- [ ] **Step 3: Port the proven server supervisor: adopt a single matching listener child, reject unrelated port owners, wait for exit, restart after five seconds.**
- [ ] **Step 4: Port the optional tunnel supervisor with cloudflared-native `--logfile` and adoption by configured command-line match.**
- [ ] **Step 5: Port watchdog behavior: task restart, duplicate cleanup, two-failure health recycle, battery-safe settings.**
- [ ] **Step 6: Implement idempotent Scheduled Task registration. Use `MultipleInstances IgnoreNew`, `StartWhenAvailable`, no execution time limit for supervisors, and one-minute watchdog repetition.**
- [ ] **Step 7: Implement `status.ps1` to report task states, wrappers, children, listener, health, and duplicate counts as JSON plus readable text.**
- [ ] **Step 8: Add an isolated test namespace such as `cokacremote-test-<pid>` to install/status/uninstall tasks without touching production task names.**
- [ ] **Step 9: Run PowerShell parser tests and isolated install/status/uninstall integration.**
- [ ] **Step 10: Commit.**

```bash
git add deploy/windows test/windows-deploy.test.ts README.md
git commit -m "feat: add Windows production runtime"
```

---

### Task 8: MCP 2026 Cache Hints and Task Adapter

**Files:**
- Modify: `src/mcp-server.ts`
- Create: `src/mcp-tasks.ts`
- Modify: `src/exec-tools.ts`
- Modify: `test/mcp.integration.test.ts`
- Modify: `test/all-tools.integration.test.ts`

**Interfaces:**
- Stable `tools/list` metadata advertises private caching only through SDK-supported APIs/types.
- Long-running MCP task IDs map one-to-one to `ProcessManager` session IDs.
- task poll returns process state; task cancel delegates to termination.

- [ ] **Step 1: Inspect installed SDK type declarations for cache-control and task APIs; save the exact supported symbols in plan execution notes.**
- [ ] **Step 2: Write a failing discovery/tools-list test for cache metadata using only the supported SDK field names.**
- [ ] **Step 3: Implement a 5-minute private cache hint; if SDK 2.0.0 exposes no supported cache hint API, document the unsupported capability in `README.md` and do not emit invented fields.**
- [ ] **Step 4: Write a failing task capability test using the SDK-supported 2026 task API.**
- [ ] **Step 5: Implement `mcp-tasks.ts` as an adapter over `ProcessManager`; do not add a second process store.**
- [ ] **Step 6: Add a real long-running command integration test: create task, poll pending/running, observe completion, and cancel another task.**
- [ ] **Step 7: Verify legacy process-session calls still pass.**
- [ ] **Step 8: Commit supported functionality and explicit compatibility documentation.**

```bash
git add src test README.md
git commit -m "feat: extend MCP 2026 long-running workflows"
```

---

### Task 9: CIMD with DCR Fallback

**Files:**
- Modify: `src/oauth.ts`
- Modify: `src/http-server.ts`
- Modify: `src/config.ts`
- Modify: `test/oauth.integration.test.ts`
- Modify: `README.md`

**Interfaces:**
- Existing DCR endpoints remain functional.
- CIMD metadata route/document is additive and standards-shaped according to the installed SDK/protocol definitions.
- Existing OAuth PKCE/refresh/revoke flows remain unchanged for current ChatGPT clients.

- [ ] **Step 1: Inspect installed MCP SDK OAuth/CIMD type declarations and current 2026 protocol package support.**
- [ ] **Step 2: Write a failing test for the supported CIMD metadata route/document.**
- [ ] **Step 3: Implement the additive route/provider integration without deleting DCR.**
- [ ] **Step 4: Run existing OAuth PKCE/refresh/revoke integration plus the new CIMD test.**
- [ ] **Step 5: Add README migration notes that DCR remains fallback until production clients are verified.**
- [ ] **Step 6: Commit.**

```bash
git add src test README.md
git commit -m "feat: prepare OAuth client metadata discovery"
```

---

### Task 10: Full Repository Verification and Fork Push

**Files:**
- Modify only files required to fix regressions found by verification.

**Interfaces:**
- All tests green on Windows.
- Build green.
- branch pushed only to `origin`.

- [ ] **Step 1: Run `npm test`.**
- [ ] **Step 2: Run `npm run build`.**
- [ ] **Step 3: Run `git diff upstream/main...HEAD --check`.**
- [ ] **Step 4: Verify `git remote -v` shows `origin=writingdeveloper` and `upstream=kstost`.**
- [ ] **Step 5: Push `feat/chatgpt-web-windows-runtime` to `origin`.**

Run: `git push -u origin feat/chatgpt-web-windows-runtime`

- [ ] **Step 6: Record fork branch URL and commit range; do not open an upstream PR yet because host rollout evidence is still required.**

---

### Task 11: Deploy and Fault-inject on SIHYEONG-4080 (`@notebook`)

**Files/Host State:**
- Deployment target: `C:\projects\cokacremote`
- Preserve existing `.oauth_approval_key.txt`, `oauth-state.json`, Cloudflare config/credentials, WakaTime config, and current task definitions until replacement verifies successfully.

**Interfaces:**
- production profile: 128 KiB output, 1 MiB retained output, 15-minute completed retention, 32 sessions, 256 KiB file chunks, 8 concurrent calls/processes, queue 32.

- [ ] **Step 1: Snapshot current branch/commit, runtime scripts, Scheduled Task XML, `.env`/environment values with secrets masked, and current PIDs to a timestamped rollback directory outside Git.**
- [ ] **Step 2: Build the fork worktree and copy only built code + portable Windows runtime scripts needed by production, preserving private config files.**
- [ ] **Step 3: Convert current machine settings into the new private Windows config file and apply ChatGPT Web profile values.**
- [ ] **Step 4: Run `deploy/windows/install.ps1` idempotently and verify exactly one server wrapper/Node and one tunnel wrapper/cloudflared.**
- [ ] **Step 5: Verify local `/health` and process metrics.**
- [ ] **Step 6: Run public MCP 2026 `server/discover`, `tools/list`, and `exec_command`.**
- [ ] **Step 7: Invoke actual `@notebook.exec_command` from ChatGPT and verify success.**
- [ ] **Step 8: Generate at least 40 short completed commands and verify retained sessions remain at/below 32 and payload pages stay bounded.**
- [ ] **Step 9: Kill Node child; verify supervisor recovery.**
- [ ] **Step 10: Kill server wrapper while Node survives; verify watchdog restores wrapper and adopts the same Node without duplicates.**
- [ ] **Step 11: Inject two health failures; verify watchdog recycles Node and clears fail counter after recovery.**
- [ ] **Step 12: Repeat wrapper/child recovery for local cloudflared.**
- [ ] **Step 13: Scan server/tunnel/watchdog logs for new unexplained 401/403/OAuth/FORBIDDEN/error entries.**

---

### Task 12: Deploy Compatible Runtime to SIHYEONG-MAIN (connector label `@4080`)

**Files/Host State:**
- Deployment target: `C:\Users\SIHYEONG\Documents\GitHub\cokacremote`
- Existing public URL: `https://cokac.writingdeveloper.blog`

**Interfaces:**
- Use common server supervisor/watchdog and ChatGPT profile.
- Tunnel supervision remains disabled unless local topology inspection proves a local cloudflared process/config owns the route.

- [ ] **Step 1: Snapshot current commit, `.env` with secrets masked, `run-hidden.ps1`, task XML, listener bind, route health, and PIDs.**
- [ ] **Step 2: Determine public route topology by inspecting services/tasks/processes/config references; do not change bind address yet.**
- [ ] **Step 3: Test whether the public route remains healthy with a temporary loopback-only listener on an alternate port/path or equivalent safe probe. If the upstream route requires `192.168.1.69`, retain the LAN bind.**
- [ ] **Step 4: Search local scheduled scripts/services for use of the permanent bearer token. Keep `MCP_AUTH_TOKEN` if any live automation depends on it; otherwise migrate to OAuth-only.**
- [ ] **Step 5: Deploy built fork code and private host config with ChatGPT profile.**
- [ ] **Step 6: Install server supervisor + watchdog only; install tunnel supervisor only if Step 2 proves it is locally applicable.**
- [ ] **Step 7: Verify local/public `/health`, 2026 discovery/list/call, and actual connector invocation.**
- [ ] **Step 8: Generate 40+ completed commands and verify process retention remains bounded below the previous 128 saturation.**
- [ ] **Step 9: Perform Node child kill, server wrapper kill/adoption, and health-failure recycle tests.**
- [ ] **Step 10: Scan logs and verify no unexplained auth/server errors.**

---

### Task 13: Upstream Contribution Preparation

**Files:**
- Create: `docs/upstream-contribution-notes.md`

**Interfaces:**
- Separate generic upstream candidates from private fork-only deployment policy.

- [ ] **Step 1: Classify commits as upstream-generic vs fork-specific.**

Generic candidates: compact results, process maintenance/stats, backpressure, Windows process-tree support, portable Windows deployment, supported MCP cache/task/CIMD compatibility.

Fork-specific: WakaTime attribution defaults, `writingdeveloper.blog` deployment examples, host-specific production configs.

- [ ] **Step 2: Write reproducible before/after evidence: payload amplification, 128-session saturation, Windows baseline count, process-tree test, and deployment fault-injection results.**
- [ ] **Step 3: Prepare suggested upstream PR slices in dependency order; do not mix WakaTime or private deployment data into generic PRs.**
- [ ] **Step 4: Run final `git status --short`, `git log --oneline upstream/main..HEAD`, `npm test`, and `npm run build`.**
- [ ] **Step 5: Push any final documentation commit to `origin` only.**

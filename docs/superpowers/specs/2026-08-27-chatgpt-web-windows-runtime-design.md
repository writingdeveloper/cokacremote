# ChatGPT Web + Windows Runtime Design

## Context

`cokacremote` is being used as a long-lived unrestricted development MCP from ChatGPT Web on Windows. Two production installations are in active use:

- `SIHYEONG-4080` (`@notebook`): OAuth-only public MCP behind Cloudflare, loopback listener, task-owned PowerShell server/tunnel supervisors, and a one-minute watchdog.
- `SIHYEONG-MAIN` (connector label `@4080`): public MCP at `cokac.writingdeveloper.blog`, Node bound to `192.168.1.69:3000`, a fire-and-forget Scheduled Task wrapper, no local tunnel supervisor, and no watchdog.

The local codebase already includes WakaTime attribution (`d1a5bbd`) and MCP 2026-07-28 compatibility (`fdf30e8`) on top of upstream `kstost/cokacremote@532ae47`.

Observed production evidence:

- `SIHYEONG-4080` had 54 retained managed processes during normal use.
- `SIHYEONG-MAIN` reached exactly 128/128 retained managed processes.
- Default process retention is 60 minutes, max processes 128, per-process retained output 4 MiB, and default per-read output 1 MiB.
- A synthetic 256 KiB process output expands to about 4x in the current MCP result because `stdout`, `output`, `structuredContent`, and JSON text content duplicate the same bytes.
- Chrome on the active workstation was using about 5.6 GiB private memory across all Chrome processes; this is not attributable solely to ChatGPT, but reducing MCP payload size is a direct and controllable optimization.
- The clean Windows baseline currently has 14/52 failing tests. Root causes include hard-coded `/bin/bash` and POSIX paths/modes/newlines in tests, plus Windows child-process lifecycle differences.

## Goals

1. Make tool responses substantially smaller for ChatGPT Web without losing resumable process output.
2. Bound retained process state and expose explicit process cleanup/filtering tools.
3. Add request/process backpressure suitable for many concurrent ChatGPT conversations.
4. Make Windows a first-class production target with reproducible supervisor/watchdog deployment.
5. Improve Windows process-tree termination so descendants do not become orphans.
6. Expand health/metrics so saturation, memory, and output retention are observable.
7. Preserve MCP 2026-07-28 compatibility and add safe cache hints where supported.
8. Add task-oriented long-running execution without removing the existing process-session API.
9. Prepare OAuth client registration for CIMD while preserving DCR compatibility.
10. Deploy first to `SIHYEONG-4080`, verify failure recovery and public MCP interoperability, then deploy the compatible subset to `SIHYEONG-MAIN`.

## Non-goals

- Do not change or touch `til-shorts`.
- Do not commit machine secrets, OAuth state, Cloudflare credentials, Tailscale credentials, or domain-specific private files.
- Do not require Linux users to adopt Windows deployment tooling.
- Do not remove the existing process/session APIs (`exec_command`, `read_process`, `write_stdin`, `terminate_process`).
- Do not remove DCR until MCP clients in production no longer require it.
- Do not assume the `SIHYEONG-MAIN` public route is locally owned by a `cloudflared.exe` process; its topology must remain host-specific.

## Repository and Branching

- `origin`: `https://github.com/writingdeveloper/cokacremote.git`
- `upstream`: `https://github.com/kstost/cokacremote.git`
- implementation branch: `feat/chatgpt-web-windows-runtime`
- upstream synchronization happens via explicit fetch/rebase or merge from `upstream/main`; no pushes to upstream.
- machine-specific configuration remains outside Git; portable templates and installers live under `deploy/windows/`.

## 1. Cross-platform Baseline

The Windows test suite must become meaningful before new behavior is accepted.

Tests that execute commands should use platform-neutral helpers based on `process.execPath` and Node `-e` snippets unless they are explicitly testing shell behavior. Path expectations must use `path.resolve`/`path.join`. POSIX mode assertions must be gated on non-Windows platforms because Windows does not provide POSIX chmod semantics. Newline assertions must compare the intended logical content rather than relying on Git Bash patch output to use LF on Windows.

The production server remains able to use Git Bash through `MCP_DEFAULT_SHELL`; this change only removes accidental POSIX assumptions from cross-platform tests.

## 2. ChatGPT Web Output Contract

### Compact process results

Process tools will default to a compact result optimized for MCP clients:

- one canonical `output` string containing interleaved stdout/stderr chunks in arrival order,
- process metadata (`sessionId`, `pid`, `running`, timestamps, exit state, `nextSeq`, `hasMore`, byte counters),
- no duplicate `stdout` and `stderr` strings by default.

An explicit `outputMode` parameter will support:

- `compact` (default): canonical `output` only,
- `streams`: include `stdout` and `stderr` in addition to `output` for callers that require separated streams,
- `metadata`: no output body, metadata only.

`maxOutputBytes` remains cursor-paginated with `afterSeq`; lowering a page size never loses retained output unless the configured retained-output limit itself is exceeded.

### MCP content de-duplication

`CallToolResult` will not serialize the entire structured object into both `content[].text` and `structuredContent`.

For tools with structured data:

- `structuredContent` is authoritative machine-readable data.
- `content[].text` is a concise human-readable summary or the canonical primary text only.

For large process/file reads, the content text must not contain a second JSON-encoded copy of the same payload.

Compatibility tests will verify that ChatGPT-style callers can still read useful text while structured clients retain metadata.

## 3. ChatGPT Web Runtime Profile

A documented profile will use these production defaults for heavy ChatGPT Web use:

- `MCP_MAX_OUTPUT_BYTES=131072` (128 KiB)
- `MCP_MAX_RETAINED_PROCESS_OUTPUT_BYTES=1048576` (1 MiB)
- `MCP_PROCESS_RETENTION_MS=900000` (15 minutes)
- `MCP_MAX_PROCESSES=32`
- `MCP_MAX_FILE_CHUNK_BYTES=262144` (256 KiB)

These values are deployment-profile recommendations, not global library defaults, so existing users are not silently broken.

## 4. Process Lifecycle and Cleanup

Add explicit process maintenance APIs:

- `list_processes({ runningOnly?, limit?, since? })`
- `forget_process({ sessionId })` for completed sessions only
- `clear_completed_processes({ olderThanMs? })`

`ProcessManager` will expose aggregate stats without serializing every process:

- running count
- completed-retained count
- capacity
- retained output bytes
- total dropped output bytes

Capacity behavior remains safe: running processes are never evicted merely to create space.

## 5. Backpressure

Introduce configuration:

- `MCP_MAX_CONCURRENT_TOOL_CALLS` (recommended ChatGPT profile: 8)
- `MCP_MAX_CONCURRENT_PROCESSES` (recommended: 8)
- `MCP_MAX_QUEUED_REQUESTS` (recommended: 32)

The HTTP MCP layer will reject excess queued work with a clear busy response rather than allowing unbounded simultaneous process creation. Process creation also enforces a separate running-process ceiling.

Read-only lightweight methods such as health checks do not consume a process slot. Existing active calls are never terminated merely because the queue becomes full.

## 6. Health and Metrics

`/health` remains cheap and unauthenticated but gains non-secret operational metrics:

```json
{
  "processes": {
    "running": 2,
    "completedRetained": 8,
    "capacity": 32,
    "retainedOutputBytes": 131072,
    "droppedOutputBytes": 0
  },
  "requests": {
    "active": 1,
    "queued": 0,
    "maxConcurrent": 8,
    "maxQueued": 32
  },
  "memory": {
    "rssBytes": 100000000,
    "heapUsedBytes": 50000000
  }
}
```

The existing top-level fields required by current monitoring remain for compatibility where practical.

## 7. Windows Process Trees

On POSIX, current process-group signaling remains. On Windows, a process tree abstraction will terminate descendants reliably. The preferred implementation is a Windows-specific helper that invokes `taskkill /PID <pid> /T` for graceful tree termination where possible and `/F` for forced termination, with bounded execution and clear error reporting. If a later implementation uses Job Objects, it must preserve the same interface and tests.

Tests will create a parent process that creates a child and verify both are gone after termination/timeout.

## 8. Windows Production Runtime

Portable scripts under `deploy/windows/` will provide:

- `server-supervisor.ps1`: adopt a matching existing server child or start one; restart child after exit.
- `tunnel-supervisor.ps1`: optional Cloudflare tunnel supervision, using cloudflared-native `--logfile`; enabled only when configured.
- `watchdog.ps1`: restart missing Scheduled Tasks, check local health, recycle an unhealthy Node after two consecutive failures, and remove duplicates.
- `install.ps1`: register/update Scheduled Tasks idempotently from a config file.
- `uninstall.ps1`: remove only the tasks created by this deployment.
- `status.ps1`: report task state, wrapper/child PIDs, listener, health, and duplicates.
- `windows.env.example` or equivalent non-secret config template.

Scripts must not contain machine-specific domains, credentials, user names, or fixed repository paths. They receive these from parameters/config/environment.

The watchdog must be allowed to run on battery and must not stop merely because the power source changes. `StartWhenAvailable` is required.

## 9. Host-specific Deployment Policy

### SIHYEONG-4080 / `@notebook`

- bind `127.0.0.1:8890`
- OAuth-only (`MCP_AUTH_TOKEN` empty)
- Cloudflare tunnel is locally supervised
- ChatGPT Web runtime profile enabled
- WakaTime tracking preserved
- watchdog + health recycling enabled

### SIHYEONG-MAIN / connector label `@4080`

- keep the current public routing topology until verified; do not blindly install a local cloudflared supervisor
- migrate server to the common Windows supervisor/watchdog
- use the ChatGPT Web runtime profile
- prefer loopback binding only if the existing external route can still reach the service; otherwise retain the required LAN bind
- migrate to OAuth-only only after confirming no external automation still depends on the permanent bearer token

## 10. MCP 2026-07-28

Keep the already implemented 2026-07-28 discovery/list/call compatibility and legacy compatibility required by deployed clients.

Where the installed MCP SDK supports cache-control metadata for stable tool inventories, publish a private cache hint for `tools/list`, targeted at a 5–30 minute TTL. The implementation must feature-detect or type-check the SDK API rather than emitting undocumented fields.

## 11. Task-oriented Long-running Work

Add an MCP task adapter for long-running process sessions only if supported by the installed SDK/protocol surface. It will wrap existing `ProcessManager` sessions rather than introducing a second process runtime. Task cancellation delegates to process termination; task polling delegates to process reads/metadata. Existing tools remain fully usable for clients that do not support MCP Tasks.

The adapter must be guarded by integration tests for discovery/capabilities and a real long-running command.

## 12. OAuth CIMD Preparation

Implement CIMD support as an additive path:

- serve/consume standards-compliant client metadata documents where the MCP SDK/protocol supports them,
- retain DCR endpoints and existing ChatGPT OAuth behavior as fallback,
- document migration and telemetry/logging needed before DCR can ever be removed.

No existing authorized ChatGPT client is invalidated by this change.

## 13. Validation Strategy

Every behavioral change follows test-first development.

Required automated verification:

1. Windows cross-platform baseline tests pass.
2. compact result tests measure serialized payload size and prove no multi-copy amplification.
3. pagination retains `afterSeq` behavior at 128 KiB pages.
4. cleanup/filter tools work and cannot forget running processes.
5. backpressure tests verify process and request ceilings.
6. health metrics match process/request state.
7. Windows process-tree test verifies descendant termination.
8. Windows deployment scripts pass PowerShell parser checks and idempotent install/status tests in an isolated task-name namespace where practical.
9. MCP 2026 discovery, `tools/list`, and `exec_command` integration remain green.
10. OAuth PKCE/refresh/revoke integration remains green.
11. CIMD/DCR compatibility tests pass.
12. `npm run build` and complete `npm test` pass on Windows before deployment.

Production rollout verification on each host:

- local `/health` = 200
- exactly one server wrapper and one Node child
- managed-process count remains bounded after stress calls
- public 2026 discovery/list/call succeeds
- actual ChatGPT connector invocation succeeds
- deliberate child kill recovers
- deliberate wrapper kill recovers through watchdog
- deliberate health failure recycles Node
- no new 401/403/OAuth/server/tunnel errors outside intentional QA

## Rollout and Rollback

Rollout is sequential:

1. make fork and protect upstream remote,
2. establish cross-platform baseline,
3. compact output and ChatGPT profile,
4. process cleanup and metrics,
5. backpressure,
6. Windows process-tree support,
7. portable Windows runtime,
8. MCP 2026 cache/task extensions,
9. CIMD compatibility,
10. deploy and fault-inject on `SIHYEONG-4080`,
11. observe actual ChatGPT connector behavior,
12. deploy the compatible subset to `SIHYEONG-MAIN`,
13. fault-inject and verify MAIN,
14. push the fork branch and prepare upstream-suitable commits/PR candidates separately.

Rollback never resets user work. Deployment rollback means restoring the previous executable/scripts/config snapshot and restarting only cokacremote-owned tasks/processes. Git rollback uses targeted commits/reverts, never `git reset --hard` or `git clean` on shared working directories.

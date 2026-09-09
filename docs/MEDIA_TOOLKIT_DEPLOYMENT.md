# Media toolkit + connector hardening production rollout — 2026-09-09

## Final source state

- Core tool hardening: `dc9de67` — bounded directory listings, SHA-256 mutation preconditions, native `read_image`, catalog/policy diagnostics.
- Connector control-plane reservation: `899a139` — independent concurrency for `server/discover`, `tools/list`, initialize/initialized and ping.
- Media integration: `5286ce7` — video/image/audio/3D review engine, persistent jobs, native preview/audio path, catalog budget profiler, patched transitive dependencies.
- Catalog cache correction: `83d8586` — ChatGPT Web discovery cache hint reduced from 24 hours to 5 minutes.
- Final media artifact cleanup: `65e2481` — internal `job.json` / `asset-request.json` are not advertised as review artifacts.
- Windows watchdog UX fix: `ce306e4` — the repeating watchdog is launched through `wscript.exe` so it does not flash a PowerShell console window.
- Catalog-drift watchdog hardening: `7d0fc12` — Windows health now verifies the expected tool count/catalog revision even when `/health` returns HTTP 200, and uninstall can remove matching orphan server/tunnel children when given its runtime config.

The current 4080 operational checkout is based on `7d0fc12`. The running Node application is TypeScript-runtime-equivalent to `ce306e4`; `7d0fc12` changes Windows deployment controls, tests and documentation, so no additional Node recycle was required. The initial rollout used clean worktrees so unrelated source changes were not destroyed. During the final 4080 reconciliation, the previous dirty `main` state was preserved in a backup branch and stash before `main` itself was promoted to the verified rollout history.

## Production parity

Both `@notebook` and `@4080` report:

- `registeredToolCount`: 27
- `toolCatalogRevision`: `core-media-2026-09-09.1`
- `runtimePolicyFingerprint`: `d35aa2e6b5169363`
- normal MCP execution gate: 8 active / 32 queued
- control/discovery gate: 4 active / 16 queued
- managed process running ceiling: 16
- retained process capacity: 64
- directory listing server cap: 5,000 entries
- discovery cache hint: 300,000 ms (5 minutes)
- media worker ceiling: 2
- retained media job directory ceiling: 64
- OAuth enabled

Host-specific media roots intentionally differ:

- notebook: `C:/Users/sihye/AppData/Local/cokacremote/media`
- 4080: `C:/Users/SIHYEONG/AppData/Local/cokacremote/media`

The media root is deliberately excluded from `runtimePolicyFingerprint`; behavior-affecting limits remain fingerprinted.

## Public endpoint verification

Fresh public checks returned HTTP 200:

- `https://mcp.writingdeveloper.blog/health`
- `https://mcp.writingdeveloper.blog/.well-known/oauth-protected-resource`
- `https://cokac.writingdeveloper.blog/health`
- `https://cokac.writingdeveloper.blog/.well-known/oauth-protected-resource`

Both public health responses reported the same 27-tool revision/fingerprint above and zero MCP aborted/error responses at verification time.

## 4080 source/runtime realignment — 2026-09-09 PDT

After the first successful 27-tool rollout, the 4080 production checkout was later rebuilt from an older dirty `main`. That recreated an older `dist` and caused the 4080 endpoint to regress while notebook remained on the new catalog. A fresh check on 2026-09-09 showed:

- 4080 local/public health: healthy, but missing the new catalog revision/count fields.
- notebook public health: still reporting 27 tools and `core-media-2026-09-09.1`.

The recovery was performed without discarding the prior work:

- backup branch: `backup/main-pre-rollout-20260909-123114`
- preserved working tree: stash created as `pre-rollout-main-working-tree-20260909-123114`
- 4080 `main` realigned to the verified rollout lineage and rebuilt from a clean `npm ci`
- Windows Scheduled Task action repaired from the obsolete local `run-hidden.ps1` helper to the tracked `deploy/windows/server-supervisor.ps1`
- watchdog task confirmed to use tracked `hidden-powershell.vbs` via `wscript.exe`
- production Node process recycled from PID 37092 to PID 50448

Post-recycle local and public 4080 health both report:

- `registeredToolCount`: 27
- `toolCatalogRevision`: `core-media-2026-09-09.1`
- `runtimePolicyFingerprint`: `d35aa2e6b5169363`
- execution gate: 8 active / 32 queued
- control gate: 4 active / 16 queued
- one matching listener and zero duplicate server processes

This closes the source/runtime split that allowed a later build from `main` to undo a previously successful production rollout.

## 4080 catalog-drift invariant hardening

A second production failure mode remained after source/runtime realignment: the old watchdog considered any HTTP 200 health response healthy. That meant a later accidental rollback to the earlier 21-tool build could remain permanently "healthy" even though the connector catalog had regressed.

Commit `7d0fc12` closes that gap:

- `EXPECTED_TOOL_COUNT` and `EXPECTED_CATALOG_REVISION` are optional Windows runtime invariants.
- `status.ps1` reports actual vs expected tool count/revision plus a mismatch reason.
- `watchdog.ps1` treats an HTTP-200 catalog mismatch exactly like another health failure and recycles the server after two consecutive failures.
- the regression test reproduces the real incident with HTTP 200, 21 tools and a legacy catalog revision; it must cause a task restart when 27 / `core-media-2026-09-09.1` is expected.
- `uninstall.ps1 -ConfigPath ...` removes matching server/tunnel child processes as well as Scheduled Tasks, fixing an orphan-process bug discovered while exercising the watchdog regression.

The private 4080 runtime config now enforces:

- expected tool count: 27
- expected catalog revision: `core-media-2026-09-09.1`

Live invariant-aware status after activation reported `health=True`, `tools=27/27`, exact catalog match, PID 50448, one matching server process, zero duplicates, and watchdog `LastTaskResult=0`. A manual watchdog pass also preserved the same healthy PID.

## Connector-disappearance root causes addressed

### 1. Tool execution could starve discovery

Previously every MCP POST shared one concurrency gate. A set of long `tools/call` / `read_process(waitMs=...)` requests could consume every slot, causing `tools/list` itself to return HTTP 429. A production-style regression reproduced this exactly.

The server now routes control/catalog methods through a separate bounded gate. The regression invariant is:

- execution gate saturated -> another ordinary `tools/call` may return 429
- at the same moment -> `tools/list` must remain 200

A live `@4080` production saturation test reached execution active 8/8 while `tools/list` remained HTTP 200. The final 27-tool integration suite verifies the same routing logic.

### 2. The former 24-hour cache made stale manifests persist

After deploying 27 tools, production health showed 27 but this already-open ChatGPT conversation still could not discover `media_*` and even omitted older tools such as `clear_completed_processes`. This is direct evidence that the conversation retained an older product-side connector registry without issuing a fresh server `tools/list`.

The earlier 24-hour cache hint therefore amplified stale registry behavior. It is now 5 minutes. The independent control gate makes frequent catalog refresh safe under load, so a long TTL is no longer needed.

Important: a conversation that already received the old 24-hour cache entry cannot have that old client-side expiry retroactively shortened by the MCP server. That one already-open conversation may still need a one-time reconnect/new conversation or to wait for its old entry to expire. After a fresh manifest is obtained, the server now advertises only a 5-minute TTL.

### 3. Earlier lifecycle/auth causes remain fixed

The previously deployed fixes remain in this release:

- root-PID / managed-slot reconciliation so dead Windows processes do not hold running slots indefinitely
- running-slot occupancy separated from retained stdout/exit bookkeeping
- process ceiling 16 rather than 8 for the browser profile
- OAuth refresh replay grace for short concurrent refresh races while preserving stale replay revocation
- stable client-facing schemas across runtime budget differences
- lifecycle/request/heartbeat counters and server instance IDs

## Existing tool improvements included

- `list_directory`: server-side maximum result cap, `nameContains`, and type filters. Client schema can remain broad while runtime policy prevents huge browser payloads.
- `write_file`, `replace_in_file`, `remove_path`: optional `expectedSha256` optimistic-concurrency precondition to reject stale writes/deletes from another session.
- `read_image`: native PNG/JPEG image content with byte/pixel caps and no base64 duplication in text metadata.
- process tools: dead-PID reconciliation, compact output, output modes, long-poll defaults, bounded retained output, completed-session pruning.
- `/health`: catalog revision, runtime policy fingerprint, separate execution/control gate stats, MCP request/error/abort counters.

## Media tools

The catalog adds four MCP tools:

- `media_capabilities`
- `media_submit`
- `media_job`
- `media_cancel`

Actions supported through `media_submit`:

- `probe`
- `image_review`
- `image_compare`
- `video_review`
- `audio_review`
- `asset_audit`
- `asset_preview`

Production CLI smoke on both machines successfully generated an `image_review` preview from a local synthetic PNG. A fresh post-realignment 4080 smoke also completed job `9f1b4dba-2b42-4e50-b88a-fd6a8b6f3782` through the production `dist`, with `acceptance=NOT_REVIEWED`, `preview.jpg` present, and no internal bookkeeping JSON advertised as an artifact. 4080 reported FFmpeg/ffprobe 8.1.1 and Blender 5.2 LTS available; notebook reported the same major toolchain during rollout smoke.

## Verification evidence

Verified operational source HEAD `7d0fc12` before this documentation-only evidence update:

- test files: 25
- tests: 117 passed / 0 failed
- TypeScript typecheck: PASS
- build: PASS
- `git diff --check`: PASS
- npm audit: 0 known vulnerabilities

A catalog regression enforces a 128 KiB upper bound. Measured 27-tool catalog payload was approximately 33.5 KiB. `npm run profile:tools` is available for repeatable non-destructive profiling.

Representative in-memory profiling on the integration host showed low-millisecond `stat_path` / bounded `list_directory` calls; `media_capabilities` is intentionally slower because it launches FFmpeg/ffprobe/Blender to report actual installed versions.

The final lockfile patches two transitive packages within compatible ranges:

- `hono` 4.13.3 -> 4.13.7
- `qs` 6.15.3 -> 6.16.0

An earlier 4080 checkout had historical SDK1 and manually installed SDK2 packages coexisting in `node_modules`, which once caused npm's dependency-graph updater to fail with an internal `edgesOut` error. The final realignment superseded that state with a clean `npm ci`; the current install audits successfully with 0 known vulnerabilities and no manual package-directory substitution is required for the current runtime.

## Rollback material

Notebook:

- media runtime snapshot: `C:/Users/sihye/AppData/Local/Temp/cokacremote-media-20260909-110144`
- pre-5-minute-TTL env snapshot: `C:/Users/sihye/AppData/Local/Temp/cokacremote-env-before-ttl-20260909-110701.production`

4080:

- media runtime snapshot: `C:/Users/SIHYEONG/AppData/Local/Temp/cokacremote-media-20260909-110845`
- the same snapshot contains `runtime-packages/hono-before` and `runtime-packages/qs-before` after the npm graph issue was identified.
- pre-realignment Git branch: `backup/main-pre-rollout-20260909-123114`
- pre-realignment dirty working tree: stash message `pre-rollout-main-working-tree-20260909-123114`

Rollback snapshots are intentionally retained. Unrelated project processes and dirty source changes were not removed.

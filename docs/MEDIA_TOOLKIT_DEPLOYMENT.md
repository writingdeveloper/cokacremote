# Media toolkit + connector hardening production rollout — 2026-09-09

## Final source state

- Core tool hardening: `dc9de67` — bounded directory listings, SHA-256 mutation preconditions, native `read_image`, catalog/policy diagnostics.
- Connector control-plane reservation: `899a139` — independent concurrency for `server/discover`, `tools/list`, initialize/initialized and ping.
- Media integration: `5286ce7` — video/image/audio/3D review engine, persistent jobs, native preview/audio path, catalog budget profiler, patched transitive dependencies.
- Catalog cache correction: `83d8586` — ChatGPT Web discovery cache hint reduced from 24 hours to 5 minutes.
- Final media artifact cleanup: `65e2481` — internal `job.json` / `asset-request.json` are not advertised as review artifacts.
- Windows watchdog UX fix: `ce306e4` — the repeating watchdog is launched through `wscript.exe` so it does not flash a PowerShell console window.
- Catalog-drift watchdog hardening: `7d0fc12` — Windows health now verifies the expected tool count/catalog revision even when `/health` returns HTTP 200, and uninstall can remove matching orphan server/tunnel children when given its runtime config.
- Runtime doctor + catalog telemetry: `114b4f6` — `/health` records live `server/discover` / `tools/list` activity and `npm run doctor` separates server faults from plausible client-side manifest caching.
- Public operations/release guidance: `933f073` — README/repository metadata, CHANGELOG, SECURITY policy and explicit release checklist were brought in line with the 27-tool Linux/Windows deployment.
- Windows Cloudflare token-file support: `fa54790` + `9d9a2a5` — the supervisor can use an ACL-restricted token file without placing the secret token in process arguments; the hosted Windows regression is path-alias independent.
- External production monitoring: `d1afdbb` — hourly GitHub-hosted smoke checks both public endpoints for availability, 27-tool/catalog correctness and cross-host policy parity.
- Maintenance/repository controls: `44e3653` + `6faa0a0` — weekly Dependabot updates, contribution guidance, and a default-branch ruleset blocking deletion/non-fast-forward pushes while preserving verified fast-forward maintenance.
- Authentication/CIMD hardening: `5dfeac6` — linear Bearer parsing, failed-auth rate limiting, safer configuration errors, explicit `shell:false`, and stronger CIMD SSRF/DNS-rebinding boundaries.
- OAuth HTML sanitizer hardening: `ede9b24` — standard modeled `escape-html` sanitizer; the reflected-XSS CodeQL alert closed automatically as fixed.

The currently deployed 4080 application `dist` was built from clean commit `ede9b24`, and its production Node process is PID 41552. The 4080 source checkout was clean at that commit immediately before this evidence-only documentation update; later documentation-only commits do not require a Node recycle. Notebook intentionally keeps its older dirty/private source checkout unchanged, but its deployed `dist` was built from the same clean `ede9b24` source and runs as PID 55092. Both production endpoints therefore execute the same security-hardened application code while preserving notebook's unrelated source work. The initial rollout used clean worktrees so unrelated changes were not destroyed; the 4080 reconciliation likewise preserved the previous dirty state in a backup branch and stash before `main` was promoted to the verified rollout history.

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

## Cross-platform CI hardening and final 4080 recycle

GitHub Actions was added after the rollout so future changes are checked on both Linux and Windows instead of relying only on the 4080 host. The first hosted run intentionally exposed real portability problems rather than being weakened to pass:

- Windows-style WakaTime entities were being resolved as POSIX-relative paths on Linux.
- the WakaTime exec integration test hard-coded the Windows Git Bash path.
- a POSIX process-capacity assertion assumed `SIGKILL` delivery was synchronous.
- Ubuntu's older Blender rejected `--offline-mode`, which is available only on newer Blender CLI versions.

Commit `75da327` fixes those issues. Blender review now probes the installed version, always keeps file auto-execution disabled, and adds `--offline-mode` only when supported. Older Blender remains usable with an explicit report warning that OS-level network isolation is not provided by that fallback.

GitHub Actions run `34398498508` passed end-to-end:

- Windows runtime regression: PASS, including real Scheduled Task/watchdog/process-lifecycle tests.
- Linux full regression: PASS, including FFmpeg/Blender media tests, typecheck, build and production dependency audit.

After hosted CI passed, the freshly built production `dist` was recycled from PID 50448 to PID 43788. Local and public 4080 health then reported `27/27`, exact `core-media-2026-09-09.1` catalog match, one listener and zero duplicates. Public notebook health continued to report the same catalog revision and runtime policy fingerprint.

## Runtime doctor, manifest telemetry, and Cloudflare route recovery

Commit `114b4f6` added catalog-discovery telemetry and the built-in runtime doctor. The 4080 production server was recycled again to PID 50876 with that runtime. The fresh server then showed ordinary MCP activity while `catalogDiscovery.requestCount=0`, `successCount=0` and `failureCount=0`. At the same time this already-open ChatGPT conversation still could not discover the `media_*` tools. This is direct runtime evidence that the conversation is reusing a product-side cached manifest without issuing a fresh `tools/list` or `server/discover` to the server. `npm run doctor -- --url https://cokac.writingdeveloper.blog --skip-media` therefore passes health/catalog/OAuth checks and emits only the expected cached-manifest warning.

During this work the 4080 LAN origin remained healthy while `https://cokac.writingdeveloper.blog` temporarily timed out behind Cloudflare. The DNS route had drifted away from the intended 4080 tunnel, so a temporary `sihyeong-4080` tunnel connector was used only as a recovery canary. Secret token transfer was not automated. The durable fix instead reused notebook's already-authenticated, Scheduled-Task-managed `cokacremote` tunnel (ID `c92a273c-fb45-47d3-a8b7-088e0fc6f70b`) and added a second ingress:

- `mcp.writingdeveloper.blog` -> `http://127.0.0.1:8890`
- `cokac.writingdeveloper.blog` -> `http://192.168.1.69:3000`

The ingress configuration passed `cloudflared tunnel ingress validate` and rule-resolution checks before the persistent tunnel task was restarted. DNS for `cokac.writingdeveloper.blog` was then moved to the persistent `cokacremote` tunnel and the temporary canary was stopped. Immediately after the canary stopped, one transient 502 occurred while an older Cloudflare connector was still visible; after that stale connector disappeared, the 4080 LAN origin passed 12/12 direct health checks and the two public endpoints passed 30/30 consecutive paired health checks. The canary tunnel now reports no active connection. The persistent tunnel task remains Running with one local config-driven cloudflared process (PID 54192).

Commit `fa54790` keeps a future 4080-local token-file supervisor path available, but it is intentionally **not activated** on the current 4080 host: `TUNNEL_ENABLED=false` remains the private runtime setting because moving the Cloudflare secret was not automated. The persistent notebook tunnel is the current production public route. Hosted run `34405809704` verifies the final `9d9a2a5` code on both Linux and Windows; the earlier `fa54790` Windows failure was only an 8.3-vs-long TEMP path assertion and was corrected without weakening the token non-disclosure invariant.

### Notebook Windows runtime sync and watchdog cleanup boundary

The notebook deployment checkout intentionally remains a dirty/private runtime checkout, but its ignored `deploy/windows/` runtime scripts were older than the verified public source. A clean `c7217cf` copy was fetched into TEMP, every staged PowerShell file passed AST parsing, and staged `status.ps1` successfully read the live private config before any file was replaced. The previous runtime directory was backed up as `cokacremote-windows-runtime-before-c7217cf-20260909-143341`, then the verified Windows runtime files (including `hidden-powershell.vbs`) were copied into the notebook deployment. The private notebook config now also enforces `EXPECTED_TOOL_COUNT=27` and `EXPECTED_CATALOG_REVISION=core-media-2026-09-09.1`.

Notebook currently has one legacy malformed Scheduled Task named `cokacremote-watchdog` (Highest run level) whose wscript action contains no VBS argument and returns `2147942667`. A second existing task, `cokacremote-watchdog-bg`, is the working hidden watchdog. Replacing the Highest task from the non-elevated MCP session was correctly denied by Windows, so no UAC/elevation bypass was attempted. The working `-bg` task was left intact; after the runtime sync its next one-minute execution completed with `LastTaskResult=0`, while the notebook server remained `27/27`, the persistent tunnel remained Running in `config` mode, and both public endpoints returned HTTP 200.

The remaining cleanup is deliberately administrator-only: run the synced elevated installer to recreate the standard `cokacremote-watchdog` with the tracked hidden launcher, verify result 0, then remove the temporary/legacy `-bg` task. Until that maintenance window, the malformed Highest task is noisy but the Limited `-bg` task provides the functioning watchdog path.

To cover failures that neither host-local watchdog can see (for example DNS/Cloudflare route drift while both origins remain healthy), `scripts/production-smoke.mjs` and `.github/workflows/production-smoke.yml` add an external, read-only health check. The scheduled workflow runs hourly at minute 17, retries transient network failures, validates `status=ok`, 27 tools, `core-media-2026-09-09.1`, OAuth enabled, valid protected-resource metadata, and identical runtime-policy fingerprints across `mcp.writingdeveloper.blog` and `cokac.writingdeveloper.blog`. Its local success/failure behavior is also regression-tested so stale 21-tool payloads cannot pass silently.

## Security hardening, CodeQL closure, and production redeploy

GitHub CodeQL default setup was enabled for JavaScript/TypeScript and GitHub Actions. The first scan reported 13 alerts. Commit `5dfeac6` removed nine of them from subsequent analysis by replacing the Bearer-token regex with a linear parser, adding a 30-per-minute failed-request limiter on the MCP entry point, preventing raw invalid environment values from being reflected in configuration errors/logging, replacing a dynamic Windows process regex, explicitly using `shell:false`, and strengthening CIMD validation/fetching. CIMD now requires HTTPS + DNS hostname + standard port + non-root path; rejects credentials/fragments, IP literals and any DNS answer set containing private/special addresses; pins the request lookup to an already-validated public address; follows no redirects; and retains the 5-second / 64 KiB bounds. Regression tests exercise private-only and mixed DNS answers, IP literals, nonstandard ports, redirects, pinned-address forwarding and authentication throttling.

The remaining reflected-XSS finding was not dismissed. Commit `ede9b24` switched the OAuth approval page to the standard `escape-html` sanitizer while preserving the malicious `<script>` client-name test. CodeQL then marked alert 12 as `fixed` automatically. Three residual analyzer-model findings were investigated and dismissed as false positives with comments stored on the GitHub alerts: (1) CIMD's external-URL SSRF sink is behind the public-address validation + pinned lookup/no-redirect boundary above; (2) `runtimePolicyFingerprint` is a non-secret operational-policy checksum, not a password hash; and (3) direct `spawn(executable, argv, { shell: false })` is the documented authenticated remote-execution capability, not accidental shell-string interpolation. After that review, CodeQL open alerts were 0; Dependabot and secret-scanning open alerts were also 0 at verification time.

Local verification for this security wave passed 28 test files / 129 tests, TypeScript build and production dependency audit with 0 known vulnerabilities. Hosted CI run `34418128654` passed both Linux full regression and Windows Scheduled Task/process lifecycle regression. CodeQL run `34418127904` passed both `javascript-typescript` and `actions` analysis.

The security-hardened runtime was then deployed to both production hosts without discarding unrelated work:

- 4080: clean `ede9b24` install/build, previous `dist` backed up at `C:/Users/SIHYEONG/AppData/Local/Temp/dist.rollback-pre-security-20260909-164642`, Node recycled from PID 50876 to PID 41552.
- notebook: clean detached `ede9b24` TEMP build was canary-tested against the existing private runtime dependency tree (including the failed-auth 30x401 -> 31st 429 boundary), previous `dist` backed up at `C:/Users/sihye/AppData/Local/Temp/cokacremote-dist-pre-security-20260909-165136`, only the verified `dist` was copied into the dirty/private checkout, and Node recycled from PID 45496 to PID 55092.

Post-deploy cross-host `npm run smoke:production` passed on the first attempt: both public endpoints reported 27 tools, `core-media-2026-09-09.1`, OAuth enabled and identical `d35aa2e6b5169363` policy fingerprints. 4080 public `npm run doctor -- --url https://cokac.writingdeveloper.blog --skip-media` also passed; its only warning remained the independently measured client-side stale-manifest condition (`catalogDiscovery` still receives no fresh `tools/list`/`server/discover` from this already-open conversation).

Repository controls active after the hardening pass include secret scanning + push protection, Dependabot vulnerability/security updates, weekly npm/GitHub-Actions Dependabot PRs, CodeQL default setup, private vulnerability reporting, and ruleset `Protect main history` (ID 22699796) blocking default-branch deletion and non-fast-forward pushes without requiring PR-only maintenance.

## Maintenance closeout — 2026-09-09 PDT

The final maintenance pass updated the external smoke and low-risk dependencies without changing the 27-tool MCP contract:

- `f997e99` validates each production host's OAuth protected-resource metadata in addition to `/health`.
- `1730f08` updates exact-pinned `express-rate-limit` to 8.7.0, `zod` to 4.6.1, and development-only `tsx` to 4.23.13. Vitest 5 remains intentionally deferred as a major-version compatibility upgrade.
- `53e3d05` removes a hosted-Windows timing flake by parsing all deployment PowerShell scripts in one PowerShell process instead of launching one process per file.
- `4ef156f` stops the production smoke from echoing untrusted OAuth metadata values and adds a regression proving attacker-controlled metadata strings do not appear in stdout/stderr.

Verification for `4ef156f` completed successfully:

- local full regression: 28 test files / 130 tests PASS; TypeScript build PASS; production npm audit 0 known vulnerabilities.
- GitHub Actions run `34422685458`: Linux full regression PASS / Windows runtime regression PASS.
- CodeQL run `34422684453`: Actions PASS / JavaScript-TypeScript PASS; open CodeQL alerts returned to 0 after the clear-text logging findings were fixed in code rather than dismissed.
- Dependabot open alerts: 0; secret-scanning open alerts: 0.

Production dependency activation was completed on both hosts:

- 4080: clean `53e3d05` `npm ci` + build verified `express-rate-limit@8.7.0` and `zod@4.6.1`; old `dist` backed up at `C:/Users/SIHYEONG/AppData/Local/Temp/cokacremote-dist-pre-maintenance-20260909-174009`; the Node child was explicitly recycled from PID 41552 to PID 5116 so the new dependency tree was loaded.
- notebook: the dirty/private checkout was preserved. `express-rate-limit` was already 8.7.0; `zod@4.6.1` was staged with `npm pack`, API-smoked, and copied only into `node_modules/zod` after backing up 4.4.3 at `C:/Users/sihye/AppData/Local/Temp/cokacremote-zod-4.4.3-backup-20260909-174304`. `package.json` and `package-lock.json` hashes were verified unchanged. The Node child was recycled from PID 55092 to PID 58948 while the persistent Cloudflare tunnel remained running.

Post-recycle health on both hosts reports 27/27 tools, exact `core-media-2026-09-09.1`, identical `d35aa2e6b5169363` runtime-policy fingerprints, OAuth enabled, and zero MCP error/abort counters on the fresh instances. Cross-host `npm run smoke:production` passed on the first attempt with valid protected-resource metadata for both public endpoints.

Repository security controls remain: secret scanning, push protection, Dependabot vulnerability/security updates, automated security fixes, CodeQL default setup, private vulnerability reporting, weekly dependency PRs, and the active `Protect main history` deletion/non-fast-forward ruleset. GitHub currently exposes `secret_scanning_non_provider_patterns` and `secret_scanning_validity_checks` as disabled; an API enable attempt did not change those statuses, so they remain a non-blocking future repository-setting improvement rather than being reported as enabled.

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

Production CLI smoke on both machines successfully generated an `image_review` preview from a local synthetic PNG. A fresh post-realignment 4080 image smoke completed job `9f1b4dba-2b42-4e50-b88a-fd6a8b6f3782` through the production `dist`, with `acceptance=NOT_REVIEWED`, `preview.jpg` present, and no internal bookkeeping JSON advertised as an artifact. After the Blender compatibility change, production 3D smoke job `1b9ead7d-aeef-41ff-a2cb-a9b19e216603` completed `asset_audit` on a synthetic cube through the same `dist`; Blender 5.2.0 LTS reported 8 vertices / 12 triangles, zero non-manifold or boundary edges, and `acceptance=NOT_REVIEWED`. 4080 reports FFmpeg/ffprobe 8.1.1 and Blender 5.2.0 LTS available; notebook reported the same major toolchain during rollout smoke.

## Verification evidence

Verified deployed application code HEAD `ede9b24` before this documentation-only evidence update:

- test files: 28
- tests: 130 passed / 0 failed
- GitHub Actions run `34418128654`: Linux PASS / Windows PASS
- CodeQL run `34418127904`: JavaScript/TypeScript PASS / Actions PASS
- CodeQL open alerts: 0 after one modeled-XSS fix plus documented false-positive triage
- Dependabot open alerts: 0; secret-scanning open alerts: 0 at verification time
- cross-host production smoke: PASS after both hosts were redeployed
- public doctor: PASS with the expected catalog-discovery cache warning only
- TypeScript typecheck: PASS
- build: PASS
- `git diff --check`: PASS
- npm audit: 0 known vulnerabilities

A catalog regression enforces a 128 KiB upper bound. Measured 27-tool catalog payload was approximately 33.5 KiB. `npm run profile:tools` is available for repeatable non-destructive profiling.

Representative in-memory profiling on the integration host showed low-millisecond `stat_path` / bounded `list_directory` calls; `media_capabilities` is intentionally slower because it launches FFmpeg/ffprobe/Blender to report actual installed versions.

The final lockfile patches two transitive packages within compatible ranges:

- `hono` 4.13.3 -> 4.13.7
- `qs` 6.15.3 -> 6.16.0

The security pass also makes two runtime protections explicit direct dependencies in the verified 4080 build: `express-rate-limit@8.6.2` and `escape-html@1.0.3`. Notebook's dirty/private dependency tree was not rewritten; its existing compatible `express-rate-limit@8.7.0` + `escape-html@1.0.3` resolved the same `ede9b24` dist successfully in a local canary before deployment.

An earlier 4080 checkout had historical SDK1 and manually installed SDK2 packages coexisting in `node_modules`, which once caused npm's dependency-graph updater to fail with an internal `edgesOut` error. The final realignment superseded that state with a clean `npm ci`; the current install audits successfully with 0 known vulnerabilities and no manual package-directory substitution is required for the current runtime.

## Rollback material

Notebook:

- media runtime snapshot: `C:/Users/sihye/AppData/Local/Temp/cokacremote-media-20260909-110144`
- pre-5-minute-TTL env snapshot: `C:/Users/sihye/AppData/Local/Temp/cokacremote-env-before-ttl-20260909-110701.production`
- pre-security application `dist`: `C:/Users/sihye/AppData/Local/Temp/cokacremote-dist-pre-security-20260909-165136`

4080:

- media runtime snapshot: `C:/Users/SIHYEONG/AppData/Local/Temp/cokacremote-media-20260909-110845`
- pre-security application `dist`: `C:/Users/SIHYEONG/AppData/Local/Temp/dist.rollback-pre-security-20260909-164642`
- the same snapshot contains `runtime-packages/hono-before` and `runtime-packages/qs-before` after the npm graph issue was identified.
- pre-realignment Git branch: `backup/main-pre-rollout-20260909-123114`
- pre-realignment dirty working tree: stash message `pre-rollout-main-working-tree-20260909-123114`

Rollback snapshots are intentionally retained. Unrelated project processes and dirty source changes were not removed.

# Changelog

All notable changes to this fork are documented here. The repository has not yet published a GitHub Release tag, so the current production-tested state remains under **Unreleased** until a release is explicitly cut.

## Unreleased

### Added
- 27-tool MCP catalog with native `read_image`, retained-process cleanup tools, and bounded local media review (`media_capabilities`, `media_submit`, `media_job`, `media_cancel`).
- FFmpeg/ffprobe/Blender image, video, audio, and 3D review pipeline with persistent local jobs and `NOT_REVIEWED` acceptance semantics.
- Portable Windows Scheduled Task runtime with hidden watchdog, duplicate-process cleanup, restart recovery, and catalog-drift health invariants.
- Separate MCP control-plane concurrency gate so `tools/list` and `server/discover` remain available while long tool calls are saturated.
- Five-minute private discovery cache hints for modern MCP clients.
- Runtime catalog-discovery telemetry and `npm run doctor` diagnostics for distinguishing server faults from client-side cached manifests.
- Windows Cloudflare tunnel supervision supports mutually exclusive config-file or ACL-restricted token-file modes without placing token contents in process arguments.
- Linux full-regression and Windows runtime GitHub Actions jobs.
- Hourly external production smoke verifies both public endpoints, OAuth protected-resource metadata, the 27-tool catalog and cross-host runtime policy parity without mutating production.
- Weekly Dependabot version updates cover npm and GitHub Actions, grouping minor/patch updates while leaving major updates separate for review.

### Changed
- Maintenance dependencies updated within the existing major versions: `express-rate-limit` 8.7.0, `zod` 4.6.1, and `tsx` 4.23.13.
- Process retention/running capacity, WakaTime attribution, OAuth refresh lifecycle, file-list bounds, and optimistic SHA-256 mutation preconditions were hardened for long-running ChatGPT usage.
- README/deployment guidance now reflects the production 27-tool catalog and Windows/media capabilities.

### Security
- Bearer authentication parsing is linear, and repeated failed MCP authentication is rate-limited while successful requests remain outside the failure budget.
- CIMD client metadata fetching rejects IP literals, nonstandard HTTPS ports, private/special or mixed DNS answers, pins the outbound connection to the validated public address, and never follows redirects.
- OAuth approval HTML uses the modeled `escape-html` sanitizer, with a malicious client-name regression test.
- GitHub CodeQL default setup, secret scanning/push protection, Dependabot security updates, and default-branch history protection are enabled; the 2026-09-09 CodeQL hardening pass closed or technically triaged all initial alerts.
- Media processing rejects network sources, disables Blender file auto-execution, bounds scan/sample/output sizes, and never treats successful processing as visual/audio/artistic approval.
- The server remains intentionally unrestricted at the host permission level; operators must use strong authentication, HTTPS/private networking, and trusted clients only.

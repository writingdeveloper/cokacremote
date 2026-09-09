# Release process

`cokacremote` is currently production-tested but intentionally untagged. Creating a Git tag/GitHub Release is a separate publishing action and should happen only after the checks below are green on the exact commit being tagged.

## 1. Source verification

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
git status --short --branch
```

The working tree should be clean and the Linux + Windows GitHub Actions jobs for the target commit must both be successful.

## 2. Runtime verification

Against each production endpoint:

```bash
npm run doctor -- --url https://mcp.example.com
```

Confirm:

- tool count and `TOOL_CATALOG_REVISION` exactly match the source being released;
- OAuth protected-resource metadata is reachable when OAuth is enabled;
- the expected FFmpeg/ffprobe/Blender dependencies are available for hosts that advertise media review;
- Windows `status.ps1` reports the expected tool count/catalog revision, one listener, and zero duplicates;
- `catalogDiscovery` behavior is understood (a warning about no refresh can indicate an already-cached client manifest, not a server failure).

## 3. Smoke verification

Run at least one non-destructive file/image flow and, for media-enabled hosts, one media job. Processing completion must remain `NOT_REVIEWED`; do not convert technical success into artistic acceptance.

## 4. Release notes

Move the relevant `CHANGELOG.md` entries from `Unreleased` into the chosen version/date. Update `package.json` only if the release version changes. Re-run all checks after any version/documentation change.

## 5. Publish deliberately

Only after the exact release commit is green:

```bash
git tag -a vX.Y.Z -m "cokacremote vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --repo writingdeveloper/cokacremote --generate-notes
```

Do not tag an older deployment commit merely because it is currently running. Deploy/recycle the exact release build first, re-run the doctor, then publish the tag.

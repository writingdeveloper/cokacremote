# Contributing

`cokacremote` intentionally exposes powerful host-level development capabilities. Contributions are welcome, but changes to authentication, process execution, filesystem access, networking, OAuth, Windows supervision, media handling, or public routing should be treated as security-sensitive.

## Development setup

Use Node.js 22+ and install from the lockfile:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Before submitting a change, also run:

```bash
npm audit --omit=dev --audit-level=high
git diff --check
```

For changes that affect production health assumptions, run the non-destructive external check when the production endpoints are expected to be reachable:

```bash
npm run smoke:production
```

## Cross-platform expectations

The repository supports Linux and Windows. Do not make tests depend on one host's absolute paths, shell installation, short-vs-long Windows path aliases, or a single Blender version. GitHub Actions runs both the Linux full regression and the Windows Scheduled Task/process-lifecycle regression.

## Security and secrets

Never commit OAuth credentials, Bearer tokens, Cloudflare tunnel tokens/credentials, private keys, WakaTime credentials, machine-private environment files, or production captures containing them. Use the repository's private vulnerability reporting flow for suspected security issues instead of a public issue.

The media toolkit must remain non-destructive to source files, reject network media sources, keep execution/output bounds, and preserve `NOT_REVIEWED` semantics: successful processing is not artistic, visual, or audio approval.

## Default-branch safety

The public repository has an active `Protect main history` ruleset on the default branch. It blocks branch deletion and non-fast-forward/force pushes, but does not require pull requests or status checks, so maintainers can keep the existing verified fast-forward deployment workflow. Do not bypass or remove this history protection to land a change.

## Pull requests

Keep changes scoped and include tests for regressions. Explain any deployment or backward-compatibility impact. If a change modifies the public tool catalog, update the catalog revision/expected count, deployment invariants, doctor/smoke expectations, and relevant documentation together.

## Dependency updates

Dependabot checks npm dependencies and GitHub Actions weekly. Minor and patch updates are grouped within each ecosystem to reduce pull-request noise; major updates remain separate so breaking changes receive explicit review. Dependabot pull requests must pass the same Linux/Windows CI as human changes before merge.

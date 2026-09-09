const endpoints = (process.env.COKACREMOTE_SMOKE_ENDPOINTS ||
  "https://mcp.writingdeveloper.blog/health,https://cokac.writingdeveloper.blog/health")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const expectedToolCount = Number(process.env.COKACREMOTE_SMOKE_TOOL_COUNT || "27");
const expectedCatalogRevision =
  process.env.COKACREMOTE_SMOKE_CATALOG_REVISION || "core-media-2026-09-09.1";
const attempts = Math.max(1, Number(process.env.COKACREMOTE_SMOKE_ATTEMPTS || "3"));

if (endpoints.length < 1) throw new Error("At least one production health endpoint is required");
if (!Number.isInteger(expectedToolCount) || expectedToolCount < 1) {
  throw new Error("COKACREMOTE_SMOKE_TOOL_COUNT must be a positive integer");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readHealth(url) {
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "cache-control": "no-cache", "user-agent": "cokacremote-production-smoke/0.1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text);
      return { url, attempt, body };
    } catch (error) {
      errors.push(`attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < attempts) await sleep(2_000 * attempt);
    }
  }
  throw new Error(`${url} failed after ${attempts} attempts: ${errors.join(" | ")}`);
}

const results = await Promise.all(endpoints.map(readHealth));
const failures = [];
const fingerprints = new Set();
for (const { url, attempt, body } of results) {
  const summary = {
    url,
    attempt,
    status: body.status,
    service: body.service,
    version: body.version,
    registeredToolCount: body.registeredToolCount,
    toolCatalogRevision: body.toolCatalogRevision,
    runtimePolicyFingerprint: body.runtimePolicyFingerprint,
    oauthEnabled: body.oauthEnabled,
    processId: body.processId,
    serverInstanceId: body.serverInstanceId,
  };
  console.log(JSON.stringify(summary));
  if (body.status !== "ok") failures.push(`${url}: status=${String(body.status)}`);
  if (body.service !== "cokacremote") failures.push(`${url}: service=${String(body.service)}`);
  if (body.registeredToolCount !== expectedToolCount) {
    failures.push(`${url}: tools=${String(body.registeredToolCount)} expected=${expectedToolCount}`);
  }
  if (body.toolCatalogRevision !== expectedCatalogRevision) {
    failures.push(`${url}: catalog=${String(body.toolCatalogRevision)} expected=${expectedCatalogRevision}`);
  }
  if (body.oauthEnabled !== true) failures.push(`${url}: oauthEnabled=${String(body.oauthEnabled)}`);
  if (typeof body.runtimePolicyFingerprint !== "string" || body.runtimePolicyFingerprint.length === 0) {
    failures.push(`${url}: missing runtimePolicyFingerprint`);
  } else {
    fingerprints.add(body.runtimePolicyFingerprint);
  }
}
if (fingerprints.size > 1) {
  failures.push(`runtimePolicyFingerprint mismatch: ${[...fingerprints].join(", ")}`);
}
if (failures.length > 0) {
  console.error("Production smoke failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Production smoke PASS: ${results.length} endpoint(s), ${expectedToolCount} tools, ${expectedCatalogRevision}`);
}

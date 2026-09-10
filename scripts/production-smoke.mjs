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
const requestHeaders = {
  "cache-control": "no-cache",
  "user-agent": "cokacremote-production-smoke/0.1.0",
};

async function readJsonWithRetry(url, label) {
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: requestHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      return { url, attempt, body: JSON.parse(text) };
    } catch (error) {
      errors.push(`attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < attempts) await sleep(2_000 * attempt);
    }
  }
  throw new Error(`${label} ${url} failed after ${attempts} attempts: ${errors.join(" | ")}`);
}

async function readEndpoint(healthUrl) {
  const health = await readJsonWithRetry(healthUrl, "health");
  const origin = new URL(healthUrl).origin;
  const metadataUrl = new URL("/.well-known/oauth-protected-resource", origin).href;
  const oauth = await readJsonWithRetry(metadataUrl, "OAuth protected-resource metadata");
  return { health, oauth, origin };
}

const results = await Promise.all(endpoints.map(readEndpoint));
const failures = [];
const fingerprints = new Set();
for (const { health, oauth, origin } of results) {
  const body = health.body;
  const metadata = oauth.body;
  const expectedResource = `${origin}/mcp`;
  const expectedAuthorizationServer = `${origin}/`;
  const summary = {
    url: health.url,
    attempt: health.attempt,
    status: body.status,
    service: body.service,
    version: body.version,
    registeredToolCount: body.registeredToolCount,
    toolCatalogRevision: body.toolCatalogRevision,
    runtimePolicyFingerprint: body.runtimePolicyFingerprint,
    oauthEnabled: body.oauthEnabled === true,
    oauthMetadataValid: true,
    processId: body.processId,
    serverInstanceId: body.serverInstanceId,
  };
  console.log(JSON.stringify(summary));
  if (body.status !== "ok") failures.push(`${health.url}: status=${String(body.status)}`);
  if (body.service !== "cokacremote") failures.push(`${health.url}: service=${String(body.service)}`);
  if (body.registeredToolCount !== expectedToolCount) {
    failures.push(`${health.url}: tools=${String(body.registeredToolCount)} expected=${expectedToolCount}`);
  }
  if (body.toolCatalogRevision !== expectedCatalogRevision) {
    failures.push(`${health.url}: catalog=${String(body.toolCatalogRevision)} expected=${expectedCatalogRevision}`);
  }
  if (body.oauthEnabled !== true) failures.push(`${health.url}: OAuth is not enabled as required`);
  if (typeof body.runtimePolicyFingerprint !== "string" || body.runtimePolicyFingerprint.length === 0) {
    failures.push(`${health.url}: missing runtimePolicyFingerprint`);
  } else {
    fingerprints.add(body.runtimePolicyFingerprint);
  }

  if (metadata.resource !== expectedResource) {
    failures.push(`${origin}: protected-resource metadata has an invalid resource URL`);
  }
  if (!Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.includes(expectedAuthorizationServer)) {
    failures.push(`${origin}: protected-resource metadata is missing the expected authorization server`);
  }
  if (!Array.isArray(metadata.scopes_supported) || !metadata.scopes_supported.includes("mcp:tools")) {
    failures.push(`${origin}: protected-resource metadata is missing the mcp:tools scope`);
  }
  if (!Array.isArray(metadata.bearer_methods_supported) || !metadata.bearer_methods_supported.includes("header")) {
    failures.push(`${origin}: protected-resource metadata is missing header bearer authentication`);
  }
  if (metadata.resource_name !== "cokacremote") {
    failures.push(`${origin}: protected-resource metadata has an invalid resource name`);
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
  console.log(`Production smoke PASS: ${results.length} endpoint(s), ${expectedToolCount} tools, ${expectedCatalogRevision}, OAuth metadata valid`);
}

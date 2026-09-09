import path from "node:path";
import { pathToFileURL } from "node:url";
import { mediaCapabilities } from "./media/engine.js";
import { REGISTERED_TOOL_COUNT, TOOL_CATALOG_REVISION } from "./mcp-server.js";

type Status = "pass" | "warn" | "fail";
export interface DoctorCheck { name: string; status: Status; detail: string }
export interface RuntimeHealth {
  status?: string;
  serverInstanceId?: string;
  processId?: number;
  lastMcpRequestAt?: string;
  mcpRequestCount?: number;
  registeredToolCount?: number;
  toolCatalogRevision?: string;
  catalogDiscovery?: {
    requestCount?: number; successCount?: number; failureCount?: number;
    lastSuccessAt?: string; lastMethod?: string; lastProtocolVersion?: string; cacheTtlMs?: number;
  };
  processes?: { running?: number; runningCapacity?: number; capacity?: number };
  oauthEnabled?: boolean;
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const time = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export function evaluateHealth(
  health: RuntimeHealth,
  expectedTools = REGISTERED_TOOL_COUNT,
  expectedRevision = TOOL_CATALOG_REVISION,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [{
    name: "health",
    status: health.status === "ok" ? "pass" : "fail",
    detail: health.status === "ok" ? "HTTP health reports ok" : `health status is ${String(health.status)}`,
  }];
  checks.push({
    name: "tool-catalog",
    status: health.registeredToolCount === expectedTools && health.toolCatalogRevision === expectedRevision ? "pass" : "fail",
    detail: `tools=${String(health.registeredToolCount)}/${expectedTools} catalog=${String(health.toolCatalogRevision)} expected=${expectedRevision}`,
  });

  const d = health.catalogDiscovery;
  if (!d) {
    checks.push({ name: "catalog-discovery", status: "warn", detail: "catalog discovery telemetry is unavailable; recycle to the current runtime before diagnosing client cache state" });
  } else {
    const requests = num(d.requestCount) ?? 0;
    const successes = num(d.successCount) ?? 0;
    const failures = num(d.failureCount) ?? 0;
    const lastSuccess = time(d.lastSuccessAt);
    const lastMcp = time(health.lastMcpRequestAt);
    const ttl = num(d.cacheTtlMs) ?? 0;
    let status: Status = "pass";
    let detail = `requests=${requests} successes=${successes} failures=${failures}`;
    if (successes === 0 && (num(health.mcpRequestCount) ?? 0) > 0) {
      status = "warn";
      detail += "; MCP activity exists but no successful server/discover or tools/list reached this server instance (a client-side cached manifest is plausible)";
    } else if (failures > 0) {
      status = "warn";
      detail += `; last=${d.lastMethod ?? "unknown"} protocol=${d.lastProtocolVersion ?? "unknown"}`;
    } else if (lastSuccess !== undefined && lastMcp !== undefined && ttl > 0 && lastMcp - lastSuccess > ttl) {
      status = "warn";
      detail += "; MCP activity continued beyond the advertised cache TTL without another successful catalog refresh";
    } else if (successes > 0) {
      detail += `; last=${d.lastMethod ?? "unknown"} protocol=${d.lastProtocolVersion ?? "unknown"} at=${d.lastSuccessAt ?? "unknown"}`;
    } else {
      status = "warn";
      detail += "; no MCP/catalog activity observed since this server instance started";
    }
    checks.push({ name: "catalog-discovery", status, detail });
  }

  const remaining = health.processes?.runningCapacity;
  checks.push(remaining !== undefined && remaining <= 0
    ? { name: "process-capacity", status: "warn", detail: `running process capacity exhausted (${String(health.processes?.running)}/${String(health.processes?.capacity)})` }
    : { name: "process-capacity", status: "pass", detail: `running=${String(health.processes?.running ?? 0)} capacityRemaining=${String(remaining ?? "unknown")}` });
  return checks;
}

function rootUrl(input: string): URL {
  const url = new URL(input);
  url.pathname = "/"; url.search = ""; url.hash = "";
  return url;
}

async function fetchJson(url: URL): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(7_500) });
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  return { status: response.status, body };
}
function parseArgs(argv: string[]): { url: string; json: boolean; skipMedia: boolean } {
  let url = process.env.COKACREMOTE_DOCTOR_URL || process.env.MCP_PUBLIC_URL || `http://127.0.0.1:${process.env.MCP_PORT || "3000"}`;
  let json = false;
  let skipMedia = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") {
      const next = argv[i + 1];
      if (!next) throw new Error("--url requires a value");
      url = next; i += 1;
    } else if (arg === "--json") json = true;
    else if (arg === "--skip-media") skipMedia = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run doctor -- [--url http://127.0.0.1:3000] [--json] [--skip-media]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { url, json, skipMedia };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = rootUrl(args.url);
  const checks: DoctorCheck[] = [];
  let health: RuntimeHealth | undefined;

  try {
    const result = await fetchJson(new URL("health", root));
    if (result.status !== 200 || !result.body || typeof result.body !== "object") {
      checks.push({ name: "health-http", status: "fail", detail: `GET /health returned HTTP ${result.status}` });
    } else {
      health = result.body as RuntimeHealth;
      checks.push(...evaluateHealth(health));
    }
  } catch (error) {
    checks.push({ name: "health-http", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }

  if (health?.oauthEnabled) {
    try {
      const metadata = await fetchJson(new URL(".well-known/oauth-protected-resource", root));
      checks.push({ name: "oauth-metadata", status: metadata.status === 200 ? "pass" : "fail", detail: `protected-resource metadata HTTP ${metadata.status}` });
    } catch (error) {
      checks.push({ name: "oauth-metadata", status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!args.skipMedia) {
    try {
      const media = await mediaCapabilities();
      const missing = (["ffmpeg", "ffprobe", "blender"] as const).filter((name) => !media[name].available);
      checks.push({
        name: "media-runtime",
        status: missing.length === 0 ? "pass" : "warn",
        detail: missing.length === 0
          ? `ffmpeg=${media.ffmpeg.version} | ffprobe=${media.ffprobe.version} | blender=${media.blender.version}`
          : `missing or unavailable: ${missing.join(", ")}`,
      });
    } catch (error) {
      checks.push({ name: "media-runtime", status: "warn", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const failed = checks.some((check) => check.status === "fail");
  const report = {
    ok: !failed,
    target: root.href,
    expectedToolCount: REGISTERED_TOOL_COUNT,
    expectedCatalogRevision: TOOL_CATALOG_REVISION,
    serverInstanceId: health?.serverInstanceId,
    processId: health?.processId,
    checks,
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`cokacremote doctor: ${report.ok ? "PASS" : "FAIL"} ${root.href}`);
    for (const check of checks) console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
  }
  if (failed) process.exitCode = 1;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invoked === import.meta.url) await main();

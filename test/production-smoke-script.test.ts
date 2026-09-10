import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

const servers: http.Server[] = [];
const script = path.resolve("scripts/production-smoke.mjs");

type MetadataOverride = Record<string, unknown> | ((host: string) => Record<string, unknown>);

async function listen(
  healthBody: Record<string, unknown>,
  metadataOverride?: MetadataOverride,
): Promise<string> {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/oauth-protected-resource") {
      const host = request.headers.host ?? "127.0.0.1";
      const metadata = typeof metadataOverride === "function"
        ? metadataOverride(host)
        : metadataOverride ?? {
            resource: `http://${host}/mcp`,
            authorization_servers: [`http://${host}/`],
            scopes_supported: ["mcp:tools"],
            bearer_methods_supported: ["header"],
            resource_name: "cokacremote",
          };
      response.end(JSON.stringify(metadata));
      return;
    }
    response.end(JSON.stringify(healthBody));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}/health`;
}

async function runSmoke(endpoints: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      windowsHide: true,
      env: {
        ...process.env,
        COKACREMOTE_SMOKE_ENDPOINTS: endpoints,
        COKACREMOTE_SMOKE_ATTEMPTS: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("production smoke script", () => {
  it("passes matching public-health payloads, OAuth metadata, and parity", async () => {
    const payload = {
      status: "ok",
      service: "cokacremote",
      registeredToolCount: 27,
      toolCatalogRevision: "core-media-2026-09-09.1",
      runtimePolicyFingerprint: "same-policy",
      oauthEnabled: true,
    };
    const first = await listen(payload);
    const second = await listen(payload);
    const result = await runSmoke(`${first},${second}`);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("OAuth metadata valid");
  });

  it("fails stale catalog payloads instead of silently accepting them", async () => {
    const endpoint = await listen({
      status: "ok",
      service: "cokacremote",
      registeredToolCount: 21,
      toolCatalogRevision: "legacy",
      runtimePolicyFingerprint: "old-policy",
      oauthEnabled: true,
    });
    const result = await runSmoke(endpoint);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/tools=21 expected=27/);
    expect(result.stderr).toMatch(/catalog=legacy expected=core-media-2026-09-09\.1/);
  });

  it("fails broken protected-resource metadata even when health is green", async () => {
    const endpoint = await listen(
      {
        status: "ok",
        service: "cokacremote",
        registeredToolCount: 27,
        toolCatalogRevision: "core-media-2026-09-09.1",
        runtimePolicyFingerprint: "same-policy",
        oauthEnabled: true,
      },
      (host) => ({
        resource: `http://${host}/wrong-resource`,
        authorization_servers: [],
        scopes_supported: [],
        bearer_methods_supported: [],
        resource_name: "wrong-name",
      }),
    );
    const result = await runSmoke(endpoint);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/resource=.*wrong-resource.*expected=.*\/mcp/);
    expect(result.stderr).toMatch(/authorization_servers must include/);
    expect(result.stderr).toMatch(/scopes_supported must include mcp:tools/);
    expect(result.stderr).toMatch(/bearer_methods_supported must include header/);
    expect(result.stderr).toMatch(/resource_name=wrong-name expected=cokacremote/);
  });
});

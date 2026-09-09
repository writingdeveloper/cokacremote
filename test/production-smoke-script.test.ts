import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

const servers: http.Server[] = [];
const script = path.resolve("scripts/production-smoke.mjs");

async function listen(body: Record<string, unknown>): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
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
  it("passes matching public-health payloads and parity", async () => {
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
    expect(result.stdout).toContain("Production smoke PASS");
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
});

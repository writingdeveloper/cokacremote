import { describe, expect, it } from "vitest";
import { evaluateHealth } from "../src/doctor.js";

describe("runtime doctor", () => {
  it("passes an exact catalog and recent successful discovery", () => {
    const now = new Date().toISOString();
    const checks = evaluateHealth({
      status: "ok", registeredToolCount: 27, toolCatalogRevision: "core-media-2026-09-09.1",
      mcpRequestCount: 10, lastMcpRequestAt: now,
      catalogDiscovery: { requestCount: 2, successCount: 2, failureCount: 0, lastSuccessAt: now, lastMethod: "tools/list", lastProtocolVersion: "2026-07-28", cacheTtlMs: 300_000 },
      processes: { running: 1, runningCapacity: 15, capacity: 64 },
    });
    expect(checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("warns when MCP calls arrive without catalog discovery", () => {
    const checks = evaluateHealth({
      status: "ok", registeredToolCount: 27, toolCatalogRevision: "core-media-2026-09-09.1",
      mcpRequestCount: 8, lastMcpRequestAt: new Date().toISOString(),
      catalogDiscovery: { requestCount: 0, successCount: 0, failureCount: 0, cacheTtlMs: 300_000 },
      processes: { runningCapacity: 16 },
    });
    const discovery = checks.find((check) => check.name === "catalog-discovery");
    expect(discovery).toMatchObject({ status: "warn" });
    expect(discovery?.detail).toMatch(/cached manifest/i);
  });

  it("fails tool-count or revision drift", () => {
    const checks = evaluateHealth({
      status: "ok", registeredToolCount: 21, toolCatalogRevision: "legacy",
      catalogDiscovery: { requestCount: 0, successCount: 0, failureCount: 0, cacheTtlMs: 300_000 },
      processes: { runningCapacity: 16 },
    });
    expect(checks.find((check) => check.name === "tool-catalog")).toMatchObject({ status: "fail" });
  });
});

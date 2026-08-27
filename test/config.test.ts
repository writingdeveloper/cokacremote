import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const testCwd = path.join(os.tmpdir(), "cokacremote-config-test");

describe("loadConfig", () => {
  it("loads the documented ChatGPT Web runtime profile limits", () => {
    const profilePath = path.resolve("deploy/profiles/chatgpt-web.env.example");
    const env = Object.fromEntries(
      readFileSync(profilePath, "utf8")
        .split(String.fromCharCode(10))
        .map((line) => line.replace(String.fromCharCode(13), "").trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    const config = loadConfig({ MCP_AUTH_TOKEN: "secret", ...env }, testCwd);

    expect(config).toMatchObject({
      maxOutputBytes: 131072,
      maxRetainedProcessOutputBytes: 1048576,
      processRetentionMs: 900000,
      maxProcesses: 32,
      maxFileChunkBytes: 262144,
    });
  });
  it("requires authentication unless explicitly disabled", () => {
    expect(() => loadConfig({}, testCwd)).toThrow("MCP_AUTH_TOKEN is required");
    expect(loadConfig({ MCP_ALLOW_NO_AUTH: "true" }, testCwd).allowNoAuth).toBe(true);
  });

  it("binds to loopback by default to avoid direct network exposure", () => {
    expect(loadConfig({ MCP_AUTH_TOKEN: "secret" }, testCwd).host).toBe("127.0.0.1");
  });

  it("loads full-access host settings", () => {
    const defaultCwd = path.join(testCwd, "workspace");
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "secret",
        MCP_PORT: "4321",
        MCP_DEFAULT_CWD: defaultCwd,
        MCP_ALLOWED_HOSTS: "mcp.example.com,localhost",
      },
      testCwd,
    );

    expect(config).toMatchObject({
      port: 4321,
      defaultCwd: path.resolve(defaultCwd),
      trustProxyHops: 0,
      authToken: "secret",
      allowedHosts: ["mcp.example.com", "localhost"],
    });
  });

  it("rejects partial integers and ports outside the valid range", () => {
    for (const value of ["3000oops", "3000.9", "70000"]) {
      expect(() =>
        loadConfig({ MCP_AUTH_TOKEN: "secret", MCP_PORT: value }, testCwd),
      ).toThrow("MCP_PORT must be an integer between 1 and 65535");
    }
    expect(
      loadConfig({ MCP_AUTH_TOKEN: "secret", MCP_PORT: " 4321 " }, testCwd).port,
    ).toBe(4321);
  });

  it("requires public HTTPS metadata when OAuth is enabled", () => {
    expect(() =>
      loadConfig({ MCP_AUTH_TOKEN: "secret", MCP_OAUTH_ENABLED: "true" }, testCwd),
    ).toThrow("MCP_OAUTH_ISSUER is required");

    const stateFile = path.join(testCwd, "oauth-state.json");
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "secret",
        MCP_OAUTH_ENABLED: "true",
        MCP_PUBLIC_URL: "https://mcp.example.com",
        MCP_OAUTH_STATE_FILE: stateFile,
      },
      testCwd,
    );
    expect(config).toMatchObject({
      oauthEnabled: true,
      oauthApprovalKey: "secret",
      oauthIssuerUrl: "https://mcp.example.com/",
      oauthResourceUrl: "https://mcp.example.com/mcp",
      oauthStateFile: path.resolve(stateFile),
    });
  });

  it("supports OAuth-only authentication with a separate approval key", () => {
    const config = loadConfig(
      {
        MCP_OAUTH_ENABLED: "true",
        MCP_OAUTH_APPROVAL_KEY: "separate-oauth-approval-key",
        MCP_PUBLIC_URL: "https://mcp.example.com",
        MCP_TRUST_PROXY_HOPS: "1",
      },
      testCwd,
    );

    expect(config).toMatchObject({
      authToken: undefined,
      oauthApprovalKey: "separate-oauth-approval-key",
      trustProxyHops: 1,
    });
    expect(() =>
      loadConfig(
        {
          MCP_OAUTH_ENABLED: "true",
          MCP_PUBLIC_URL: "https://mcp.example.com",
        },
        testCwd,
      ),
    ).toThrow("MCP_OAUTH_APPROVAL_KEY");
  });

  it("rejects unsafe proxy trust and OAuth URL settings", () => {
    expect(() =>
      loadConfig({ MCP_AUTH_TOKEN: "secret", MCP_TRUST_PROXY_HOPS: "17" }, testCwd),
    ).toThrow("MCP_TRUST_PROXY_HOPS must be an integer between 0 and 16");
    expect(() =>
      loadConfig(
        {
          MCP_AUTH_TOKEN: "secret",
          MCP_OAUTH_ENABLED: "true",
          MCP_OAUTH_ISSUER: "https://user:password@mcp.example.com",
          MCP_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
        },
        testCwd,
      ),
    ).toThrow("must not contain user credentials");
  });
});

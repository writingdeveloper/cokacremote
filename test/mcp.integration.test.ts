import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices, type McpServices } from "../src/mcp-server.js";
import { testBash } from "./helpers/cross-platform-command.js";

interface JsonRpcResponse {
  result?: {
    tools?: Array<{ name: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

describe("remote development MCP server", () => {
  let temporaryDirectory: string;
  let config: AppConfig;
  let services: McpServices;
  let running: RunningHttpServer;
  let endpoint: URL;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "remote-dev-mcp-http-test-"));
    config = loadConfig(
      {
        MCP_AUTH_TOKEN: "integration-secret",
        MCP_HOST: "127.0.0.1",
        MCP_DEFAULT_CWD: temporaryDirectory,
        MCP_MAX_FILE_CHUNK_BYTES: "65536",
        MCP_DEFAULT_SHELL: testBash(),
      },
      temporaryDirectory,
    );
    config.port = 0;
    services = createServices(config);
    running = await startHttpServer(config, services);
    const address = running.httpServer.address() as AddressInfo;
    endpoint = new URL(`http://127.0.0.1:${address.port}${config.endpoint}`);
  });

  afterAll(async () => {
    await running.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("rejects unauthenticated MCP initialization", async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });

    expect(response.status).toBe(401);
  });

  it("authenticates MCP requests before parsing their JSON body", async () => {
    const unauthenticated = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer integration-secret",
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(authenticated.status).toBe(400);
  });

  it("serves MCP 2026-07-28 discovery to authenticated clients", async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer integration-secret",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "modern-integration-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result?: {
        supportedVersions?: string[];
        capabilities?: Record<string, unknown>;
        ttlMs?: number;
        cacheScope?: string;
      };
    };
    expect(payload.result?.supportedVersions).toContain("2026-07-28");
    expect(payload.result?.capabilities).toHaveProperty("tools");
    expect(payload.result?.capabilities).not.toHaveProperty("tasks");
    expect(payload.result?.ttlMs).toBe(300_000);
    expect(payload.result?.cacheScope).toBe("private");
  });

  it("emits private five-minute cache hints on modern tools/list without legacy task metadata", async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer integration-secret",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "modern-tools-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result?: {
        tools?: Array<{ name: string; execution?: { taskSupport?: string } }>;
        ttlMs?: number;
        cacheScope?: string;
      };
    };
    expect(payload.result?.tools?.length).toBeGreaterThan(0);
    expect(payload.result?.tools?.every((tool) => tool.execution?.taskSupport === undefined)).toBe(true);
    expect(payload.result?.ttlMs).toBe(300_000);
    expect(payload.result?.cacheScope).toBe("private");
  });

  it("lists tools and executes script and file workflows", async () => {
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: { Authorization: "Bearer integration-secret" },
      },
    });
    await client.connect(transport);
    try {
      expect(transport.sessionId).toBeUndefined();
      expect(client.getServerVersion()).toMatchObject({
        name: "cokacremote",
        version: "0.1.0",
      });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "exec_command",
          "run_script",
          "write_stdin",
          "read_file",
          "write_file",
          "apply_patch",
          "upload_file",
          "download_file",
        ]),
      );

      const scriptResult = await client.callTool({
        name: "run_script",
        arguments: {
          runtime: "node",
          script: "console.log(6 * 7)",
          yieldTimeMs: 2000,
        },
      });
      expect(scriptResult.isError).not.toBe(true);
      expect(scriptResult.structuredContent).toMatchObject({
        completed: true,
        exitCode: 0,
        output: "42\n",
      });

      const writeResult = await client.callTool({
        name: "write_file",
        arguments: { path: "hello.txt", content: "hello MCP\n" },
      });
      expect(writeResult.isError).not.toBe(true);

      const readResult = await client.callTool({
        name: "read_file",
        arguments: { path: "hello.txt" },
      });
      expect(readResult.structuredContent).toMatchObject({
        content: "hello MCP\n",
        eof: true,
      });
    } finally {
      await transport.terminateSession();
      await client.close();
    }
  });

  it("rejects excess concurrent MCP requests with 429 while existing work remains alive", async () => {
    const busyDirectory = await mkdtemp(path.join(os.tmpdir(), "remote-dev-mcp-busy-test-"));
    const busyConfig = loadConfig(
      {
        MCP_AUTH_TOKEN: "busy-secret",
        MCP_HOST: "127.0.0.1",
        MCP_DEFAULT_CWD: busyDirectory,
        MCP_DEFAULT_SHELL: testBash(),
        MCP_MAX_CONCURRENT_TOOL_CALLS: "1",
        MCP_MAX_QUEUED_REQUESTS: "0",
      },
      busyDirectory,
    );
    busyConfig.port = 0;
    const busyRunning = await startHttpServer(busyConfig, createServices(busyConfig));
    const busyAddress = busyRunning.httpServer.address() as AddressInfo;
    const busyEndpoint = new URL(`http://127.0.0.1:${busyAddress.port}${busyConfig.endpoint}`);
    const postBusy = (body: unknown) =>
      fetch(busyEndpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer busy-secret",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    try {
      const first = postBusy({
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {
          name: "exec_command",
          arguments: {
            cmd: "node -e \"setTimeout(() => console.log('first-alive'), 1200)\"",
            yieldTimeMs: 2000,
          },
        },
      });

      let observedActive = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const health = (await (await fetch(new URL("/health", busyEndpoint))).json()) as {
          concurrency?: { active?: number };
        };
        if (health.concurrency?.active === 1) {
          observedActive = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedActive).toBe(true);

      const rejected = await postBusy({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/list",
        params: {},
      });
      expect(rejected.status).toBe(429);
      const rejectedPayload = (await rejected.json()) as { error?: { message?: string } };
      expect(rejectedPayload.error?.message).toMatch(/busy/i);

      const firstResponse = await first;
      expect(firstResponse.status).toBe(200);
      const firstPayload = (await firstResponse.json()) as JsonRpcResponse;
      const firstSessionId = firstPayload.result?.structuredContent?.sessionId;
      expect(firstSessionId).toEqual(expect.any(String));
      const completion = await postBusy({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: {
          name: "read_process",
          arguments: { sessionId: firstSessionId, waitMs: 5000 },
        },
      });
      expect(completion.status).toBe(200);
      const completionPayload = (await completion.json()) as JsonRpcResponse;
      expect(completionPayload.result?.structuredContent?.output).toContain("first-alive");
    } finally {
      await busyRunning.close();
      await rm(busyDirectory, { recursive: true, force: true });
    }
  });

  it("handles every tool call as an independent stateless request", async () => {
    const post = async (
      body: unknown,
      additionalHeaders: Record<string, string> = {},
    ): Promise<Response> =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer integration-secret",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...additionalHeaders,
        },
        body: JSON.stringify(body),
      });

    const initializeResponse = await post({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stateless-test", version: "1" },
      },
    });
    expect(initializeResponse.status).toBe(200);
    expect(initializeResponse.headers.get("content-type")).toContain("application/json");
    expect(initializeResponse.headers.get("mcp-session-id")).toBeNull();
    expect(initializeResponse.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const listResponse = await post(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/list",
        params: {},
      },
      { "mcp-session-id": "stale-session-from-the-previous-deployment" },
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as JsonRpcResponse;
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain("exec_command");

    const startResponse = await post({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "exec_command",
        arguments: {
          cmd: "node -e \"setTimeout(() => console.log('stateless-ok'), 100)\"",
          yieldTimeMs: 0,
        },
      },
    });
    expect(startResponse.status).toBe(200);
    const started = (await startResponse.json()) as JsonRpcResponse;
    const sessionId = started.result?.structuredContent?.sessionId;
    expect(sessionId).toEqual(expect.any(String));
    expect(started.result?.structuredContent).toMatchObject({
      running: true,
      completed: false,
    });

    const readResponse = await post({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "read_process",
        arguments: { sessionId, waitMs: 3000 },
      },
    });
    expect(readResponse.status).toBe(200);
    const read = (await readResponse.json()) as JsonRpcResponse;
    expect(read.result?.structuredContent?.output).toContain("stateless-ok");
    const nextSeq = read.result?.structuredContent?.nextSeq;
    expect(nextSeq).toEqual(expect.any(Number));

    const completionResponse = await post({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "read_process",
        arguments: { sessionId, afterSeq: nextSeq, waitMs: 3000 },
      },
    });
    expect(completionResponse.status).toBe(200);
    const completion = (await completionResponse.json()) as JsonRpcResponse;
    expect(completion.result?.structuredContent).toMatchObject({
      running: false,
      completed: true,
      exitCode: 0,
    });

    const getResponse = await fetch(endpoint, {
      headers: {
        authorization: "Bearer integration-secret",
        accept: "text/event-stream",
      },
    });
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");

    const healthResponse = await fetch(new URL("/health", endpoint));
    expect(await healthResponse.json()).toMatchObject({
      status: "ok",
      transportMode: "stateless-json",
      activeMcpSessions: 0,
      activeMcpRequests: 0,
      managedProcesses: expect.any(Number),
      processes: {
        running: expect.any(Number),
        completedRetained: expect.any(Number),
        capacity: expect.any(Number),
        retainedOutputBytes: expect.any(Number),
        droppedOutputBytes: expect.any(Number),
      },
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { CimdClientResolver } from "../src/cimd.js";

describe("CimdClientResolver", () => {
  it("rejects metadata hosts that resolve to private or special-use addresses before HTTP", async () => {
    const fetchDocument = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: "{}",
    }));
    const resolver = new CimdClientResolver({
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchDocument,
    });

    await expect(
      resolver.resolve("https://client.example/oauth/client.json"),
    ).rejects.toThrow(/public address/i);
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("requires HTTPS with a non-root path and refuses redirects", async () => {
    const resolver = new CimdClientResolver({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetchDocument: async () => ({
        statusCode: 302,
        contentType: "application/json",
        body: "{}",
      }),
    });

    await expect(resolver.resolve("http://client.example/oauth/client.json")).rejects.toThrow(
      /HTTPS/i,
    );
    await expect(resolver.resolve("https://client.example/")).rejects.toThrow(/path/i);
    await expect(
      resolver.resolve("https://client.example/oauth/client.json"),
    ).rejects.toThrow(/HTTP 200/i);
  });

  it("accepts one bounded JSON document from a pinned public address", async () => {
    const fetchDocument = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        client_id: "https://client.example/oauth/client.json",
        client_name: "Example MCP client",
        redirect_uris: ["https://chatgpt.com/connector/oauth/test-callback"],
      }),
    }));
    const resolver = new CimdClientResolver({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetchDocument,
    });

    await expect(
      resolver.resolve("https://client.example/oauth/client.json"),
    ).resolves.toMatchObject({
      client_id: "https://client.example/oauth/client.json",
      client_name: "Example MCP client",
    });
    expect(fetchDocument).toHaveBeenCalledWith(
      new URL("https://client.example/oauth/client.json"),
      { address: "8.8.8.8", family: 4 },
    );
  });

  it("rejects non-JSON and oversized metadata bodies", async () => {
    const lookup = async () => [{ address: "8.8.8.8", family: 4 as const }];
    const nonJson = new CimdClientResolver({
      lookup,
      fetchDocument: async () => ({
        statusCode: 200,
        contentType: "text/html",
        body: "{}",
      }),
    });
    await expect(
      nonJson.resolve("https://client.example/oauth/client.json"),
    ).rejects.toThrow(/JSON content type/i);

    const oversized = new CimdClientResolver({
      lookup,
      fetchDocument: async () => ({
        statusCode: 200,
        contentType: "application/json",
        body: `{"value":"${"x".repeat(70_000)}"}`,
      }),
    });
    await expect(
      oversized.resolve("https://client.example/oauth/client.json"),
    ).rejects.toThrow(/too large/i);
  });
});

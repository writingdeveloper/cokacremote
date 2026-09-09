import { performance } from "node:perf_hooks";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import {
  createMcpServer,
  createServices,
  REGISTERED_TOOL_COUNT,
  TOOL_CATALOG_REVISION,
} from "../src/mcp-server.js";

const iterations = Math.max(1, Math.min(100, Number(process.env.MCP_PROFILE_ITERATIONS || "20")));
const cwd = process.cwd();
const config = loadConfig({ MCP_ALLOW_NO_AUTH: "true", MCP_DEFAULT_CWD: cwd }, cwd);
const services = createServices(config);
const server = createMcpServer(config, services);
const client = new Client({ name: "cokacremote-tool-profiler", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

async function benchmark(name: string, args: Record<string, unknown>, count = iterations) {
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name} returned an error during profiling`);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const at = (fraction: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))] ?? 0;
  return {
    name,
    count,
    p50Ms: Number(at(0.5).toFixed(2)),
    p95Ms: Number(at(0.95).toFixed(2)),
    maxMs: Number((samples.at(-1) ?? 0).toFixed(2)),
  };
}

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  const catalogBytes = Buffer.byteLength(JSON.stringify(tools));
  const largestTools = tools
    .map((tool) => ({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool)) }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 10);
  const latency = [
    await benchmark("stat_path", { path: "package.json" }),
    await benchmark("list_directory", { path: "src", maxEntries: 200, includeMetadata: false }),
    await benchmark("media_capabilities", {}, Math.min(5, iterations)),
  ];
  console.log(JSON.stringify({
    revision: TOOL_CATALOG_REVISION,
    expectedToolCount: REGISTERED_TOOL_COUNT,
    actualToolCount: tools.length,
    catalogBytes,
    catalogKiB: Number((catalogBytes / 1024).toFixed(1)),
    catalogBudgetKiB: 128,
    largestTools,
    latency,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await services.processManager.shutdown().catch(() => undefined);
}

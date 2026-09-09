import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {afterEach,describe,expect,it} from 'vitest';
import {loadConfig} from '../src/config.js';
import {createMcpServer,createServices,REGISTERED_TOOL_COUNT,TOOL_CATALOG_REVISION} from '../src/mcp-server.js';

describe('tool catalog browser budget',()=>{
  let client:Client|undefined;let server:ReturnType<typeof createMcpServer>|undefined;let services:ReturnType<typeof createServices>|undefined;
  afterEach(async()=>{await client?.close();await server?.close();await services?.processManager.shutdown();});
  it('is deterministic and stays below a bounded registry payload',async()=>{
    const config=loadConfig({MCP_ALLOW_NO_AUTH:'true'},process.cwd());services=createServices(config);server=createMcpServer(config,services);client=new Client({name:'catalog-budget',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
    const first=(await client.listTools()).tools;const second=(await client.listTools()).tools;
    expect(first).toEqual(second);expect(first).toHaveLength(REGISTERED_TOOL_COUNT);expect(TOOL_CATALOG_REVISION).toMatch(/^core-media-/);
    const bytes=Buffer.byteLength(JSON.stringify(first));
    expect(bytes).toBeLessThanOrEqual(128*1024);
  });
});

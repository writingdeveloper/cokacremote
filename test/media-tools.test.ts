import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import type {CallToolResult} from '@modelcontextprotocol/server';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createMcpServer,createServices,type McpServices} from '../src/mcp-server.js';
import {loadConfig} from '../src/config.js';

let dir:string;let client:Client;let services:McpServices;let server:ReturnType<typeof createMcpServer>;
type MediaToolResult = CallToolResult & { structuredContent?: Record<string, unknown> };
async function call(name:string,args:Record<string,unknown>={}):Promise<MediaToolResult>{return await client.callTool({name,arguments:args}) as MediaToolResult;}
async function completed(jobId:string){
  let response=await call('media_job',{jobId});
  for(let i=0;i<200&&['queued','running'].includes(String(response.structuredContent?.state));i++){
    await new Promise(r=>setTimeout(r,100));response=await call('media_job',{jobId});
  }
  return response;
}
beforeAll(async()=>{
  dir=await mkdtemp(path.join(os.tmpdir(),'media-tools-test-'));
  const ff=process.env.MCP_MEDIA_FFMPEG||'ffmpeg';
  execFileSync(ff,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=160x96:d=4:r=10','-c:v','mpeg4',path.join(dir,'clip.mp4')],{windowsHide:true,timeout:15000});
  execFileSync(ff,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=2','-ar','16000',path.join(dir,'tone.wav')],{windowsHide:true,timeout:15000});
  const config=loadConfig({MCP_ALLOW_NO_AUTH:'true',MCP_DEFAULT_CWD:dir},dir);
  services=createServices(config);server=createMcpServer(config,services);
  client=new Client({name:'media-native-integration-test',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
});
afterAll(async()=>{await client?.close();await server?.close();await services?.processManager.shutdown();await rm(dir,{recursive:true,force:true});});
it('registers all four production tools with accurate side-effect annotations',async()=>{
  const tools=(await client.listTools()).tools;
  for(const name of ['media_capabilities','media_submit','media_job','media_cancel'])expect(tools.some(t=>t.name===name)).toBe(true);
  expect(tools.find(t=>t.name==='media_submit')?.annotations).toMatchObject({readOnlyHint:false,destructiveHint:false});
  expect(tools.find(t=>t.name==='media_job')?.annotations).toMatchObject({readOnlyHint:true});
});
it('returns real native image and audio blocks without duplicating them in text or metadata',async()=>{
  const submitted=await call('media_submit',{action:'audio_review',path:'tone.wav',durationSeconds:2});
  expect(submitted.isError).not.toBe(true);
  const jobId=String(submitted.structuredContent?.jobId);
  const done=await completed(jobId);expect(done.structuredContent?.state).toBe('completed');
  const preview=await call('media_job',{jobId,includePreview:true,includeAudio:true});
  expect(preview.isError).not.toBe(true);expect(preview.content.map(c=>c.type)).toEqual(['text','image','audio']);
  const text=JSON.stringify(preview.structuredContent)+preview.content.filter(c=>c.type==='text').map(c=>c.text).join('');
  for(const block of preview.content)if(block.type==='image'||block.type==='audio')expect(text).not.toContain(block.data);
  expect(text).toContain('NOT_LISTENED');
},40000);
it('cancels only the requested media job and releases its worker',async()=>{
  const submitted=await call('media_submit',{action:'video_review',path:'clip.mp4',frames:16,durationSeconds:4});
  expect(submitted.isError).not.toBe(true);const jobId=String(submitted.structuredContent?.jobId);
  expect((await call('media_cancel',{jobId})).isError).not.toBe(true);
  const done=await completed(jobId);expect(done.structuredContent?.state).toBe('cancelled');
  expect(await readFile(path.join(dir,'clip.mp4'))).toBeInstanceOf(Buffer);
},40000);
it('fails closed for unknown jobs and bad arguments',async()=>{
  const bad=await call('media_submit',{action:'video_review',path:'clip.mp4',frames:200});expect(bad.isError).toBe(true);
  const unknown=await call('media_job',{jobId:'11111111-1111-4111-8111-111111111111'});expect(unknown.isError).toBe(true);
});

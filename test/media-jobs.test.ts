import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {MediaJobs} from '../src/media/jobs.js';
import {ProcessManager} from '../src/process-manager.js';
let dir:string;
let manager:ProcessManager;
let jobs:MediaJobs;
beforeAll(async()=>{
  dir=await mkdtemp(path.join(os.tmpdir(),'media-jobs-test-'));
  execFileSync(process.env.MCP_MEDIA_FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=blue:s=160x96:d=0.1','-frames:v','1',path.join(dir,'source.png')],{windowsHide:true,timeout:15000});
  manager=new ProcessManager({maxProcesses:16,maxRetainedOutputBytes:65536,processRetentionMs:60000,defaultMaxOutputBytes:65536});
  jobs=new MediaJobs({root:path.join(dir,'jobs'),defaultCwd:dir,processManager:manager,maxConcurrent:1});
});
afterAll(async()=>{await manager?.shutdown();await rm(dir,{recursive:true,force:true});});
it('persists asynchronous results, bounds concurrent work and survives client service recreation',async()=>{
  const first=await jobs.submit({action:'image_review',path:'source.png'});
  await expect(jobs.submit({action:'image_review',path:'source.png'})).rejects.toThrow(/busy/i);
  let state=await jobs.get(first.jobId);
  for(let i=0;i<100&&['queued','running'].includes(state.state);i++){
    await new Promise(r=>setTimeout(r,100)); state=await jobs.get(first.jobId);
  }
  expect(state.state).toBe('completed');
  expect(state.report?.acceptance).toBe('NOT_REVIEWED');
  expect(state.report?.artifacts.some(a=>a.name==='preview.jpg')).toBe(true);
  expect(state.report?.artifacts.map(a=>a.name)).not.toContain('job.json');
  expect(state.report?.artifacts.map(a=>a.name)).not.toContain('asset-request.json');
  const fresh=new MediaJobs({root:path.join(dir,'jobs'),defaultCwd:dir,processManager:manager,maxConcurrent:1});
  expect((await fresh.get(first.jobId)).state).toBe('completed');
  expect((await readFile(path.join(state.directory,'index.html'),'utf8'))).toContain('NOT_REVIEWED');
},30000);
it('rejects traversal job identifiers',async()=>{
  await expect(jobs.get('../source.png')).rejects.toThrow(/job/i);
});
it('marks decoding failures as failed, never approved',async()=>{
  await writeFile(path.join(dir,'broken.png'),'this is not a valid image');
  const submitted=await jobs.submit({action:'image_review',path:'broken.png'});
  let state=await jobs.get(submitted.jobId);
  for(let i=0;i<100&&['queued','running'].includes(state.state);i++){
    await new Promise(r=>setTimeout(r,100)); state=await jobs.get(submitted.jobId);
  }
  expect(state.state).toBe('failed');expect(state.error).toBeTruthy();expect(state.report).toBeUndefined();
},30000);

it('rechecks terminal status before declaring a vanished worker interrupted',async()=>{
  const jobId=randomUUID();const jobDir=path.join(dir,'jobs',jobId);await mkdir(jobDir,{recursive:true});
  await writeFile(path.join(jobDir,'job.json'),JSON.stringify({jobId,createdAt:new Date().toISOString()}));
  await writeFile(path.join(jobDir,'status.json'),JSON.stringify({state:'running',workerPid:2147483000,updatedAt:new Date().toISOString()}));
  setTimeout(()=>void writeFile(path.join(jobDir,'status.json'),JSON.stringify({state:'failed',workerPid:2147483000,updatedAt:new Date().toISOString(),error:'expected synthetic failure'})),10);
  const state=await jobs.get(jobId);
  expect(state.state).toBe('failed');expect(state.error).toContain('synthetic failure');
},5000);

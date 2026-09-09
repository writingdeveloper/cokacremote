import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ProcessManager} from '../process-manager.js';
import {localInput,MediaRequestSchema,type ReviewReport} from './engine.js';

export interface JobStatus {
  state:'queued'|'running'|'completed'|'failed'|'cancelled'|'interrupted';
  updatedAt:string; workerPid?:number; error?:string;
}
export interface JobView extends JobStatus {
  jobId:string; directory:string; processSessionId?:string; report?:ReviewReport;
  sourceMetadataStillMatches?:boolean;
}
interface JobRecord {jobId:string;createdAt:string;processSessionId?:string}
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
export async function readJsonBounded<T>(file:string,maxBytes=2*1024*1024):Promise<T>{
  const info=await stat(file);if(!info.isFile()||info.size>maxBytes)throw new Error('Job document exceeds size budget.');
  return JSON.parse(await readFile(file,'utf8')) as T;
}
export class MediaJobs {
  readonly root:string;
  private tail:Promise<unknown>=Promise.resolve();
  constructor(private readonly options:{root:string;defaultCwd:string;processManager:ProcessManager;maxConcurrent?:number;maxJobs?:number;workerPath?:string}){
    this.root=path.resolve(options.root);
  }
  private async directory(jobId:string){
    if(!UUID.test(jobId))throw new Error('Invalid media job identifier.');
    const base=await realpath(this.root);const dir=await realpath(path.join(base,jobId));
    if(path.dirname(dir)!==base)throw new Error('Job directory escapes its root.');
    return dir;
  }
  submit(input:unknown):Promise<{jobId:string;state:'queued';directory:string;processSessionId:string}>{
    const operation=this.tail.then(()=>this.start(input));this.tail=operation.catch(()=>undefined);return operation;
  }
  private async start(input:unknown){
    const request=MediaRequestSchema.parse(input);
    const cwd=path.resolve(this.options.defaultCwd,request.cwd||'.');
    request.path=await localInput(request.path,cwd);request.cwd=cwd;
    if(request.reference)request.reference=await localInput(request.reference,cwd);
    await mkdir(this.root,{recursive:true});
    const entries=(await readdir(this.root)).filter(n=>UUID.test(n));
    if(entries.length>=(this.options.maxJobs??64))throw new Error('Media job history capacity reached (64 by default). Archive completed job directories before submitting more work.');
    let active=0;
    for(const id of entries){const job=await this.get(id);if(job.state==='queued'||job.state==='running')active++;}
    if(active>=(this.options.maxConcurrent??2))throw new Error('Media workers busy; poll an existing job before submitting more. No existing work was stopped.');
    const compiled=fileURLToPath(new URL('./worker.js',import.meta.url));
    const source=fileURLToPath(new URL('./worker.ts',import.meta.url));
    const configured=this.options.workerPath;
    const worker=configured||(existsSync(compiled)?compiled:(existsSync(source)?source:path.resolve('dist/src/media/worker.js')));
    if(!existsSync(worker))throw new Error('Media worker entry was not found.');
    const workerArgs=worker.endsWith('.ts')?['--import',import.meta.resolve('tsx'),worker]:[worker];
    const jobId=randomUUID();const directory=path.join(this.root,jobId);
    await mkdir(directory,{recursive:false});
    await writeFile(path.join(directory,'request.json'),JSON.stringify(request),{flag:'wx',mode:0o600});
    const record:JobRecord={jobId,createdAt:new Date().toISOString()};
    await writeFile(path.join(directory,'job.json'),JSON.stringify(record),{flag:'wx',mode:0o600});
    await writeFile(path.join(directory,'status.json'),JSON.stringify({state:'queued',updatedAt:record.createdAt}),{flag:'wx',mode:0o600});
    try{
      // Use the existing managed process pool, plus the independent lower
      // media ceiling. The worker owns its deadline and cooperative cancel.
      const processSessionId=this.options.processManager.start({executable:process.execPath,args:[...workerArgs,path.join(directory,'request.json')],commandForDisplay:`media ${request.action} job=${jobId}`,cwd:directory,timeoutMs:0});
      record.processSessionId=processSessionId;
      await writeFile(path.join(directory,'job.json'),JSON.stringify(record),{mode:0o600});
      return {jobId,state:'queued' as const,directory,processSessionId};
    }catch(error){
      await writeFile(path.join(directory,'status.json'),JSON.stringify({state:'failed',updatedAt:new Date().toISOString(),error:String(error).slice(0,2000)}));
      throw error;
    }
  }
  async get(jobId:string):Promise<JobView>{
    const directory=await this.directory(jobId);
    const record=await readJsonBounded<JobRecord>(path.join(directory,'job.json'),16000);
    let state=await readJsonBounded<JobStatus>(path.join(directory,'status.json'),16000);
    const active=()=>state.state==='running'||state.state==='queued';
    let interruption:string|undefined;
    if(active()){
      if(Date.now()-Date.parse(record.createdAt)>660000){
        interruption='Worker exceeded its bounded lifetime. Inspect this job before retrying; no automatic duplicate was started.';
      }else if(state.workerPid){
        try{process.kill(state.workerPid,0);}catch(error){
          if((error as NodeJS.ErrnoException).code==='ESRCH')interruption='Media worker exited without final status. Partial artifacts are not approved.';
        }
      }else if(record.processSessionId){
        try{
          const managed=await this.options.processManager.read(record.processSessionId,{waitMs:0,maxOutputBytes:16384,outputMode:'metadata'});
          if(!managed.running)interruption='Media worker did not start or exited without final status.';
        }catch{
          if(Date.now()-Date.parse(record.createdAt)>30000)interruption='Queued job no longer has a known process session.';
        }
      }
    }
    if(interruption&&active()){
      // The worker atomically renames status.json before exiting, but another
      // process can observe the old running file immediately before that rename
      // and the dead PID immediately after it. Re-read briefly before declaring
      // an interrupted job so ordinary failures/completions are not misclassified.
      for(const delay of [0,25,50,100,200]){
        if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
        const latest=await readJsonBounded<JobStatus>(path.join(directory,'status.json'),16000);
        state=latest;
        if(!active())break;
      }
      if(active())state={...state,state:'interrupted',error:interruption,updatedAt:new Date().toISOString()};
    }
    const view:JobView={...state,jobId,directory,processSessionId:record.processSessionId};
    if(state.state==='completed'){
      view.report=await readJsonBounded<ReviewReport>(path.join(directory,'report.json'));
      try{const current=await stat(view.report.source.path);view.sourceMetadataStillMatches=current.size===view.report.source.bytes&&current.mtimeMs===view.report.source.mtimeMs;}catch{view.sourceMetadataStillMatches=false;}
    }
    return view;
  }
  async cancel(jobId:string){
    const job=await this.get(jobId);
    if(!['queued','running'].includes(job.state))return {jobId,state:job.state,cancellationRequested:false};
    await writeFile(path.join(job.directory,'cancel.requested'),new Date().toISOString(),{mode:0o600});
    return {jobId,state:job.state,cancellationRequested:true,note:'Cancellation requested. Poll media_job for the terminal state; partial outputs are not approval.'};
  }
}

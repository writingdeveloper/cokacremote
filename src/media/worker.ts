import {existsSync} from 'node:fs';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {executeReview,MediaRequestSchema,withMediaAbortSignal} from './engine.js';
import type {JobStatus} from './jobs.js';

const requestPath=process.argv[2];
if(!requestPath)throw new Error('Expected an absolute media request JSON path.');
const directory=path.dirname(path.resolve(requestPath));
const controller=new AbortController();
let reason='cancelled';
async function status(state:JobStatus['state'],error?:string){
  const destination=path.join(directory,'status.json');
  const temp=destination+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify({state,workerPid:process.pid,updatedAt:new Date().toISOString(),...(error?{error}: {})}),{flag:'wx',mode:0o600});
  await rename(temp,destination);
}
const deadline=setTimeout(()=>{reason='Media job timeout (600 seconds)';controller.abort();},600000);
const cancelPoll=setInterval(()=>{if(existsSync(path.join(directory,'cancel.requested')))controller.abort();},300);
try{
  await status('running');
  if(existsSync(path.join(directory,'cancel.requested')))controller.abort();
  const request=MediaRequestSchema.parse(JSON.parse(await readFile(requestPath,'utf8')));
  await withMediaAbortSignal(controller.signal,()=>executeReview(request,directory));
  controller.signal.throwIfAborted();
  await status('completed');
  process.stdout.write(JSON.stringify({state:'completed',directory,report:path.join(directory,'report.json'),acceptance:'NOT_REVIEWED'})+'\n');
}catch(error){
  const cancelled=controller.signal.aborted;
  const message=cancelled?reason:String(error).slice(0,2200);
  await status(cancelled&&reason==='cancelled'?'cancelled':'failed',message);
  process.stderr.write(JSON.stringify({state:cancelled&&reason==='cancelled'?'cancelled':'failed',error:message})+'\n');
  process.exitCode=1;
}finally{
  clearTimeout(deadline);clearInterval(cancelPoll);
}

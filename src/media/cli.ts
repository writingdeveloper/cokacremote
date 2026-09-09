import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {MediaJobs} from './jobs.js';
import {mediaCapabilities} from './engine.js';
import {ProcessManager} from '../process-manager.js';

// Compatibility route for clients whose cached registry does not expose the
// new tools yet. Run through exec_command and poll its managed process normally.
const [command,value]=process.argv.slice(2);
const manager=new ProcessManager({maxProcesses:4,maxRetainedOutputBytes:32768,processRetentionMs:60000,defaultMaxOutputBytes:32768});
const cwd=process.env.MCP_DEFAULT_CWD||process.cwd();
const jobs=new MediaJobs({root:process.env.MCP_MEDIA_ROOT||path.join(cwd,'.cokacremote-media'),defaultCwd:cwd,processManager:manager});
try{
  if(command==='capabilities')console.log(JSON.stringify(await mediaCapabilities(),null,2));
  else if(command==='status'&&value)console.log(JSON.stringify(await jobs.get(value),null,2));
  else if(command==='cancel'&&value)console.log(JSON.stringify(await jobs.cancel(value),null,2));
  else if(command==='run'&&value){
    const request=JSON.parse(await readFile(path.resolve(value),'utf8'));
    const job=await jobs.submit(request);console.log(JSON.stringify(job));
    await manager.waitForExit(job.processSessionId,660000);
    const result=await jobs.get(job.jobId);
    console.log(JSON.stringify({jobId:job.jobId,state:result.state,report:path.join(job.directory,'report.json'),reviewPage:path.join(job.directory,'index.html'),error:result.error,acceptance:'NOT_REVIEWED'}));
    if(result.state!=='completed')process.exitCode=1;
  }else throw new Error('Usage: node dist/src/media/cli.js capabilities | run request.json | status JOB_ID | cancel JOB_ID');
}catch(error){console.error(String(error));process.exitCode=1;}

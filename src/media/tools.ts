import type {McpServer} from '@modelcontextprotocol/server';
import type {CallToolResult} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import type {AppConfig} from '../config.js';
import type {ProcessManager} from '../process-manager.js';
import {readNativeImage} from '../image-tools.js';
import {TOOL_ANNOTATIONS,toolAuthMetadata} from '../tool-metadata.js';
import {successResult,errorResult,runTool} from '../tool-result.js';
import {MediaRequestSchema,mediaCapabilities,type ReviewReport} from './engine.js';
import {MediaJobs} from './jobs.js';

const instances=new WeakMap<ProcessManager,MediaJobs>();
export function mediaJobService(config:AppConfig,manager:ProcessManager):MediaJobs{
  let service=instances.get(manager);
  if(!service){
    service=new MediaJobs({root:config.mediaRoot,defaultCwd:config.defaultCwd,processManager:manager,maxConcurrent:config.mediaMaxConcurrent,maxJobs:config.mediaMaxJobs});
    instances.set(manager,service);
  }
  return service;
}
function compact(report:ReviewReport|undefined){
  if(!report)return undefined;
  const summary={...report,artifacts:report.artifacts.slice(0,64),...(report.asset?{asset:{...report.asset,meshes:report.asset.meshes.slice(0,20),meshDetailsTruncated:report.asset.meshes.length>20}}:{})};
  if(Buffer.byteLength(JSON.stringify(summary))>64000)return {version:report.version,action:report.action,source:report.source,acceptance:report.acceptance,artifacts:report.artifacts.slice(0,32),warnings:['Report summary exceeds 64 KiB. Read the bounded report.json file for all technical details.'],reportSummaryTruncated:true};
  return summary;
}
export function registerMediaTools(server:McpServer,config:AppConfig,manager:ProcessManager){
  const jobs=mediaJobService(config,manager);
  const auth=toolAuthMetadata(config);
  server.registerTool('media_capabilities',{
    title:'Check installed media review dependencies',
    description:'Check local FFmpeg, ffprobe and Blender versions and supported review actions. No installation, uploads or paid API calls. Audio content support is a client capability and remains unverified by this check.',
    inputSchema:z.object({}),annotations:TOOL_ANNOTATIONS.readOnlyClosed,_meta:auth,
  },async()=>runTool(async()=>({...await mediaCapabilities(),jobRoot:jobs.root})));
  server.registerTool('media_submit',{
    title:'Submit a bounded local media review job',
    description:'Prepare a non-destructive local review: probe, image_review (optional lossless crop), image_compare (same-sized aligned pixel SSIM/difference, NOT semantic likeness), video_review (timestamped sampling and bounded black/freeze scan), audio_review (loudness/silence, waveform, spectrum, 15-second mono proxy), asset_audit or asset_preview (Blender base topology / four CPU clay views). Returns a persistent jobId immediately; use media_job to poll and retrieve native image previews. No original overwrites, publishing, external uploads, paid model calls, OCR or automatic visual/audio approval. Only local files, up to 600 seconds scanned, 16 sampled frames, and 2 simultaneous media jobs by default. Arbitrary FFmpeg flags and scripts are not accepted.',
    inputSchema:MediaRequestSchema,
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},_meta:auth,
  },async args=>runTool(()=>jobs.submit(args)));
  server.registerTool('media_job',{
    title:'Read a persistent media job and optional native preview',
    description:'Poll a media job without holding an execution slot. Reports processing state, source hash, scan coverage, metrics and local report/index.html paths. includePreview returns one bounded native image block; artifactName selects an existing image artifact. includeAudio returns the bounded mono listening proxy as native MCP audio, ONLY for compatible clients. Binary payloads never appear in text. A completed job is NOT visual/audio acceptance; unchanged source metadata is not a new full-file hash verification.',
    inputSchema:z.object({jobId:z.string().uuid().describe("Persistent media job UUID returned by media_submit."),includePreview:z.boolean().default(false).describe("Return one native image preview only when requested."),artifactName:z.string().max(160).optional().describe("Exact image artifact name listed in this job report."),includeAudio:z.boolean().default(false).describe("Return the short transformed audio proxy as native MCP audio; client support varies.")}),
    annotations:TOOL_ANNOTATIONS.readOnlyClosed,_meta:auth,
  },async({jobId,includePreview,artifactName,includeAudio}):Promise<CallToolResult>=>{
    try{
      const job=await jobs.get(jobId);
      const result=successResult({...job,report:compact(job.report),reviewPage:path.join(job.directory,'index.html'),reportPath:path.join(job.directory,'report.json')});
      if(job.state!=='completed'||!job.report)return result;
      if(includePreview){
        const names=job.report.artifacts.map(a=>a.name);
        const name=artifactName||['contact-sheet.jpg','preview.jpg','waveform.jpg','view-front.jpg'].find(n=>names.includes(n));
        if(!name||path.basename(name)!==name||!names.includes(name)||!(/\.(png|jpg)$/.test(name)))throw new Error('Select an image artifact listed by this job.');
        const image=await readNativeImage(path.join(job.directory,name),config.defaultCwd,undefined,1024*1024);
        if(image.isError)throw new Error('The selected image cannot fit the 1 MiB native preview budget. Select its JPEG proxy.');
        result.content.push(...image.content.filter(c=>c.type==='image'));
      }
      if(includeAudio){
        const artifact=job.report.artifacts.find(a=>a.name==='listen.wav');
        if(!artifact)throw new Error('This job has no listening proxy.');
        const file=path.join(job.directory,artifact.name);const size=(await stat(file)).size;
        if(size>481000)throw new Error('Audio proxy exceeds native content budget.');
        const data=await readFile(file);
        if(data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE')throw new Error('Invalid WAV proxy.');
        result.content.push({type:'audio',data:data.toString('base64'),mimeType:'audio/wav'});
      }
      return result;
    }catch(error){return errorResult(error);}
  });
  server.registerTool('media_cancel',{
    title:'Cancel one media review job',
    description:'Request cooperative cancellation of this specific media job, including its active FFmpeg/Blender subprocess. Does not stop other projects or delete artifacts. Poll media_job until cancelled; partial outputs are not approval.',
    inputSchema:z.object({jobId:z.string().uuid().describe("Persistent media job UUID returned by media_submit.")}),
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false},_meta:auth,
  },async({jobId})=>runTool(()=>jobs.cancel(jobId)));
}

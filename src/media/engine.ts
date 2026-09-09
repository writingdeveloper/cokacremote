import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { BLENDER_REVIEW_SCRIPT } from './blender-script.js';

const abortContext = new AsyncLocalStorage<AbortSignal>();
export function withMediaAbortSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> { return abortContext.run(signal, operation); }

export const MediaRequestSchema = z.object({
  action: z.enum(['probe','image_review','image_compare','video_review','audio_review','asset_audit','asset_preview']),
  path: z.string().min(1).max(4096),
  cwd: z.string().max(4096).optional(),
  reference: z.string().min(1).max(4096).optional(),
  startSeconds: z.number().finite().min(0).max(1_000_000).default(0),
  durationSeconds: z.number().finite().positive().max(600).default(60),
  frames: z.number().int().min(1).max(16).default(8),
  resolution: z.number().int().min(128).max(2048).default(768),
  diagnostics: z.boolean().default(true),
  crop: z.object({x:z.number().int().min(0),y:z.number().int().min(0),width:z.number().int().positive().max(8192),height:z.number().int().positive().max(8192)}).strict().optional(),
  objectName: z.string().min(1).max(256).optional(),
  animationFrame: z.number().int().min(-10000).max(1_000_000).optional(),
}).strict();
for (const [key, description] of Object.entries({"action":"Review action to run locally; never implies automatic acceptance.","path":"Local source media file path.","cwd":"Base directory for relative local file paths.","reference":"Same-sized aligned local reference image for image_compare.","startSeconds":"Start of the inspected timeline interval in seconds.","durationSeconds":"Maximum interval to inspect, up to 600 seconds; not a promise of whole-file coverage.","frames":"Number of evenly sampled video review frames, at most 16.","resolution":"Maximum image preview dimension; 3D views are capped at 768.","diagnostics":"Run bounded video black/freeze checks when true.","crop":"Optional exact pixel crop within the original image bounds.","objectName":"Optional exact Blender object name; include its descendants only.","animationFrame":"Optional Blender frame number for pose audit and preview."})) {
  const field = MediaRequestSchema.shape[key as keyof typeof MediaRequestSchema.shape];
  z.globalRegistry.add(field, { description });
}
export type MediaRequest = z.infer<typeof MediaRequestSchema>;
export interface SourceIdentity { path:string; bytes:number; mtimeMs:number; sha256:string }
export interface Artifact { name:string; bytes:number; sha256:string; mimeType:string }
export interface MediaProbe { format:Record<string,unknown>; streams:Array<Record<string,unknown>> }
export interface TimedEvent {kind:string;timeSeconds:number}
export interface ReviewReport {
  version:1; action:string; createdAt:string; source:SourceIdentity; acceptance:'NOT_REVIEWED';
  artifacts:Artifact[]; warnings:string[]; media?:MediaProbe;
  image?:{width:number;height:number;crop?:MediaRequest['crop'];previewTransformed:boolean};
  comparison?:{ssim:number|null;reference:SourceIdentity;semanticLikeness:'NOT_MEASURED';alignment:'REQUIRED_NOT_VERIFIED'};
  video?:{frames:Array<{name:string;requestedTimeSeconds:number}>;coverage:{startSeconds:number;durationSeconds:number;sourceDurationSeconds:number;fullTimeline:boolean};blackSegments:Array<{startSeconds:number;endSeconds:number;durationSeconds:number}>;freezeEvents:TimedEvent[];diagnosticsRun:boolean};
  audio?:{integratedLufs:number|null;truePeakDbTP:number|null;loudnessRangeLu:number|null;silenceEvents:TimedEvent[];coverage:{startSeconds:number;durationSeconds:number;sourceDurationSeconds:number;fullTimeline:boolean};listeningAcceptance:'NOT_LISTENED';visualization:{sampleRate:48000;channels:2;transformed:true};clip:{seconds:number;sampleRate:16000;channels:1;transformed:true}};
  asset?:{totals:{vertices:number;triangles:number;meshes:number};meshes:Array<{name:string;vertices:number;triangles:number;uvLayers:number;[key:string]:unknown}>;sourceSaved:false;[key:string]:unknown};
}
const IMAGE_EXT = new Set(['.png','.jpg','.jpeg','.webp','.bmp','.tif','.tiff','.exr','.gif']);
const AV_EXT = new Set(['.mp4','.mov','.mkv','.webm','.avi','.m4v','.wav','.mp3','.flac','.ogg','.m4a','.aac']);
const ASSET_EXT = new Set(['.blend','.glb','.gltf','.obj','.fbx']);
const MAX_FILE_BYTES = 16 * 1024 ** 3;
const MAX_PIXELS = 40_000_000;

export async function localInput(input:string,cwd=process.cwd()):Promise<string> {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) || /^[\\/]{2}/.test(input) || input.includes('\0')) throw new Error('Only local regular files are accepted; URLs and network shares are not supported.');
  const resolved=await realpath(path.resolve(cwd,input));
  if (/^[\\/]{2}/.test(resolved)) throw new Error('Network shares are not supported.');
  const info=await stat(resolved);
  if(!info.isFile() || info.size===0 || info.size>MAX_FILE_BYTES) throw new Error('Expected a nonempty regular media file no larger than 16 GiB.');
  const ext=path.extname(resolved).toLowerCase();
  if(!IMAGE_EXT.has(ext) && !AV_EXT.has(ext) && !ASSET_EXT.has(ext)) throw new Error('Unsupported media extension.');
  return resolved;
}
export async function fingerprint(file:string):Promise<SourceIdentity> {
  const before=await stat(file); const hash=createHash('sha256');
  for await (const chunk of createReadStream(file)) { abortContext.getStore()?.throwIfAborted(); hash.update(chunk as Buffer); }
  const after=await stat(file);
  if(before.size!==after.size || before.mtimeMs!==after.mtimeMs) throw new Error('Source changed during fingerprinting.');
  return {path:file,bytes:after.size,mtimeMs:after.mtimeMs,sha256:hash.digest('hex')};
}
export function runBounded(executable:string,args:string[],options:{timeoutMs?:number;maxBytes?:number;cwd?:string}={}):Promise<{stdout:string;stderr:string}> {
  return new Promise((resolve,reject)=>{
    execFile(executable,args,{windowsHide:true,shell:false,timeout:options.timeoutMs??120000,maxBuffer:options.maxBytes??2*1024*1024,encoding:'utf8',cwd:options.cwd,signal:abortContext.getStore()},(error,stdout,stderr)=>{
      if(error){
        const e=error as NodeJS.ErrnoException & {killed?:boolean};
        const reason=e.code==='ABORT_ERR'?'cancelled':e.code==='ENOENT'?'dependency not installed':e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'output budget exceeded':e.killed?'timeout':'nonzero exit';
        reject(new Error(`${path.basename(executable)}: ${reason}. ${String(stderr).slice(-1800)}`));
      }else resolve({stdout,stderr});
    });
  });
}
function executables(){
  const blender=process.env.MCP_MEDIA_BLENDER || (process.platform==='win32' ?
    ['5.2','5.1','5.0','4.5','4.4','4.3','4.2'].map(v=>`C:/Program Files/Blender Foundation/Blender ${v}/blender.exe`).find(existsSync) || 'blender' : 'blender');
  return {ffmpeg:process.env.MCP_MEDIA_FFMPEG||'ffmpeg',ffprobe:process.env.MCP_MEDIA_FFPROBE||'ffprobe',blender};
}
export async function mediaCapabilities(){
  const bins=executables();
  const check=async(name:keyof typeof bins)=>{
    try {const r=await runBounded(bins[name],[name==='blender'?'--version':'-version'],{timeoutMs:8000,maxBytes:32000});return {available:true,path:bins[name],version:r.stdout.split(/\r?\n/)[0]};}
    catch{return {available:false,path:bins[name],version:null};}
  };
  const [ffmpeg,ffprobe,blender]=await Promise.all([check('ffmpeg'),check('ffprobe'),check('blender')]);
  return {ffmpeg,ffprobe,blender,actions:MediaRequestSchema.shape.action.options,clientAudioSupport:'UNVERIFIED',networkUploads:false,sourceOverwrite:false,maximumScanSeconds:600,maximumSampleFrames:16,previewByteLimit:245000,notes:['Tool installation does not imply client support or artistic acceptance.','Blender disables file auto-execution; this is not a hostile-file sandbox.']};
}
async function ff(args:string[],cwd?:string){return runBounded(executables().ffmpeg,['-hide_banner','-nostdin','-y','-threads','2','-filter_threads','2','-filter_complex_threads','2',...args],{cwd});}
function input(file:string){return ['-protocol_whitelist','file,pipe','-i',file];}
async function probe(file:string):Promise<MediaProbe> {
  const r=await runBounded(executables().ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,duration,sample_rate,channels,channel_layout,color_space,color_transfer,color_primaries','-of','json',file],{timeoutMs:20000,maxBytes:256000});
  const data=JSON.parse(r.stdout);
  if(!Array.isArray(data.streams)||data.streams.length>64) throw new Error('No media streams or excessive stream count.');
  for(const s of data.streams) if(Number(s.width)*Number(s.height)>MAX_PIXELS) throw new Error('Source exceeds the 40 megapixel decode limit.');
  return {format:data.format||{},streams:data.streams};
}
function stream(p:MediaProbe,kind:string){const s=p.streams.find(s=>s.codec_type===kind);if(!s)throw new Error(`No ${kind} stream found.`);return s;}
function coverage(p:MediaProbe,r:MediaRequest){
  const duration=Number(p.format.duration || p.streams.find(s=>s.duration)?.duration);
  if(!Number.isFinite(duration)||duration<=0) throw new Error('A finite media duration is required.');
  if(r.startSeconds>=duration) throw new Error('Requested start is beyond the end of media duration.');
  const durationSeconds=Math.min(r.durationSeconds,duration-r.startSeconds);
  return {startSeconds:r.startSeconds,durationSeconds,sourceDurationSeconds:duration,fullTimeline:r.startSeconds===0&&durationSeconds>=duration-0.01};
}
const scale=(n:number)=>`scale=w='min(${n},iw)':h='min(${n},ih)':force_original_aspect_ratio=decrease`;
async function jpeg(file:string,out:string,resolution=768,filter?:string){
  for(const [factor,quality] of [[1,4],[0.8,7],[0.6,10],[0.4,14]] as const){
    await ff(['-loglevel','error',...input(file),'-vf',[filter,scale(Math.max(128,Math.floor(resolution*factor)))].filter(Boolean).join(','),'-frames:v','1','-update','1','-q:v',String(quality),out]);
    if((await stat(out)).size<=245000) return;
  }
  throw new Error('Preview could not fit the bounded image budget.');
}
const numeric=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?n:null;};
const events=(text:string,pattern:RegExp,offset:number):TimedEvent[]=>[...text.matchAll(pattern)].slice(0,500).map(m=>({kind:m[1]!,timeSeconds:Number(m[2])+offset}));
function escapeHtml(s:string){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
async function finishReport(report:ReviewReport,dir:string){
  const files=(await readdir(dir)).filter(n=>/\.(png|jpg|wav|json)$/.test(n)&&!['request.json','status.json','report.json','job.json','asset-request.json'].includes(n));
  let total=0;
  for(const name of files){
    const id=await fingerprint(path.join(dir,name)); total+=id.bytes;
    if(total>128*1024*1024) throw new Error('Review artifacts exceed the 128 MiB budget.');
    const ext=path.extname(name); report.artifacts.push({name,bytes:id.bytes,sha256:id.sha256,mimeType:ext==='.jpg'?'image/jpeg':ext==='.png'?'image/png':ext==='.wav'?'audio/wav':'application/json'});
  }
  const before=report.source; const after=await stat(before.path);
  if(before.bytes!==after.size||before.mtimeMs!==after.mtimeMs) throw new Error('Source changed while review was running; results must not be approved.');
  await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
  const cards=report.artifacts.filter(a=>/\.(jpg|png|wav)$/.test(a.name)).map(a=>`<section><h2>${escapeHtml(a.name)}</h2>${a.mimeType.startsWith('image/')?`<img src="${a.name}" loading="lazy" alt="${escapeHtml(a.name)}">`:`<audio controls src="${a.name}"></audio>`}</section>`).join('\n');
  await writeFile(path.join(dir,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local media review</title><style>body{font:16px system-ui;max-width:1200px;margin:32px auto;padding:20px;background:#121922;color:#e1e8f0}img{max-width:100%;height:auto}section{padding:16px;border:1px solid #607080;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#a6d8ff}</style><h1>Local media review</h1><p>NOT_REVIEWED — Successful processing is not visual, audio or artistic approval. Original files are unchanged.</p><p><a href="report.json">Technical report and source hashes</a></p>${cards}<h2>Coverage and measurements</h2><pre>${escapeHtml(JSON.stringify(report,null,2))}</pre></html>`);
  return report;
}

export async function executeReview(request:MediaRequest,dir:string):Promise<ReviewReport>{
  abortContext.getStore()?.throwIfAborted();
  const r=MediaRequestSchema.parse(request);
  if(r.crop && r.action!=='image_review')throw new Error('crop is supported only for image_review; image_compare measures the whole aligned image.');
  await mkdir(dir,{recursive:true});
  const sourcePath=await localInput(r.path,r.cwd); const ext=path.extname(sourcePath).toLowerCase();
  const source=await fingerprint(sourcePath);
  const report:ReviewReport={version:1,action:r.action,createdAt:new Date().toISOString(),source,acceptance:'NOT_REVIEWED',artifacts:[],warnings:[]};
  const out=(name:string)=>path.join(dir,name);
  if(r.action==='asset_audit'||r.action==='asset_preview'){
    if(!ASSET_EXT.has(ext))throw new Error('A supported 3D asset file is required.');
    await writeFile(out('blender-review.py'),BLENDER_REVIEW_SCRIPT);
    await writeFile(out('asset-request.json'),JSON.stringify({path:sourcePath,outputDirectory:dir,preview:r.action==='asset_preview',resolution:Math.min(768,r.resolution),objectName:r.objectName,animationFrame:r.animationFrame}));
    await runBounded(executables().blender,['--background','--factory-startup','--disable-autoexec','--offline-mode','--threads','2','--python-exit-code','7','--python',out('blender-review.py'),'--',out('asset-request.json')],{timeoutMs:240000,maxBytes:2*1024*1024});
    const audit=await readFile(out('asset-audit.json'),'utf8');if(audit.length>2*1024*1024)throw new Error('Asset audit exceeded report budget.');
    report.asset=JSON.parse(audit); report.warnings.push('Base mesh topology only; modifier evaluation, visual likeness, animation quality and engine import acceptance are separate checks.');
    for(const n of await readdir(dir))if(/^view-.*\.png$/.test(n))await jpeg(out(n),out(n.replace('.png','.jpg')),768);
    return finishReport(report,dir);
  }
  if(ASSET_EXT.has(ext))throw new Error('Use asset_audit or asset_preview for 3D files.');
  const media=await probe(sourcePath); report.media=media;
  if(r.action==='probe')return finishReport(report,dir);
  if(r.action==='image_review'||r.action==='image_compare'){
    if(!IMAGE_EXT.has(ext))throw new Error('Image review requires an image file.');
    const s=stream(media,'video'); const width=Number(s.width),height=Number(s.height);
    let cropFilter:string|undefined;
    if(r.crop){const c=r.crop;if(c.x+c.width>width||c.y+c.height>height)throw new Error('Requested crop exceeds source image bounds.');cropFilter=`format=rgb24,crop=${c.width}:${c.height}:${c.x}:${c.y}:exact=1`;
      await ff(['-loglevel','error',...input(sourcePath),'-vf',cropFilter,'-frames:v','1','-update','1',out('crop.png')]);}
    await jpeg(sourcePath,out('preview.jpg'),r.resolution,cropFilter);
    report.image={width,height,crop:r.crop,previewTransformed:true};
    report.warnings.push('Preview JPEG is transformed; crop.png is lossless in decoded RGB pixels, not a color-managed original. HDR/EXR color grading and animated image sequences are not evaluated.');
    if(r.action==='image_compare'){
      if(!r.reference)throw new Error('reference is required for image_compare.');
      const ref=await localInput(r.reference,r.cwd);if(!IMAGE_EXT.has(path.extname(ref).toLowerCase()))throw new Error('Reference must be an image.');
      const reference=await fingerprint(ref);const p=await probe(ref);const rs=stream(p,'video');
      if(Number(rs.width)!==width||Number(rs.height)!==height)throw new Error('Aligned images must have identical dimensions; automatic stretching is not allowed.');
      const metric=await ff(['-loglevel','info',...input(sourcePath),...input(ref),'-lavfi','[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]ssim','-frames:v','1','-f','null','-']);
      report.comparison={ssim:numeric(metric.stderr.match(/All:([\d.]+)/)?.[1]),reference,semanticLikeness:'NOT_MEASURED',alignment:'REQUIRED_NOT_VERIFIED'};
      await ff(['-loglevel','error',...input(sourcePath),...input(ref),'-filter_complex','[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]blend=all_mode=difference','-frames:v','1','-update','1',out('difference.png')]);
      await jpeg(ref,out('reference.jpg'),r.resolution);await jpeg(out('difference.png'),out('difference.jpg'),r.resolution);
      const after=await stat(ref);if(after.size!==reference.bytes||after.mtimeMs!==reference.mtimeMs)throw new Error('Reference changed during comparison.');
    }
    return finishReport(report,dir);
  }
  const scan=coverage(media,r);const clipInput=['-ss',String(scan.startSeconds),'-t',String(scan.durationSeconds),...input(sourcePath)];
  if(r.action==='video_review'){
    const s=stream(media,'video');const frames:Array<{name:string;requestedTimeSeconds:number}>=[];
    const portrait=Number(s.height)>Number(s.width);const w=portrait?240:384,h=portrait?426:216;
    for(let i=0;i<r.frames;i++){
      const time=r.startSeconds+(i+0.5)*scan.durationSeconds/r.frames;const name=`frame-${String(i).padStart(3,'0')}.jpg`;
      await ff(['-loglevel','error','-ss',String(time),...input(sourcePath),'-map','0:v:0','-an','-vf',`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,'-frames:v','1','-update','1','-q:v','5',out(name)]);
      if(!existsSync(out(name)))throw new Error('A sampled frame could not be decoded.');frames.push({name,requestedTimeSeconds:time});
    }
    const cols=Math.min(4,r.frames),rows=Math.ceil(r.frames/cols);
    await ff(['-loglevel','error','-framerate','1','-start_number','0','-i',out('frame-%03d.jpg'),'-vf',`tile=${cols}x${rows}:nb_frames=${r.frames}:padding=4:margin=4`,'-frames:v','1','-update','1','-q:v','4',out('contact-original.jpg')]);
    await jpeg(out('contact-original.jpg'),out('contact-sheet.jpg'),1536);
    let diag='';if(r.diagnostics)diag=(await ff(['-loglevel','info',...clipInput,'-map','0:v:0','-an','-vf','blackdetect=d=0.2:pix_th=0.1:pic_th=0.98,freezedetect=n=-50dB:d=2','-f','null','-'])).stderr;
    report.video={frames,coverage:scan,diagnosticsRun:r.diagnostics,blackSegments:[...diag.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)].slice(0,500).map(m=>({startSeconds:Number(m[1])+r.startSeconds,endSeconds:Number(m[2])+r.startSeconds,durationSeconds:Number(m[3])})),freezeEvents:events(diag,/(freeze_start|freeze_end):\s*([\d.]+)/g,r.startSeconds)};
    report.warnings.push('Contact sheet is sparse sampling, not full motion QA. Tile order is row-major; frame timestamps are requested seek times. Black/freeze detections are review candidates, not automatic defects. Diagnostics cover only the reported interval.');
    return finishReport(report,dir);
  }
  if(r.action==='audio_review'){
    stream(media,'audio');
    const measured=await ff(['-loglevel','info',...clipInput,'-map','0:a:0','-vn','-af','silencedetect=noise=-50dB:d=0.5,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-f','null','-']);
    const block=measured.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];if(!block)throw new Error('FFmpeg did not return loudness measurements.');const metrics=JSON.parse(block);
    const seconds=Math.min(15,scan.durationSeconds);
    await ff(['-loglevel','error','-ss',String(r.startSeconds),'-t',String(seconds),...input(sourcePath),'-map','0:a:0','-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',out('listen.wav')]);
    await ff(['-loglevel','error',...clipInput,'-filter_complex','[0:a:0]aresample=48000,aformat=channel_layouts=stereo,showwavespic=s=1200x260:split_channels=1[v]','-map','[v]','-frames:v','1','-update','1',out('waveform.png')]);
    await ff(['-loglevel','error',...clipInput,'-filter_complex','[0:a:0]aresample=48000,aformat=channel_layouts=stereo,showspectrumpic=s=1200x360:legend=1[v]','-map','[v]','-frames:v','1','-update','1',out('spectrum.png')]);
    await jpeg(out('waveform.png'),out('waveform.jpg'),1200);await jpeg(out('spectrum.png'),out('spectrum.jpg'),1200);
    report.audio={integratedLufs:numeric(metrics.input_i),truePeakDbTP:numeric(metrics.input_tp),loudnessRangeLu:numeric(metrics.input_lra),silenceEvents:events(measured.stderr,/(silence_start|silence_end):\s*([\d.]+)/g,r.startSeconds),coverage:scan,listeningAcceptance:'NOT_LISTENED',visualization:{sampleRate:48000,channels:2,transformed:true},clip:{seconds,sampleRate:16000,channels:1,transformed:true}};
    report.warnings.push('Loudness is measured on the source, not applied. Waveform/spectrum use a bounded 48 kHz stereo visualization proxy and cannot audit original multichannel or ultrasonic content. Null measurements represent silence or unavailable values. The 16 kHz mono listening proxy is not suitable for judging mastering, stereo imaging or high-frequency fidelity. Source timing/speech/music quality still require listening.');
    return finishReport(report,dir);
  }
  throw new Error('Unsupported review action.');
}

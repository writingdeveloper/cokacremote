import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { MediaRequestSchema, executeReview, mediaCapabilities, localInput } from '../src/media/engine.js';

let root: string;
const ffmpeg = process.env.MCP_MEDIA_FFMPEG || 'ffmpeg';
function wav(): Buffer {
  const n = 4 * 16000; const b = Buffer.alloc(44 + 2*n);
  b.write('RIFF'); b.writeUInt32LE(b.length-8,4); b.write('WAVEfmt ',8); b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24); b.writeUInt32LE(32000,28);
  b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(2*n,40);
  for(let i=0;i<16000;i++) b.writeInt16LE(Math.round(6000*Math.sin(2*Math.PI*440*i/16000)),44+2*i);
  return b;
}
async function review(action: string, file: string, opts: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(root,'job-'));
  return { dir, result: await executeReview(MediaRequestSchema.parse({ action, path: path.join(root,file), ...opts }), dir) };
}
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(),'cokac-media-tests-'));
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=160x96:d=0.1','-frames:v','1',path.join(root,'source.png')],{timeout:15000,windowsHide:true});
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=black:s=160x96:r=10:d=4','-c:v','mpeg4',path.join(root,'black.mp4')],{timeout:15000,windowsHide:true});
  await writeFile(path.join(root,'tone.wav'),wav());
  await writeFile(path.join(root,'quad.obj'),'o Quad\nv -1 -1 0\nv 1 -1 0\nv 1 1 0\nv -1 1 0\nf 1 2 3 4\n');
  await writeFile(path.join(root,'sample.txt'),'not a media file');
},30000);
afterAll(async()=>{await rm(root,{recursive:true,force:true});});

describe('bounded local media engine',()=>{
  it('reports actual tools without claiming client audio support',async()=>{
    const r=await mediaCapabilities();
    expect(r.ffmpeg.available).toBe(true); expect(r.ffprobe.available).toBe(true);
    expect(r.clientAudioSupport).toBe('UNVERIFIED');
  });
  it('rejects invalid ranges and unknown fields',()=>{
    for(const v of [{durationSeconds:0},{durationSeconds:601},{frames:17},{startSeconds:-1},{resolution:8192},{unknownField:true}])
      expect(()=>MediaRequestSchema.parse({action:'video_review',path:'x.mp4',...v})).toThrow();
  });
  it('rejects network sources, folders, missing files and unsupported types',async()=>{
    for(const p of ['https://example.invalid/x.mp4','file:///tmp/x',root,path.join(root,'absent.png'),path.join(root,'sample.txt')])
      await expect(localInput(p)).rejects.toThrow();
  });
  it('probes video stream metadata and records source identity',async()=>{
    const {result}=await review('probe','black.mp4');
    expect(result.media?.streams[0]).toMatchObject({codec_type:'video',width:160,height:96});
    expect(result.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.acceptance).toBe('NOT_REVIEWED');
  });
  it('crops losslessly and preserves the original',async()=>{
    const before=await readFile(path.join(root,'source.png'));
    const {dir,result}=await review('image_review','source.png',{crop:{x:8,y:8,width:64,height:48}});
    expect(result.image?.crop).toEqual({x:8,y:8,width:64,height:48});
    expect(result.artifacts.some(a=>a.name==='crop.png')).toBe(true);
    expect(result.artifacts.find(a=>a.name==='preview.jpg')!.bytes).toBeLessThan(250000);
    expect(await readFile(path.join(root,'source.png'))).toEqual(before);
    expect(await readFile(path.join(dir,'index.html'),'utf8')).toContain('NOT_REVIEWED');
  });
  it('rejects out-of-bounds crop',async()=>{
    await expect(review('image_review','source.png',{crop:{x:150,y:0,width:64,height:32}})).rejects.toThrow(/crop/i);
  });
  it('compares aligned pixels without assigning semantic likeness',async()=>{
    const {result}=await review('image_compare','source.png',{reference:path.join(root,'source.png')});
    expect(result.comparison?.ssim).toBeCloseTo(1,5);
    expect(result.comparison?.semanticLikeness).toBe('NOT_MEASURED');
    expect(result.artifacts.some(a=>a.name==='difference.png')).toBe(true);
  },30000);
  it('samples video and reports black/frozen coverage',async()=>{
    const {result}=await review('video_review','black.mp4',{frames:4,durationSeconds:4});
    expect(result.video?.frames).toHaveLength(4);
    expect(result.video?.coverage).toMatchObject({startSeconds:0,durationSeconds:4});
    expect(result.video?.blackSegments.length).toBeGreaterThan(0);
    expect(result.video?.freezeEvents.length).toBeGreaterThan(0);
    expect(result.artifacts.some(a=>a.name==='contact-sheet.jpg')).toBe(true);
    expect(result.acceptance).toBe('NOT_REVIEWED');
  },60000);
  it('rejects seeking beyond end of media',async()=>{
    await expect(review('video_review','black.mp4',{startSeconds:100})).rejects.toThrow(/duration|end/i);
  });
  it('measures audio loudness and silence, and prepares waveform and listening clip',async()=>{
    const {result}=await review('audio_review','tone.wav',{durationSeconds:4});
    expect(result.audio?.integratedLufs).toBeTypeOf('number');
    expect(result.audio?.silenceEvents.some(e=>e.kind==='silence_start' && e.timeSeconds>0.8)).toBe(true);
    expect(result.audio?.listeningAcceptance).toBe('NOT_LISTENED');
    expect(result.artifacts.find(a=>a.name==='listen.wav')!.bytes).toBeLessThan(481000);
    expect(result.artifacts.some(a=>a.name==='waveform.jpg')).toBe(true);
    expect(result.artifacts.some(a=>a.name==='spectrum.jpg')).toBe(true);
  },60000);
  it('refuses audio review without an audio stream',async()=>{
    await expect(review('audio_review','black.mp4')).rejects.toThrow(/audio/i);
  });
  it('audits OBJ topology and missing UV data with Blender',async()=>{
    const {result}=await review('asset_audit','quad.obj');
    expect(result.asset?.totals.vertices).toBe(4);
    expect(result.asset?.totals.triangles).toBe(2);
    expect(result.asset?.meshes[0]?.uvLayers).toBe(0);
    expect(result.asset?.sourceSaved).toBe(false);
  },60000);
});

it('rejects ambiguous crop options on image comparison',async()=>{
  await expect(review('image_compare','source.png',{reference:path.join(root,'source.png'),crop:{x:0,y:0,width:32,height:32}})).rejects.toThrow(/crop.*image_review/i);
});
it('records bounded audio visualization proxies separately from source measurements',async()=>{
  const {result}=await review('audio_review','tone.wav',{durationSeconds:2});
  expect(result.audio?.visualization).toEqual({sampleRate:48000,channels:2,transformed:true});
},30000);

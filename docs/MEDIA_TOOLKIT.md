# Local media review toolkit

Implemented 2026-09-08 PDT. This document describes functionality; deployment evidence and final test results are recorded separately in MEDIA_TOOLKIT_DEPLOYMENT.md.

## Purpose

Extend native MCP image inspection into repeatable local video, image, audio and 3D review packages. No original overwrite, automatic publishing, external media uploads, paid model calls or delegated visual model are performed. Processing success is deliberately NOT an artistic approval.

The existing read_image and image-compatible read_file route are preserved. Standard MCP ImageContent/AudioContent carries binary media; binary data are never duplicated into text or structured metadata. Do not use download_file or textual base64 transfers to inspect media.

## Entry points

| Tool | Purpose |
|---|---|
| media_capabilities | Check installed FFmpeg, ffprobe and Blender versions, actions and limits. Does not install software. |
| media_submit | Submit one bounded job and obtain jobId immediately. |
| media_job | Poll job state and read source identity, coverage, reports and artifacts. includePreview returns one native image. includeAudio explicitly requests a short native WAV proxy. |
| media_cancel | Request cancellation of this job only. Poll for its terminal state. No other project or source is stopped/deleted. |

## Actions

| action | Outputs and boundaries |
|---|---|
| probe | Container/stream codecs, duration, frame rate, dimensions, pixel/color format, audio sample rate/channels, size and SHA256. |
| image_review | Bounded JPEG preview; optional exact decoded-RGB lossless crop.png. Original bytes preserved. |
| image_compare | Same-sized image pair, SSIM, pixel difference PNG/JPEG and reference preview. Alignment is required but not verified. This is NOT semantic likeness, anatomy, style or composition scoring. Crop is rejected; prepare explicit crops first. |
| video_review | Up to 16 evenly distributed frames, row-major contact sheet, requested seek timestamps and optional black/freeze candidate detection over the specified interval. Sparse images cannot establish motion quality or whole-video acceptance. |
| audio_review | Source integrated loudness (LUFS), true peak (dBTP), loudness range, silence candidates, waveform/spectrum images, short listening proxy. No normalization is applied. Null values mean silence/unavailable measurement, not zero loudness. |
| asset_audit | Blender base-mesh counts, UV/material slots, boundary/non-manifold edges, zero-area faces, negative scale, loose vertices, rig/shape-key/action metadata and missing texture paths. Not evaluated-modifier or engine-import certification. |
| asset_preview | Audit plus front/right/back/three-quarter renders using CPU Cycles, 8 samples, 2 threads, neutral clay material. Supports an exact objectName hierarchy and animationFrame. Not a textured beauty render or automatic character likeness check. |

Image extensions: PNG, JPEG, WebP, BMP, TIFF, EXR, GIF. Only a still is reviewed; animated images and HDR/EXR color-management fidelity require a dedicated workflow. AV extensions: MP4, MOV, MKV, WebM, AVI, M4V, WAV, MP3, FLAC, OGG, M4A, AAC. 3D import paths: BLEND, GLB, glTF, OBJ, FBX. Availability of a Blender importer and valid input is required. Current fixture QA proves OBJ audit and render; it does not certify every real-world file in every format.

## Typical workflow

Call media_capabilities, then media_submit with the absolute source path. Example request shape (replace the example path):

```json
{
  "action": "video_review",
  "path": "C:/project/video.mp4",
  "startSeconds": 0,
  "durationSeconds": 90,
  "frames": 12,
  "diagnostics": true
}
```

Poll media_job with jobId. Do not resubmit merely because a tool response was delayed: that would create duplicate work. Once state is completed, request includePreview:true. Use artifactName to choose a specific frame or 3D view listed in report.artifacts. Read report.json for complete technical details and scan coverage.

For image detail use crop:{x,y,width,height} with image_review. Bounds must fit the image; the tool will not silently clamp or stretch. For a character hierarchy use asset_preview with objectName and animationFrame.

Each job produces a local index.html review page and report.json. Open index.html locally or integrate its outputs into an existing private project viewer. The toolkit does not create a public server, tunnel or external media URL.

## Cached connector compatibility

A client may keep an older tool manifest even after the server is upgraded. Do not assume failed discovery means the media backend is absent. The existing execution tool can run the shipped CLI from the repository:

```sh
node dist/src/media/cli.js capabilities
node dist/src/media/cli.js run request.json
node dist/src/media/cli.js status JOB_UUID
node dist/src/media/cli.js cancel JOB_UUID
```

The run command prints job information, waits for its worker and prints a terminal summary. For a long run use the normal exec_command/read_process process-session workflow. Read generated JPEGs through read_file with encoding=utf8, offset=0 and maxBytes=262144, or read_image when exposed. Never read a binary preview as ordinary text.

## Resource and lifecycle limits

The default root is config.defaultCwd/.cokacremote-media. MCP_MEDIA_ROOT can override it. MCP_MEDIA_MAX_CONCURRENT is 2 by default, allowed 1–4, and is a lower media-specific limit in addition to the existing managed process pool. Do not increase it to launch unlimited Blender jobs.

Requests inspect at most 600 seconds and sample at most 16 frames. Default duration is 60 seconds; reports explicitly identify coverage and whether it spans the whole source. Longer sources require intentional separate intervals, not a false full-file PASS. Source hashing is streaming and covers the source file, not all external asset dependencies.

FFprobe timeout: 20 seconds. Individual FFmpeg operation timeout: 120 seconds. Blender operation timeout: 240 seconds. Worker lifetime deadline: 600 seconds. Child output buffers are bounded. Image decode dimensions are capped at 40 megapixels; preview JPEGs at 245,000 bytes. Native selected preview budget is 1 MiB. Per-job artifact budget is 128 MiB; source files must be nonempty regular local files no larger than 16 GiB.

Audio waveform/spectrum use a 48 kHz stereo visualization proxy to bound memory. These plots do not certify original multichannel or ultrasonic fidelity. Loudness is measured on the selected original stream. The separate listening proxy is at most 15 seconds, 16 kHz mono PCM; it is unsuitable for judging mastering, stereo image or high-frequency fidelity. Actual ChatGPT client listening support remains UNVERIFIED even when an SDK test receives AudioContent.

Blender audits at most 500 mesh objects and 5 million base vertices; expensive BMesh details are skipped explicitly above 250,000 polygons per mesh. CPU clay preview resolution is capped at 768 square. GPU workloads and original scenes are not modified.

Jobs retain JSON state/artifacts on disk. A newly created client/service can retrieve completed jobs by UUID. In-progress workers lost across a service crash may be reported interrupted; automatic restart/retry is intentionally absent. Persistence is not a guarantee that every child survives every server restart. Cancellation is cooperative via a job-local flag plus the worker's AbortSignal; poll for cancelled/failed. Partial artifacts are never approvals.

History is bounded to 64 job directories by default. Archive completed/failed/cancelled/interrupted job directories deliberately when capacity is reached. Do not delete active jobs. There is no automatic destructive cleanup. Concurrent CLI and separately started server instances should not be treated as a globally distributed scheduler.

## Acceptance and safety

report.acceptance always starts NOT_REVIEWED; audio.listeningAcceptance starts NOT_LISTENED. Successful image transport is NOT_EVALUATED_BY_TRANSPORT. Black frames, freezes, silence, mesh boundaries and negative scale are candidates for review, not unconditional defects. No tool writes an artistic PASS automatically.

Source bytes are not overwritten. Source and artifacts receive SHA256 identifiers; source metadata changes during execution cause rejection. media_job.sourceMetadataStillMatches checks current size/mtime only, not a fresh content hash. Rehash before publication or final acceptance after external edits.

Input URLs and network shares are rejected; subprocesses receive argument arrays without a shell. FFmpeg protocols are restricted to file/pipe. Blender starts with factory settings, file auto-execution disabled and offline mode. glTF external resources must stay within the local asset directory. This is not an OS-level hostile-file sandbox; parsers still run with the MCP account's permissions.

## Not implemented / later work

Project batch manifests, content-hash cache reuse, GPU-aware cross-machine scheduling, full motion/animation checks, ASR and script alignment, high-fidelity stereo listening delivery, material/engine-specific character checks, full Khronos glTF validation and automatic integration into til-shorts publish gates remain separate work. Existing project approval gates are not silently changed by this toolkit.

## Primary references

- https://ffmpeg.org/ffprobe.html
- https://ffmpeg.org/ffmpeg-filters.html
- https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html
- https://ts.sdk.modelcontextprotocol.io/server
- https://github.com/KhronosGroup/glTF-Validator

## 2026-09-09 core integration and browser budget

The media tools are integrated on top of the connector-hardened core rather than a separate server fork. The combined catalog revision is `core-media-2026-09-09.1`, with 27 tools total. `tools/list`, `server/discover`, initialize, initialized notifications and ping use a separate bounded control-plane concurrency gate so long-running `tools/call` requests cannot consume every slot required to rediscover the connector.

The repository includes `npm run profile:tools` for a non-destructive in-memory catalog and latency profile. On the integration host after the media merge, the complete 27-tool catalog serialized to about 33.5 KiB, well under the enforced 128 KiB regression budget. Representative in-memory p95 values were about 1.6 ms for `stat_path` and 5.1 ms for a bounded `list_directory`; `media_capabilities` is intentionally slower because it launches local binaries to report their actual versions.

Production policy keeps normal execution at 8 concurrent MCP calls while reserving 4 independent control-plane calls and 16 queued control requests. Media work has an additional lower ceiling of 2 concurrent workers and 64 retained job directories by default. This separation is intended to keep connector discovery responsive even while development or media jobs are active.

Dependency audit on the final integration lockfile reports zero known npm vulnerabilities after patch-level updates of transitive `hono` and `qs` packages. Any future dependency update still requires the full Windows integration suite before deployment.

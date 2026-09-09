import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { expandPath } from "./paths.js";
import { errorResult } from "./tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";

// Native image transport registered by the production MCP server.
// ImageContent's wire encoding stays inside the image block. Never log it or
// duplicate it into text/structuredContent, which would recreate token flooding.
export const MAX_NATIVE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
interface ImageMetadata { mimeType: "image/png" | "image/jpeg"; width: number; height: number }

export function inspectImageHeader(data: Buffer): ImageMetadata {
  let result: ImageMetadata | undefined;
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length >= 45 && data.subarray(0, 8).equals(pngSignature)) {
    if (data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR" ||
        data.toString("ascii", data.length - 8, data.length - 4) !== "IEND") {
      throw new Error("Malformed PNG header or missing IEND; use a valid PNG export.");
    }
    result = { mimeType: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
      throw new Error("Truncated JPEG; missing end-of-image marker.");
    }
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset < data.length - 2) {
      if (data[offset++] !== 0xff) throw new Error("Malformed JPEG marker stream.");
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) throw new Error("Truncated JPEG segment.");
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) throw new Error("Invalid JPEG segment length.");
      if (sof.has(marker)) {
        if (length < 8) throw new Error("Invalid JPEG frame header.");
        result = { mimeType: "image/jpeg", height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
        break;
      }
      offset += length;
    }
    if (!result) throw new Error("JPEG image dimensions not found.");
  } else {
    throw new Error("Unsupported image signature. Only PNG and JPEG image files are accepted.");
  }
  if (result.width < 1 || result.height < 1 || result.width * result.height > MAX_IMAGE_PIXELS) {
    throw new Error("Image dimensions are empty or exceed the 40-megapixel review limit.");
  }
  return result;
}

export async function readNativeImage(
  inputPath: string,
  defaultCwd: string,
  cwd?: string,
  maxBytes = MAX_NATIVE_IMAGE_BYTES,
): Promise<CallToolResult> {
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_NATIVE_IMAGE_BYTES) {
      throw new Error("maxBytes must be between 1 and 8388608.");
    }
    if (/^[a-z]+:\/\//i.test(inputPath)) throw new Error("Only host file paths are accepted; no URL requests.");
    const resolved = expandPath(inputPath, cwd ? expandPath(cwd, defaultCwd) : defaultCwd);
    const file = await open(resolved, "r");
    let bytes: Buffer;
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new Error("Expected a regular image file.");
      if (before.size < 1 || before.size > maxBytes) throw new Error("Image file exceeds maxBytes or is empty; resize it locally first.");
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const chunk = await file.read(bytes, offset, bytes.length - offset, offset);
        if (chunk.bytesRead === 0) throw new Error("Image file changed while being read.");
        offset += chunk.bytesRead;
      }
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Image file changed while being read.");
    } finally {
      await file.close();
    }
    const image = inspectImageHeader(bytes);
    const metadata = {
      path: resolved, ...image, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      representation: "native_mcp_image_content",
      transformed: false,
      visualAcceptance: "NOT_EVALUATED_BY_TRANSPORT",
    };
    return {
      content: [
        { type: "text", text: JSON.stringify(metadata) },
        { type: "image", data: bytes.toString("base64"), mimeType: image.mimeType,
          annotations: { audience: ["assistant", "user"] } },
      ],
      structuredContent: metadata,
    };
  } catch (error) {
    return errorResult(error);
  }
}

export function registerImageTools(server: McpServer, config: AppConfig): void {
  server.registerTool("read_image", {
    title: "Read image for direct visual inspection",
    description: "Read a PNG/JPEG host file as native MCP image content so a compatible client can pass its pixels to the model. Use for visual QA of references, renders and screenshots. No text/base64 chunk transfer, no external upload, no model delegation. Full-file maximum 8 MiB and 40 megapixels; resize locally first when necessary. A successfully returned image is not a visual approval.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Absolute host path or a path relative to cwd/default cwd."),
      cwd: z.string().optional().describe("Base directory for a relative image path."),
      maxBytes: z.number().int().min(1).max(MAX_NATIVE_IMAGE_BYTES).default(MAX_NATIVE_IMAGE_BYTES).describe("Maximum complete image size in bytes; oversize files fail without partial image output."),
    }),
    annotations: TOOL_ANNOTATIONS.readOnlyClosed,
    _meta: toolAuthMetadata(config),
  }, async ({ path, cwd, maxBytes }) => readNativeImage(path, config.defaultCwd, cwd, maxBytes));
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNativeImage, inspectImageHeader } from "../src/image-tools.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+8G8AAAAASUVORK5CYII=", "base64");

describe("native image transport", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it("validates PNG dimensions and returns native image content without base64 duplication", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cokac-image-"));
    const file = path.join(root, "one.png");
    await writeFile(file, png);
    expect(inspectImageHeader(png)).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    const result = await readNativeImage(file, root);
    expect(result.isError).not.toBe(true);
    expect(result.content.map((item) => item.type)).toEqual(["text", "image"]);
    const image = result.content.find((item) => item.type === "image") as { data: string };
    const textual = JSON.stringify(result.structuredContent) + JSON.stringify(result.content.filter((item) => item.type === "text"));
    expect(image.data).toBe(png.toString("base64"));
    expect(textual).not.toContain(image.data);
  });

  it("rejects non-images and oversized budgets cleanly", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cokac-image-"));
    const bad = path.join(root, "bad.png");
    await writeFile(bad, "not an image");
    expect((await readNativeImage(bad, root)).isError).toBe(true);
    expect((await readNativeImage(bad, root, undefined, 0)).isError).toBe(true);
  });
});

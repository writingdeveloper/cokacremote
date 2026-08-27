import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileService } from "../src/file-service.js";
import {
  WakaTimeTracker,
  type WakaTimeCommandRunner,
} from "../src/wakatime-tracker.js";

class RecordingRunner implements WakaTimeCommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<void> {
    this.calls.push({ command, args: [...args] });
  }
}

describe("FileService WakaTime integration", () => {
  let temporaryDirectory: string;
  let runner: RecordingRunner;
  let files: FileService;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cokacremote-wakatime-files-"));
    runner = new RecordingRunner();
    const tracker = new WakaTimeTracker({
      enabled: true,
      cliPath: "wakatime-test-cli",
      plugin: "chatgpt-cokacremote/0.1.0",
      trackReads: true,
      runner,
    });
    files = new FileService({
      defaultCwd: temporaryDirectory,
      maxChunkBytes: 1024 * 1024,
      maxEditFileBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      activityTracker: tracker,
    });
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("tracks direct file writes and reads as ChatGPT activity", async () => {
    await files.writeFileContent(
      "src/example.ts",
      undefined,
      "export const value = 1;\n",
      "utf8",
      "overwrite",
      true,
    );
    await writeFile(
      path.join(temporaryDirectory, "src/read-only.ts"),
      "export const readOnly = true;\n",
      "utf8",
    );
    await files.readFileChunk("src/read-only.ts", undefined, 0, 1024, "utf8");

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]!.args).toEqual(
      expect.arrayContaining([
        "--entity",
        path.join(temporaryDirectory, "src/example.ts"),
        "--ai-line-changes",
        "1",
        "--write",
      ]),
    );
    expect(runner.calls[1]!.args).toEqual(
      expect.arrayContaining([
        "--entity",
        path.join(temporaryDirectory, "src/read-only.ts"),
      ]),
    );
    expect(runner.calls[1]!.args).not.toContain("--write");
  });

  it("tracks removed files as unsaved AI writes", async () => {
    const removedPath = path.join(temporaryDirectory, "removed.ts");
    await writeFile(removedPath, "const removed = true;\n", "utf8");

    await files.removePath("removed.ts", undefined, false, false);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args).toEqual(
      expect.arrayContaining([
        "--entity",
        removedPath,
        "--is-unsaved-entity",
        "--ai-line-changes",
        "1",
        "--write",
      ]),
    );
  });

  it("tracks replace, upload, and applied patches as writes", async () => {
    const replacePath = path.join(temporaryDirectory, "replace.ts");
    const uploadPath = path.join(temporaryDirectory, "upload.ts");
    const patchPath = path.join(temporaryDirectory, "patch.ts");
    await writeFile(replacePath, "const value = 1;\n", "utf8");
    await writeFile(patchPath, "const oldValue = 1;\n", "utf8");

    await files.replaceInFile("replace.ts", undefined, "1", "2", false, 1);
    await files.uploadChunk(
      "upload.ts",
      undefined,
      Buffer.from("const uploaded = true;\n").toString("base64"),
      0,
      true,
      true,
    );
    await files.applyPatch(
      [
        "diff --git a/patch.ts b/patch.ts",
        "--- a/patch.ts",
        "+++ b/patch.ts",
        "@@ -1 +1 @@",
        "-const oldValue = 1;",
        "+const newValue = 2;",
        "",
      ].join("\n"),
      undefined,
      { checkOnly: false, reverse: false, threeWay: false },
    );

    const entities = runner.calls.map((call) => {
      const entityIndex = call.args.indexOf("--entity");
      return entityIndex >= 0 ? call.args[entityIndex + 1] : undefined;
    });
    expect(entities).toEqual(
      expect.arrayContaining([replacePath, uploadPath, patchPath]),
    );
    expect(runner.calls.every((call) => call.args.includes("--write"))).toBe(true);

    const callFor = (entity: string) =>
      runner.calls.find((call) => {
        const entityIndex = call.args.indexOf("--entity");
        return entityIndex >= 0 && call.args[entityIndex + 1] === entity;
      });
    expect(callFor(replacePath)?.args).toEqual(
      expect.arrayContaining(["--ai-line-changes", "2"]),
    );
    expect(callFor(patchPath)?.args).toEqual(
      expect.arrayContaining(["--ai-line-changes", "2"]),
    );
    expect(callFor(uploadPath)?.args).not.toContain("--ai-line-changes");
  });
});

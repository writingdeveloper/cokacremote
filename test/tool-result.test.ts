import { describe, expect, it } from "vitest";

import { successResult } from "../src/tool-result.js";

describe("tool result serialization", () => {
  it("does not duplicate a large process payload into JSON text and structured content", () => {
    const output = "x".repeat(256 * 1024);
    const result = successResult(
      { sessionId: "s", stdout: output, output, nextSeq: 2, hasMore: false },
      { text: "process completed" },
    );
    const bytes = Buffer.byteLength(JSON.stringify(result));

    expect(bytes).toBeLessThan(Buffer.byteLength(output) * 2.2);
  });

  it("uses concise text for structured results instead of serializing the entire object", () => {
    const large = "x".repeat(64 * 1024);
    const result = successResult({ ok: true, details: large });
    const text = result.content.find((item) => item.type === "text");

    expect(text?.type).toBe("text");
    expect(text && "text" in text ? text.text.length : 0).toBeLessThan(1024);
    expect(result.structuredContent).toMatchObject({ ok: true, details: large });
  });
});

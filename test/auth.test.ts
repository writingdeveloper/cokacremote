import { describe, expect, it } from "vitest";

import { parseBearerAuthorization, tokensEqual } from "../src/auth.js";

describe("bearer authentication helpers", () => {
  it("parses bearer credentials in linear time without a backtracking regex", () => {
    expect(parseBearerAuthorization("Bearer token-value")).toBe("token-value");
    expect(parseBearerAuthorization("bearer\t\tother-token")).toBe("other-token");
    expect(parseBearerAuthorization("Basic token-value")).toBeUndefined();
    expect(parseBearerAuthorization("Bearer")).toBeUndefined();
    expect(parseBearerAuthorization("Bearer    ")).toBeUndefined();

    const adversarial = `Bearer ${" ".repeat(1_000_000)}token`;
    const started = performance.now();
    expect(parseBearerAuthorization(adversarial)).toBe("token");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("keeps constant-time equality semantics for equal-length tokens", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
    expect(tokensEqual("short", "longer")).toBe(false);
  });
});

import {
  generateRequestId,
  isValidRequestId,
  resolveRequestId,
} from "@/lib/server/request-id";
import { describe, expect, it } from "vitest";

describe("request id", () => {
  it("accepts the documented shape and nothing else", () => {
    // Table-driven control for the log-injection contract (Security §2).
    const valid = [
      "abcdefgh",
      "smoke-req-id-0001",
      "a".repeat(128),
      "UUID-like_00-11_22",
    ];
    const invalid = [
      "",
      "short", // 5 chars — below the 8 minimum
      "a".repeat(129), // unbounded echo would be a header-injection vector
      "has space",
      "has\nnewline",
      "quote\"inside",
      "unicode-ünicode",
      "semi;colon",
    ];
    for (const value of valid) {
      expect(isValidRequestId(value), value).toBe(true);
    }
    for (const value of invalid) {
      expect(isValidRequestId(value), value).toBe(false);
    }
  });

  it("mints uuid-shaped ids", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("preserves a well-formed caller id and replaces anything else", () => {
    expect(resolveRequestId("caller-supplied-01")).toBe("caller-supplied-01");
    expect(resolveRequestId("bad id!")).not.toBe("bad id!");
    expect(resolveRequestId("")).not.toBe("");
    expect(resolveRequestId(null)).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

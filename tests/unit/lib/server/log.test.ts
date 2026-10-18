import {
  errorFields,
  isSensitiveKey,
  logError,
  logInfo,
  logWarn,
  setLogStream,
  type LogLine,
} from "@/lib/server/log";
import { runWithRequestContext } from "@/lib/server/request-context";
import { afterEach, describe, expect, it } from "vitest";
import { captureLogs, silenceLogs } from "../../helpers/log-capture";

afterEach(() => silenceLogs());

function collect(): { lines: LogLine[]; restore: () => void } {
  return captureLogs();
}

describe("log redaction — the Security §2 control", () => {
  // Every key whose value must never be logged, in each spelling the code
  // base actually uses. Matching is on a normalized key, so one row covers
  // snake_case, camelCase and spaced variants.
  const sensitiveRows: [string, unknown][] = [
    ["authorization", "Bearer xyz"],
    ["cookie", "session=abc"],
    ["setCookie", "session=abc"],
    ["token", "tok_123"],
    ["tokens", ["a", "b"]],
    ["accessToken", "tok"],
    ["refreshToken", "tok"],
    ["idToken", "tok"],
    ["token_hash", "deadbeef"],
    ["signedUrl", "https://x/storage/v1/sign?token=sig"],
    ["signed_urls", ["https://x"]],
    ["password", "hunter2"],
    ["passwordHash", "bcrypt"],
    ["apiKey", "sk-..."],
    ["api_secret", "s"],
    ["secret", "s"],
    ["clientSecret", "s"],
    ["privateKey", "s"],
    ["reporterId", "user-1"],
    ["content", "the reported text"],
    ["jwt", "eyJ..."],
    ["bearer", "Bearer x"],
    ["credentials", { user: "u" }],
    ["sessionToken", "tok"],
  ];

  it.each(sensitiveRows)("redacts %s under every spelling", (key, value) => {
    const { lines, restore } = collect();
    logInfo("test", { [key]: value, safe: "kept" });
    const entry = lines[0][key];
    expect(entry).toBe("<redacted>");
    expect(lines[0].safe).toBe("kept");
    restore();
  });

  it("normalizes key spelling before matching", () => {
    expect(isSensitiveKey("TOKEN_HASH")).toBe(true);
    expect(isSensitiveKey("token-hash")).toBe(true);
    expect(isSensitiveKey("TokenHash")).toBe(true);
    expect(isSensitiveKey("refresh_token")).toBe(true);
    expect(isSensitiveKey("room_id")).toBe(false);
  });

  it("scrubs credential-shaped values under innocent keys", () => {
    const { lines, restore } = collect();
    logInfo("test", {
      message: "call failed: Bearer abc123",
      url: "https://example.com/x?token=secret-value&other=1",
      detail: "eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaaaa.bbbbbbbbbbbb",
    });
    const line = lines[0];
    expect(String(line.message)).not.toContain("abc123");
    expect(String(line.url)).toContain("token=<redacted>");
    expect(String(line.url)).toContain("other=1");
    expect(String(line.detail)).toBe("<redacted>");
    restore();
  });

  it("truncates deeply nested structures instead of recursing forever", () => {
    const { lines, restore } = collect();
    let nested: Record<string, unknown> = { end: true };
    for (let depth = 0; depth < 10; depth++) {
      nested = { child: nested };
    }
    logInfo("test", nested);
    expect(JSON.stringify(lines[0])).toContain("<truncated>");
    restore();
  });
});

describe("log envelope", () => {
  it("always emits ts, level and event — request_id only inside a context", () => {
    const { lines, restore } = collect();
    logWarn("dep_degraded", { dependency: "storage" });

    const [line] = lines;
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(line.level).toBe("warn");
    expect(line.event).toBe("dep_degraded");
    expect(line.dependency).toBe("storage");
    expect(line.request_id).toBeUndefined();
    restore();
  });

  it("attaches the request id when running inside a wrapped request", () => {
    const { lines, restore } = collect();
    runWithRequestContext({ requestId: "ctx-test-0001" }, () => {
      logError("boom", { detail: "x" });
    });

    expect(lines[0].request_id).toBe("ctx-test-0001");
    restore();
  });

  it("writes one JSON object per line", () => {
    const chunks: string[] = [];
    setLogStream({ write: (chunk) => chunks.push(chunk) });
    logInfo("a");
    logInfo("b");
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(chunk)).not.toThrow();
    }
  });
});

describe("errorFields", () => {
  it("captures name, message and stack from an Error", () => {
    const fields = errorFields(new TypeError("bad input"));
    expect(fields.error_name).toBe("TypeError");
    expect(fields.error_message).toBe("bad input");
    expect(String(fields.stack)).toContain("TypeError");
  });

  it("stringifies anything else thrown", () => {
    expect(errorFields("plain string")).toEqual({
      error_message: "plain string",
    });
    expect(errorFields({ weird: true })).toEqual({
      error_message: "[object Object]",
    });
  });
});

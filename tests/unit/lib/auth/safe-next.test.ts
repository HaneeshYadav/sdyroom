import { safeInternalPath } from "@/lib/auth/safe-next";
import { describe, expect, it } from "vitest";

describe("safeInternalPath", () => {
  it("accepts ordinary site-internal paths", () => {
    expect(safeInternalPath("/rooms")).toBe("/rooms");
    expect(safeInternalPath("/")).toBe("/");
    expect(safeInternalPath("/rooms?filter=physics")).toBe("/rooms?filter=physics");
    expect(safeInternalPath("/rooms/6f0d5f3e-6a4e-4f0e-9d3f-0d3e0d3e0d3e")).toBe(
      "/rooms/6f0d5f3e-6a4e-4f0e-9d3f-0d3e0d3e0d3e",
    );
    expect(safeInternalPath("/auth/login?next=/rooms")).toBe("/auth/login?next=/rooms");
  });

  it("rejects absolute URLs to another origin", () => {
    expect(safeInternalPath("https://evil.example")).toBeNull();
    expect(safeInternalPath("http://evil.example/phish")).toBeNull();
    expect(safeInternalPath("javascript:alert(1)")).toBeNull();
    expect(safeInternalPath("evil.example")).toBeNull();
    expect(safeInternalPath("//evil.example")).toBeNull();
    expect(safeInternalPath("///evil.example")).toBeNull();
  });

  it("rejects backslash tricks the browser would normalise to //host", () => {
    expect(safeInternalPath("/\\evil.example")).toBeNull();
    expect(safeInternalPath("/\\evil.example/path")).toBeNull();
    expect(safeInternalPath("/rooms\\..\\evil")).toBeNull();
  });

  it("rejects control characters and newlines", () => {
    expect(safeInternalPath("/rooms\nSet-Cookie: x=1")).toBeNull();
    expect(safeInternalPath("/rooms\r\n/evil")).toBeNull();
    expect(safeInternalPath("/rooms\t/evil")).toBeNull();
    expect(safeInternalPath("/rooms\u0000")).toBeNull();
    expect(safeInternalPath("/\u007f")).toBeNull();
  });

  it("treats missing, empty and relative values as unsafe", () => {
    expect(safeInternalPath(null)).toBeNull();
    expect(safeInternalPath("")).toBeNull();
    expect(safeInternalPath("rooms")).toBeNull();
    expect(safeInternalPath("../rooms")).toBeNull();
  });
});

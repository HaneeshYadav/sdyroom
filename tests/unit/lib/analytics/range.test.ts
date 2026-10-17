import {
  RANGE_DAYS,
  parseRangeParam,
  rangeDays,
  rangeWindow,
} from "@/lib/analytics/range";
import { describe, expect, it } from "vitest";

describe("RANGE_DAYS", () => {
  it("maps every accepted range to an inclusive day count", () => {
    expect(RANGE_DAYS).toEqual({ "7d": 7, "30d": 30, "90d": 90 });
  });
});

describe("parseRangeParam", () => {
  it("accepts exactly 7d, 30d and 90d", () => {
    expect(parseRangeParam("7d")).toEqual({ ok: true, range: "7d" });
    expect(parseRangeParam("30d")).toEqual({ ok: true, range: "30d" });
    expect(parseRangeParam("90d")).toEqual({ ok: true, range: "90d" });
  });

  it("rejects everything else — no default, no coercion", () => {
    for (const value of [null, "", "1d", "7", "7D", "365d", "all", " "]) {
      expect(parseRangeParam(value as string | null)).toEqual({ ok: false });
    }
  });
});

describe("rangeDays", () => {
  it("reads the day count for a parsed range", () => {
    expect(rangeDays("7d")).toBe(7);
    expect(rangeDays("90d")).toBe(90);
  });
});

describe("rangeWindow", () => {
  it("spans seven UTC dates including today", () => {
    expect(rangeWindow("7d", "2026-10-17")).toEqual({
      start: "2026-10-11",
      end: "2026-10-17",
      days: 7,
    });
  });

  it("crosses month and year boundaries via UTC arithmetic", () => {
    expect(rangeWindow("7d", "2026-11-02")).toEqual({
      start: "2026-10-27",
      end: "2026-11-02",
      days: 7,
    });
    expect(rangeWindow("30d", "2026-01-15")).toEqual({
      start: "2025-12-17",
      end: "2026-01-15",
      days: 30,
    });
  });

  it("keeps 90d inclusive: end - start + 1 === 90", () => {
    const window = rangeWindow("90d", "2026-10-17");
    expect(window.end).toBe("2026-10-17");
    expect(window.days).toBe(90);
    expect(window.start).toBe("2026-07-20");
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  addDaysIso,
  diffDays,
  examWindowBounds,
  EXAM_WINDOW_MESSAGE,
  formatIsoDate,
  isCalendarDate,
  parseIsoDate,
  utcTodayIso,
} from "@/lib/planner/dates";

describe("utcTodayIso", () => {
  it("formats the current instant as a UTC calendar date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T23:30:00+05:30")); // 18:00 UTC
    expect(utcTodayIso()).toBe("2026-10-17");
    vi.useRealTimers();
  });

  it("agrees with the database's current_date across zones", () => {
    vi.useFakeTimers();
    // 00:30 UTC on the 18th is still the 17th in Lisbon — UTC wins.
    vi.setSystemTime(new Date("2026-10-18T00:30:00+00:00"));
    expect(utcTodayIso()).toBe("2026-10-18");
    vi.useRealTimers();
  });
});

describe("isCalendarDate", () => {
  it("accepts real dates only", () => {
    expect(isCalendarDate("2026-10-17")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true); // leap year
    expect(isCalendarDate("2026-02-29")).toBe(false); // not a leap year
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-1-1")).toBe(false); // wrong shape
    expect(isCalendarDate("2026-10-32")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
  });
});

describe("parseIsoDate / formatIsoDate", () => {
  it("round-trips a calendar date through UTC midnight", () => {
    const epoch = parseIsoDate("2026-10-17");
    expect(epoch).not.toBeNull();
    expect(formatIsoDate(epoch!)).toBe("2026-10-17");
  });

  it("returns null for anything without a calendar-date shape", () => {
    expect(parseIsoDate("nope")).toBeNull();
    expect(parseIsoDate("2026-2-30")).toBeNull();
    // Shape-only: rollover dates parse but fail isCalendarDate's round-trip.
    expect(isCalendarDate("2026-02-30")).toBe(false);
  });
});

describe("addDaysIso", () => {
  it("crosses month, year, and leap boundaries", () => {
    expect(addDaysIso("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("diffDays", () => {
  it("is signed and whole-day", () => {
    expect(diffDays("2026-10-17", "2026-10-20")).toBe(3);
    expect(diffDays("2026-10-20", "2026-10-17")).toBe(-3);
    expect(diffDays("2026-10-17", "2026-10-17")).toBe(0);
    expect(diffDays("2026-12-31", "2027-01-01")).toBe(1);
  });
});

describe("examWindowBounds", () => {
  it("spans [today+1, today+180]", () => {
    expect(examWindowBounds("2026-10-17")).toEqual({
      min: "2026-10-18",
      max: "2027-04-15",
    });
  });

  it("shares the schema's message", () => {
    expect(EXAM_WINDOW_MESSAGE).toContain("180");
  });
});

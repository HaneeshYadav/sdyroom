import { computeStreaks } from "@/lib/analytics/streaks";
import { describe, expect, it } from "vitest";

const TODAY = "2026-10-17";
const YESTERDAY = "2026-10-16";
const TWO_DAYS_AGO = "2026-10-15";

describe("computeStreaks", () => {
  it("returns zeros for an empty lookback", () => {
    expect(computeStreaks([], TODAY)).toEqual({
      studyDays: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
    });
  });

  it("counts a live streak from today backwards", () => {
    expect(computeStreaks([TODAY, YESTERDAY, TWO_DAYS_AGO], TODAY)).toEqual({
      studyDays: 3,
      currentStreakDays: 3,
      longestStreakDays: 3,
    });
  });

  it("keeps yesterday's streak alive when today has no focus yet", () => {
    expect(computeStreaks([YESTERDAY, TWO_DAYS_AGO], TODAY)).toEqual({
      studyDays: 2,
      currentStreakDays: 2,
      longestStreakDays: 2,
    });
  });

  it("ends the current streak on a gap (today and yesterday missing)", () => {
    expect(
      computeStreaks(["2026-10-10", "2026-10-09", "2026-10-07"], TODAY),
    ).toEqual({
      studyDays: 3,
      currentStreakDays: 0,
      longestStreakDays: 2,
    });
  });

  it("ignores input order and duplicates", () => {
    expect(
      computeStreaks([TWO_DAYS_AGO, TODAY, YESTERDAY, YESTERDAY, TODAY], TODAY),
    ).toEqual({
      studyDays: 3,
      currentStreakDays: 3,
      longestStreakDays: 3,
    });
  });

  it("tracks the longest run even when it is not the current one", () => {
    const days = [
      "2026-10-17", // today
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06", // longest: 6
      "2026-10-09",
      "2026-10-10", // 2
    ];
    expect(computeStreaks(days, TODAY)).toEqual({
      studyDays: 9,
      currentStreakDays: 1,
      longestStreakDays: 6,
    });
  });

  it("runs across month and year boundaries", () => {
    expect(
      computeStreaks(["2025-12-31", "2026-01-01", "2026-01-02"], "2026-01-02"),
    ).toEqual({
      studyDays: 3,
      currentStreakDays: 3,
      longestStreakDays: 3,
    });
    expect(computeStreaks(["2026-09-30", "2026-10-01"], TODAY)).toEqual({
      studyDays: 2,
      currentStreakDays: 0,
      longestStreakDays: 2,
    });
  });
});

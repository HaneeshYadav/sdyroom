import { addDaysIso } from "@/lib/planner/dates";

/**
 * Streak arithmetic over `analytics_me`'s `study_days` (PR 16).
 *
 * A study day is a UTC calendar date on which the caller has credited focus
 * time (the RPC returns those dates over a documented 365-day lookback, so
 * both numbers below are capped at that window). Rules, unit-tested here
 * rather than in SQL because the boundaries are the interesting part:
 *
 *   * current streak — walk back from today; if today has no focus yet, the
 *     day is not over, so the streak may still be alive from yesterday
 *     (counting starts there); any gap ends it.
 *   * longest streak — the longest consecutive run anywhere in the list.
 *   * empty input → all zeros; input order and duplicates do not matter.
 */

export type Streaks = {
  studyDays: number;
  currentStreakDays: number;
  longestStreakDays: number;
};

export function computeStreaks(
  studyDays: readonly string[],
  todayIso: string,
): Streaks {
  const days = [...new Set(studyDays)].sort();
  if (days.length === 0) {
    return { studyDays: 0, currentStreakDays: 0, longestStreakDays: 0 };
  }

  const present = new Set(days);

  let current = 0;
  let cursor = present.has(todayIso) ? todayIso : addDaysIso(todayIso, -1);
  if (present.has(cursor)) {
    while (present.has(cursor)) {
      current += 1;
      cursor = addDaysIso(cursor, -1);
    }
  }

  let longest = 1;
  let run = 1;
  for (let index = 1; index < days.length; index += 1) {
    run = days[index] === addDaysIso(days[index - 1], 1) ? run + 1 : 1;
    if (run > longest) {
      longest = run;
    }
  }

  return {
    studyDays: days.length,
    currentStreakDays: current,
    longestStreakDays: longest,
  };
}

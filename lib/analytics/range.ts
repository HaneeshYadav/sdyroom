import { addDaysIso } from "@/lib/planner/dates";
import type { AnalyticsRange } from "@/lib/validation/analytics";

/**
 * Range arithmetic for study analytics (PR 16).
 *
 * Every range is a trailing window of whole UTC calendar days, inclusive of
 * today — the same UTC authority `lib/planner/dates.ts` uses, so a range the
 * API serves and a range the page renders can never disagree. Nothing here
 * consults the machine's local zone.
 */

export const RANGE_DAYS: Record<AnalyticsRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export type RangeParse =
  | { ok: true; range: AnalyticsRange }
  | { ok: false };

/**
 * Parses a raw `?range=` value. A missing, empty or unknown value is a
 * failure — the API has no default (spec: bad/missing range → 400); pages
 * choose their own default before calling it.
 */
export function parseRangeParam(value: string | null): RangeParse {
  if (value === "7d" || value === "30d" || value === "90d") {
    return { ok: true, range: value };
  }
  return { ok: false };
}

export function rangeDays(range: AnalyticsRange): number {
  return RANGE_DAYS[range];
}

/**
 * The inclusive `[start, end]` UTC date window for a range relative to
 * `todayIso`. `days` counts end - start + 1, so `7d` spans seven dates
 * including today (the SQL side builds the same window from `p_days`).
 */
export function rangeWindow(
  range: AnalyticsRange,
  todayIso: string,
): { start: string; end: string; days: number } {
  const days = RANGE_DAYS[range];
  return { start: addDaysIso(todayIso, -(days - 1)), end: todayIso, days };
}

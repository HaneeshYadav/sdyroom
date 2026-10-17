/**
 * Calendar-date helpers for the study planner (PR 15).
 *
 * Planner dates are plain calendar dates (`YYYY-MM-DD`) compared and moved
 * as UTC midnights — the same posture as the database, where `current_date`
 * and the `item_date`/`exam_date` columns evaluate under the stack's UTC
 * timezone. Nothing here consults the machine's local zone: a plan built at
 * 23:30 in Lisbon and the same instant in UTC must agree on "today".
 *
 * The strings are the canonical form everywhere (Zod request bodies, RPC
 * JSON, the `<plan>` prompt marker, item payloads) — parsers are strict so
 * a malformed date is a validation failure, never a silently shifted one.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date in UTC (`YYYY-MM-DD`). */
export function utcTodayIso(now: Date = new Date()): string {
  return formatIsoDate(now.getTime());
}

/** Strict calendar-date check: shape plus a real, round-trippable date. */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const epoch = parseIsoDate(value);
  return epoch !== null && formatIsoDate(epoch) === value;
}

/** UTC-midnight epoch ms for a `YYYY-MM-DD` string; null when unparseable. */
export function parseIsoDate(value: string): number | null {
  if (!ISO_DATE.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const epoch = Date.UTC(year, month - 1, day);
  return Number.isFinite(epoch) ? epoch : null;
}

/** `YYYY-MM-DD` for a UTC-midnight epoch-ms value. */
export function formatIsoDate(epochMs: number): string {
  const date = new Date(epochMs);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Calendar arithmetic: `value + days` as a `YYYY-MM-DD` string. */
export function addDaysIso(value: string, days: number): string {
  const epoch = parseIsoDate(value);
  if (epoch === null) {
    throw new Error(`addDaysIso: not a calendar date: ${value}`);
  }
  return formatIsoDate(epoch + days * 86_400_000);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: string, to: string): number {
  const fromEpoch = parseIsoDate(from);
  const toEpoch = parseIsoDate(to);
  if (fromEpoch === null || toEpoch === null) {
    throw new Error(`diffDays: not a calendar date: ${from} / ${to}`);
  }
  return Math.round((toEpoch - fromEpoch) / 86_400_000);
}

/** Negative-safe ordering: `< 0` when `a` is before `b`. */
export function compareIso(a: string, b: string): number {
  const aEpoch = parseIsoDate(a);
  const bEpoch = parseIsoDate(b);
  if (aEpoch === null || bEpoch === null) {
    throw new Error(`compareIso: not a calendar date: ${a} / ${b}`);
  }
  return aEpoch - bEpoch;
}

/**
 * The exam-date window the spec fixes: `[today+1, today+180]`, plus the
 * validation message shared by Zod and the setup form.
 */
export const EXAM_WINDOW_MESSAGE =
  "Exam date must be between tomorrow and the next 180 days.";

export function examWindowBounds(
  today: string = utcTodayIso(),
): { min: string; max: string } {
  return { min: addDaysIso(today, 1), max: addDaysIso(today, 180) };
}

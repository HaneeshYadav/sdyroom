import { addDaysIso, compareIso, diffDays } from "./dates";

/**
 * The shift algorithm (PR 15, "adjustment logic is deterministic, not LLM").
 *
 * "I missed today": every not-yet-done item from `from_date` onward moves
 * forward by the number of days `from_date` itself lags behind today —
 *
 *     shift = max(0, today − from_date)
 *
 * floored at zero (a call from today or the future moves nothing — the
 * "already on time" no-op), and each move is clamped at `exam_date` — an
 * item whose full shift would pass the exam lands *on* the exam date and is
 * counted in `past_exam_date` so the caller can say so, never silently
 * dropped. Items already done never move: work that happened is work that
 * stays.
 *
 * `from_date` is therefore both the window start and the lag the UI sends:
 * "I missed today" posts `from_date = yesterday` (shift 1), "I missed three
 * days" posts three days back, and an overdue plan catches up fully when the
 * UI posts its earliest undone date. The amount never depends on request
 * arithmetic beyond that date — a repeat call from the same `from_date`
 * applies the same advance again (a relative nudge, confirmed in the UI), so
 * the caller always learns the true `moved` count rather than assuming a
 * no-op.
 *
 * This module is the single source of truth for that arithmetic; the route
 * computes moves here and `shift_plan` in the database re-validates and
 * applies them atomically (ownership, window, forward-only, ≤ exam, done
 * items skipped on a concurrent completion).
 */

export type ShiftableItem = {
  id: string;
  /** Calendar date of the item (`YYYY-MM-DD`). */
  item_date: string;
  /** ISO timestamp when the item was completed; null while undone. */
  done_at: string | null;
};

export type PlannedMove = {
  id: string;
  item_date: string;
};

export type ShiftResult = {
  /** The surviving moves, ready for `shift_plan`'s `p_updates`. */
  updates: PlannedMove[];
  /** How many items actually change date (`updates` length). */
  moved: number;
  /**
   * How many window items needed more days than the exam date allows —
   * they were clamped onto the exam date, and the caller reports this.
   */
  past_exam_date: number;
};

/**
 * Computes the forward shift for one plan.
 *
 * @param items the plan's items (any order; done and undone mixed)
 * @param fromDate window start — only undone items on/after this date move;
 *   the amount moved is exactly how far `fromDate` lags behind `today`
 * @param today the current calendar date (UTC authority, from the server)
 * @param examDate the plan's exam date; nothing may land after it
 */
export function computeShift(
  items: readonly ShiftableItem[],
  fromDate: string,
  today: string,
  examDate: string,
): ShiftResult {
  const windowItems = items.filter(
    (item) => item.done_at === null && compareIso(item.item_date, fromDate) >= 0,
  );

  if (windowItems.length === 0) {
    return { updates: [], moved: 0, past_exam_date: 0 };
  }

  const shiftDays = Math.max(0, diffDays(fromDate, today));

  const updates: PlannedMove[] = [];
  let pastExamDate = 0;

  for (const item of windowItems) {
    const raw = addDaysIso(item.item_date, shiftDays);
    if (compareIso(raw, examDate) > 0) {
      // The full shift would carry this item past the exam: it lands on the
      // exam date instead, and the count tells the caller about the squeeze.
      pastExamDate += 1;
    }
    const clamped = compareIso(raw, examDate) > 0 ? examDate : raw;
    if (clamped !== item.item_date) {
      updates.push({ id: item.id, item_date: clamped });
    }
  }

  return { updates, moved: updates.length, past_exam_date: pastExamDate };
}

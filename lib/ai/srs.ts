/**
 * SM-2-lite — the flashcard review schedule (PR-14).
 *
 * One fixed table, no research ambitions: `again` sends a card back to the
 * start of its schedule, `got_it` walks it up 1 / 3 / 7 / 14 / 30 days
 * (capped at 30). Ease only ever moves on `again` (−0.2, floor 1.3), so the
 * schedule is fully determined by the streak.
 *
 * The database is the authority: `review_card` (0019) computes the same
 * table inside the RPC, and an integration test freezes both copies against
 * each other. This module is the unit-testable mirror the UI and docs read.
 */

export type FlashcardGrade = "again" | "got_it";

/** Interval (days) earned at each `got_it` streak, capped at the last entry. */
export const SRS_INTERVALS_DAYS = [1, 3, 7, 14, 30] as const;

/** An `again` card returns to the session after this many minutes. */
export const SRS_AGAIN_DELAY_MINUTES = 10;

export const SRS_DEFAULT_EASE = 2.5;
export const SRS_MIN_EASE = 1.3;
export const SRS_EASE_PENALTY = 0.2;

export type SrsState = {
  streak: number;
  ease: number;
  intervalDays: number;
  /** Always strictly in the future relative to `now`. */
  nextReviewAt: Date;
};

export type PreviousReview = {
  streak: number;
  ease: number;
  intervalDays: number;
} | null;

/**
 * The next schedule state for one grade. `previous` is null for a card that
 * has never been reviewed. Pure: same inputs, same output.
 */
export function nextReviewState(
  previous: PreviousReview,
  grade: FlashcardGrade,
  now: Date,
): SrsState {
  if (grade === "again") {
    const ease = Math.max(SRS_MIN_EASE, (previous?.ease ?? SRS_DEFAULT_EASE) - SRS_EASE_PENALTY);
    return {
      streak: 0,
      ease: roundEase(ease),
      intervalDays: 0,
      nextReviewAt: new Date(now.getTime() + SRS_AGAIN_DELAY_MINUTES * 60_000),
    };
  }

  const streak = (previous?.streak ?? 0) + 1;
  const intervalIndex = Math.min(streak, SRS_INTERVALS_DAYS.length) - 1;
  const intervalDays = SRS_INTERVALS_DAYS[intervalIndex];
  return {
    streak,
    ease: roundEase(previous?.ease ?? SRS_DEFAULT_EASE),
    intervalDays,
    nextReviewAt: new Date(now.getTime() + intervalDays * 86_400_000),
  };
}

/** Postgres `real` stores single-precision; keep JS in the same shape. */
export function roundEase(ease: number): number {
  return Math.round(ease * 1000) / 1000;
}

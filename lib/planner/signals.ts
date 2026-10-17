/**
 * Planner signals (PR-15 §"context": the plan is personalised from what
 * already exists, not from a fresh interview).
 *
 * PR-16's `analytics_me` view is not merged yet — the spec's hard gate says
 * the signals must be wired to the *merged* tables in the same PR instead
 * of being stubbed, so this module reads `study_goals` and
 * `quiz_attempts`/`study_artifacts` directly through the caller's own RLS
 * session (own rows only; no service-role reads of another user's data).
 *
 * Every field is nullable on purpose: a student with no goals or no quiz
 * attempts simply has no signal for it, and the prompt omits the attribute
 * rather than inventing a neutral-looking number.
 *
 * `focus_minutes` is a documented seam: `focus_sessions` (PR-03) carries no
 * `user_id`, so focus time cannot be attributed to a user from a session
 * without a room-ownership hop the spec did not sanction. It stays `null`
 * with the rest of the object shaped for PR-16 to fill in later.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type PlannerSignals = {
  goal_completion_rate: number | null;
  goals_completed: number | null;
  goals_active: number | null;
  quiz_accuracy: number | null;
  quiz_attempts: number | null;
  /** Difficulty with the lowest accuracy across attempts (easy|medium|hard). */
  weak_difficulty: string | null;
  focus_minutes: number | null;
};

export const EMPTY_SIGNALS: PlannerSignals = {
  goal_completion_rate: null,
  goals_completed: null,
  goals_active: null,
  quiz_accuracy: null,
  quiz_attempts: null,
  weak_difficulty: null,
  focus_minutes: null,
};

/** Two-decimal rounding the prompt and tests both expect (0.75, 0.33). */
function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }
  return Math.round((numerator / denominator) * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Assembles the signal set for one user. Both reads are owner-scoped RLS
 * selects; a query failure returns `EMPTY_SIGNALS` — signals enrich the
 * prompt, they are never a reason to fail a plan generation.
 */
export async function assembleSignals(
  client: SupabaseClient,
  userId: string,
): Promise<PlannerSignals> {
  const [goals, attempts] = await Promise.all([
    client.from("study_goals").select("status").eq("user_id", userId),
    client
      .from("quiz_attempts")
      .select("score, total, study_artifacts(difficulty)")
      .eq("user_id", userId),
  ]);

  const signals: PlannerSignals = { ...EMPTY_SIGNALS };

  if (!goals.error && Array.isArray(goals.data)) {
    const completed = goals.data.filter((row) => row.status === "completed").length;
    const total = goals.data.length;
    signals.goals_completed = completed;
    signals.goals_active = total - completed;
    signals.goal_completion_rate = rate(completed, total);
  }

  if (!attempts.error && Array.isArray(attempts.data)) {
    let scoreSum = 0;
    let totalSum = 0;
    let attemptCount = 0;
    const byDifficulty = new Map<string, { score: number; total: number }>();

    for (const row of attempts.data) {
      if (!isRecord(row)) {
        continue;
      }
      const score = typeof row.score === "number" ? row.score : 0;
      const total = typeof row.total === "number" ? row.total : 0;
      attemptCount += 1;
      scoreSum += score;
      totalSum += total;

      // PostgREST embeds the to-one `study_artifacts` row as an object (or,
      // defensively, a one-element array) — same tolerance the generate
      // flow applies to `study_ai_documents`.
      const embedded = row.study_artifacts;
      const artifact = isRecord(embedded)
        ? embedded
        : Array.isArray(embedded) && isRecord(embedded[0])
          ? embedded[0]
          : null;
      const difficulty = artifact?.difficulty;
      if (typeof difficulty === "string" && difficulty.length > 0) {
        const bucket = byDifficulty.get(difficulty) ?? { score: 0, total: 0 };
        bucket.score += score;
        bucket.total += total;
        byDifficulty.set(difficulty, bucket);
      }
    }

    signals.quiz_attempts = attemptCount;
    signals.quiz_accuracy = rate(scoreSum, totalSum);

    let weakest: { difficulty: string; accuracy: number } | null = null;
    for (const [difficulty, bucket] of byDifficulty) {
      const accuracy = bucket.score / bucket.total;
      if (bucket.total > 0 && (weakest === null || accuracy < weakest.accuracy)) {
        weakest = { difficulty, accuracy };
      }
    }
    signals.weak_difficulty = weakest?.difficulty ?? null;
  }

  return signals;
}

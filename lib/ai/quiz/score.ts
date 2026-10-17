/**
 * Deterministic server-side quiz scoring (PR-14).
 *
 * The answer key lives in `study_artifacts.payload`; the client submits only
 * its chosen indices. Scoring is all-or-nothing per question — an answer is
 * correct iff the chosen index equals `correct_index`; a missing or non-
 * integer answer (null / -1 / absent) is wrong, never skipped. The same
 * logic runs inside the `record_attempt` RPC (0019) as the database
 * authority; this module is the unit-tested mirror the route and tests read.
 *
 * `results` carries the per-question explanation and citations from the
 * payload so the completion screen never needs the client to have kept the
 * answer key around.
 */

import type { QuizPayload } from "./validate";

export type AnswerResult = {
  ordinal: number;
  chosen: number | null;
  correct_index: number;
  explanation: string;
  citations: { n: number; page?: number }[];
};

export type QuizScore = {
  score: number;
  total: number;
  correct: boolean[];
  results: AnswerResult[];
};

/**
 * Scores one attempt. `answers[i]` is the chosen option index for question
 * `i`; anything that is not a non-negative integer within the question's
 * option range counts as unanswered (wrong).
 */
export function scoreQuiz(payload: QuizPayload, answers: readonly unknown[]): QuizScore {
  const correct: boolean[] = [];
  const results: AnswerResult[] = [];
  let score = 0;

  payload.questions.forEach((question, ordinal) => {
    const raw = answers[ordinal];
    const chosen = typeof raw === "number" && Number.isInteger(raw) && raw >= 0
      && raw < question.options.length
      ? raw
      : null;
    const isCorrect = chosen === question.correct_index;
    if (isCorrect) {
      score += 1;
    }
    correct.push(isCorrect);
    results.push({
      ordinal,
      chosen,
      correct_index: question.correct_index,
      explanation: question.explanation,
      citations: question.citations,
    });
  });

  return { score, total: payload.questions.length, correct, results };
}

/**
 * The exam-target vocabulary — the single source settings and room creation
 * both read, so the multi-select on `/settings` and the exam-track field on
 * the create-room form can never drift apart.
 *
 * This list is deliberately closed: `PATCH /api/profile` rejects any value
 * outside it (`400 validation`), which is what keeps later filtering over
 * `exam_targets` coherent. Widening the list is a one-file change (plus this
 * constant's tests) — no migration, because the database stores the column
 * as free-form JSON and only the API enforces membership.
 *
 * Seeded from the exams the product already names (NEET/JEE/UPSC in the PR
 * spec, JEE/NEET in the test fixtures); expanding it is a standing product
 * question, not an engineering one.
 */
export const EXAM_TRACKS = [
  "NEET",
  "JEE",
  "UPSC",
  "SSC",
  "CAT",
  "GATE",
] as const;

export type ExamTrack = (typeof EXAM_TRACKS)[number];

/** `exam_targets` holds at most three selections (0–3). */
export const EXAM_TRACK_MAX_SELECTIONS = 3;

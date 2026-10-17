/**
 * Request validation for quiz/deck generation and practice (PR-14).
 *
 * Counts are a closed set per mode (quiz 5/10/15/20, deck 10/20/40) — the
 * same domain 0019 enforces inside `create_artifact`, so a route that
 * somehow skipped validation still cannot write an out-of-domain row.
 */

import { z } from "zod";

export const QUIZ_COUNTS = [5, 10, 15, 20] as const;
export const DECK_COUNTS = [10, 20, 40] as const;
export const GENERATE_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const QUESTION_TYPES = ["mcq", "tf"] as const;
export const FLASHCARD_GRADES = ["again", "got_it"] as const;

export const GENERATE_MAX_RESOURCE_IDS = 25;
export const MAX_DURATION_MS = 86_400_000;

export const artifactIdSchema = z.uuid();

/** `flashcards` is accepted as the user-facing alias of the stored kind `deck`. */
export const generateBodySchema = z
  .object({
    mode: z.enum(["quiz", "deck", "flashcards"], {
      error: "Choose quiz or flashcards.",
    }),
    resource_ids: z
      .array(z.uuid("That resource id is not valid."))
      .min(1, "Select at least one document.")
      .max(GENERATE_MAX_RESOURCE_IDS, "Select at most 25 documents.")
      .optional(),
    count: z.coerce
      .number({ error: "Choose how many questions or cards to generate." })
      .int("Choose how many questions or cards to generate.")
      .refine(
        (value) => (QUIZ_COUNTS as readonly number[]).includes(value)
          || (DECK_COUNTS as readonly number[]).includes(value),
        "Choose 5, 10, 15 or 20 questions — or 10, 20 or 40 cards.",
      ),
    difficulty: z.enum(GENERATE_DIFFICULTIES, {
      error: "Choose easy, medium or hard.",
    }),
    question_types: z
      .array(z.enum(QUESTION_TYPES, { error: "Question types are mcq or tf." }))
      .min(1, "Choose at least one question type.")
      .max(2, "Choose at most two question types.")
      .optional(),
  })
  .strict();

export const attemptBodySchema = z
  .object({
    answers: z
      .array(
        z
          .number({ error: "Each answer must be an option index." })
          .int("Each answer must be an option index.")
          .min(-1, "Answer indices start at 0.")
          .max(3, "Answer indices stop at 3."),
      )
      .max(20, "Quizzes have at most 20 questions."),
    duration_ms: z.coerce
      .number({ error: "Duration must be a number of milliseconds." })
      .int("Duration must be a number of milliseconds.")
      .min(0, "Duration cannot be negative.")
      .max(MAX_DURATION_MS, "Duration cannot exceed one day.")
      .optional(),
  })
  .strict();

export const reviewBodySchema = z
  .object({
    card_ordinal: z.coerce
      .number({ error: "Card ordinal must be a number." })
      .int("Card ordinal must be a number.")
      .min(0, "Card ordinals start at 0."),
    grade: z.enum(FLASHCARD_GRADES, {
      error: "Grade a card as again or got_it.",
    }),
  })
  .strict();

export const artifactsQuerySchema = z
  .object({
    kind: z.enum(["quiz", "deck"], {
      error: "Kind must be quiz or deck.",
    }).optional(),
  })
  .strict();

export type GenerateBody = z.infer<typeof generateBodySchema>;
export type AttemptBody = z.infer<typeof attemptBodySchema>;
export type ReviewBody = z.infer<typeof reviewBodySchema>;
export type ArtifactsQuery = z.infer<typeof artifactsQuerySchema>;

/** The stored artifact kind for a request mode (`flashcards` → `deck`). */
export function artifactKindFor(mode: GenerateBody["mode"]): "quiz" | "deck" {
  return mode === "quiz" ? "quiz" : "deck";
}

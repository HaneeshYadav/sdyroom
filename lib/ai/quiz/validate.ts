/**
 * Parse-and-validate gate for generated quiz/deck payloads (PR-14).
 *
 * Model output is untrusted data: it is parsed, schema-checked with Zod,
 * then business-checked (declared counts, unique prompts, option rules,
 * correct-index range). Structural failures throw `GenerationValidationError`
 * and the caller fails the artifact with `ai_provider_failed` — a half-
 * parsed payload never becomes `ready`. Citation entries that do not point
 * at a real retrieved source are stripped (the soft rule PR-13 established);
 * everything else is hard.
 */

import { z } from "zod";

export class GenerationValidationError extends Error {
  readonly code = "ai_provider_failed" as const;
}

const citationSchema = z
  .object({
    // Any integer is accepted here; out-of-range entries are *stripped* by
    // `stripInvalidCitations` (the soft rule PR-13 established), not a
    // hard failure — a model occasionally citing [0] or an id it invented
    // should not discard an otherwise valid question.
    n: z.number().int(),
    page: z.number().int().min(1).optional(),
  })
  .strip();

const quizQuestionSchema = z
  .object({
    type: z.enum(["mcq", "tf"]),
    prompt: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(4),
    correct_index: z.number().int().min(0).max(3),
    explanation: z.string().trim().min(1).max(1000),
    citations: z.array(citationSchema).max(25).default([]),
  })
  .strip();

const deckCardSchema = z
  .object({
    front: z.string().trim().min(1).max(1000),
    back: z.string().trim().min(1).max(2000),
    citations: z.array(citationSchema).max(25).default([]),
  })
  .strip();

export const quizPayloadSchema = z.object({ questions: z.array(quizQuestionSchema).min(1).max(20) }).strip();
export const deckPayloadSchema = z.object({ cards: z.array(deckCardSchema).min(1).max(40) }).strip();

export type QuizQuestionPayload = z.infer<typeof quizQuestionSchema>;
export type DeckCardPayload = z.infer<typeof deckCardSchema>;
export type QuizPayload = z.infer<typeof quizPayloadSchema>;
export type DeckPayload = z.infer<typeof deckPayloadSchema>;

export type SourceCitation = { n: number; page?: number };

/**
 * Strips citation entries that do not reference a retrieved source (n must
 * be 1..sourceCount). A question with no surviving citations keeps an empty
 * array — the same rule as PR 13's answer finalization.
 */
export function stripInvalidCitations<T extends { citations: SourceCitation[] }>(
  items: T[],
  sourceCount: number,
): T[] {
  return items.map((item) => ({
    ...item,
    citations: item.citations.filter((citation) => citation.n >= 1 && citation.n <= sourceCount),
  }));
}

function invalid(message: string): never {
  throw new GenerationValidationError(message);
}

/**
 * Parses raw model text into a quiz payload. Accepts a JSON object or one
 * fenced block; anything else is rejected. Business rules: exactly
 * `expectedCount` questions, distinct prompts, mcq → 4 unique options,
 * tf → exactly ["True","False"], correct_index in range.
 */
export function parseQuizPayload(
  rawText: string,
  options: { expectedCount: number; sourceCount: number },
): QuizPayload {
  const parsed = quizPayloadSchema.safeParse(parseJsonObject(rawText));
  if (!parsed.success) {
    invalid("Quiz payload failed schema validation.");
  }

  const questions = parsed.data.questions;
  if (questions.length !== options.expectedCount) {
    invalid(`Expected ${options.expectedCount} questions, received ${questions.length}.`);
  }

  const seenPrompts = new Set<string>();
  for (const question of questions) {
    const promptKey = question.prompt.toLowerCase();
    if (seenPrompts.has(promptKey)) {
      invalid("Duplicate question prompt in generated quiz.");
    }
    seenPrompts.add(promptKey);

    if (question.type === "mcq") {
      if (question.options.length !== 4) {
        invalid("MCQ questions need exactly 4 options.");
      }
      if (new Set(question.options.map((option) => option.toLowerCase())).size !== 4) {
        invalid("MCQ options must be unique.");
      }
    } else {
      const normalized = question.options.map((option) => option.toLowerCase());
      if (
        question.options.length !== 2
        || !normalized.includes("true")
        || !normalized.includes("false")
      ) {
        invalid('True/false questions need exactly the options "True" and "False".');
      }
    }

    if (question.correct_index >= question.options.length) {
      invalid("correct_index is out of range.");
    }
  }

  return { questions: stripInvalidCitations(questions, options.sourceCount) };
}

/**
 * Parses raw model text into a deck payload: exactly `expectedCount` cards,
 * distinct fronts.
 */
export function parseDeckPayload(
  rawText: string,
  options: { expectedCount: number; sourceCount: number },
): DeckPayload {
  const parsed = deckPayloadSchema.safeParse(parseJsonObject(rawText));
  if (!parsed.success) {
    invalid("Deck payload failed schema validation.");
  }

  const cards = parsed.data.cards;
  if (cards.length !== options.expectedCount) {
    invalid(`Expected ${options.expectedCount} cards, received ${cards.length}.`);
  }

  const seenFronts = new Set<string>();
  for (const card of cards) {
    const frontKey = card.front.toLowerCase();
    if (seenFronts.has(frontKey)) {
      invalid("Duplicate card front in generated deck.");
    }
    seenFronts.add(frontKey);
  }

  return { cards: stripInvalidCitations(cards, options.sourceCount) };
}

/**
 * Model output must be JSON. Tolerates one surrounding ```json fence (a
 * common slip) but nothing else — prose around the object is a hard failure,
 * because silently salvaging it would hide malformed generations.
 */
export function parseJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    invalid("Model output was not valid JSON.");
  }
}

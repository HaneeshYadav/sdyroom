import { z } from "zod";

import {
  EXAM_TRACKS,
  EXAM_TRACK_MAX_SELECTIONS,
} from "@/lib/vocab/exam-tracks";
import { LANGUAGES } from "@/lib/vocab/languages";

export const ALIAS_MIN_LENGTH = 1;
export const ALIAS_MAX_LENGTH = 32;

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

/**
 * Study alias shown in the app. Mirrors `profiles.alias` in 0001_init.sql
 * (trimmed, 1-32 characters) and adds a friendlier character set so aliases
 * stay readable in room listings. Uniqueness is case-insensitive in the
 * database via a unique index on `lower(alias)`; conflicts surface as 23505.
 */
export const aliasSchema = z
  .string()
  .trim()
  .min(ALIAS_MIN_LENGTH, "Study alias is required")
  .max(
    ALIAS_MAX_LENGTH,
    `Study alias must be ${ALIAS_MAX_LENGTH} characters or fewer`,
  )
  .regex(
    ALIAS_PATTERN,
    "Study alias must start with a letter or number and use only letters, numbers, spaces, hyphens or underscores",
  );

export const onboardingSchema = z.object({
  alias: aliasSchema,
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;

/**
 * Exam targets: 0–3 selections from the shared closed vocabulary
 * (`lib/vocab/exam-tracks.ts`), the same array the room-create form offers.
 * The API is the enforcement point the DB does not have — `profiles
 * .exam_targets` is only checked as "a JSON array" — so a hand-crafted body
 * outside this list must fail here with a 400.
 */
export const examTargetsSchema = z
  .array(z.enum(EXAM_TRACKS))
  .max(
    EXAM_TRACK_MAX_SELECTIONS,
    `Choose up to ${EXAM_TRACK_MAX_SELECTIONS} exam targets.`,
  );

/** Preferred language from the shared closed vocabulary; `null` clears it. */
export const languageSchema = z.enum(LANGUAGES);

/**
 * `PATCH /api/profile` — partial and strict: every field optional, unknown
 * fields (including `id`, `user_id`, `email`, `created_at`) rejected by
 * `.strict()` with a 400 naming the offender rather than silently ignored.
 *
 * `language` is nullable so the settings form can clear the choice; `null`
 * and "absent" are different on purpose (clear vs. leave unchanged).
 * Whether the body held *any* field is the route's `invalid_request` rule,
 * checked against the raw input before parsing.
 */
export const updateProfileSchema = z
  .object({
    alias: aliasSchema.optional(),
    exam_targets: examTargetsSchema.optional(),
    language: languageSchema.nullable().optional(),
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

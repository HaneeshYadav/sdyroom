import { z } from "zod";

import {
  addDaysIso,
  examWindowBounds,
  EXAM_WINDOW_MESSAGE,
  isCalendarDate,
  utcTodayIso,
} from "@/lib/planner/dates";

/**
 * Request schemas for the planner API (PR 15). These are the first gate for
 * every body that reaches `lib/planner/plans.ts`; the `create_plan` and
 * `generate_plan` RPCs re-validate the same domain inside the database, so
 * a bypassed route still cannot widen anything.
 *
 * Deliberately no identity fields: `user_id` comes from the verified
 * session only (security requirement 1), and the column grants would
 * refuse a forged one anyway.
 */

export const PLAN_TOPIC_MAX = 25;
export const PLAN_TOPIC_LENGTH_MAX = 60;
export const PLAN_DOCUMENTS_MAX = 25;
export const PLAN_HOURS_MIN = 1;
export const PLAN_HOURS_MAX = 12;
export const PLAN_SUMMARY_MAX = 300;

const uuidMessage = "That id is not valid.";

function calendarDateSchema(message: string) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be formatted YYYY-MM-DD.")
    .refine(isCalendarDate, message);
}

/** Exam date: a real date in `[today+1, today+180]` (UTC authority). */
export const examDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Exam date must be formatted YYYY-MM-DD.")
  .refine(isCalendarDate, "That is not a real calendar date.")
  .refine((value) => {
    const today = utcTodayIso();
    const { min, max } = examWindowBounds(today);
    return value >= min && value <= max;
  }, EXAM_WINDOW_MESSAGE);

/** Any calendar date (used for shift windows and complete-day targets). */
export const planDateSchema = calendarDateSchema(
  "That is not a real calendar date.",
);

export const planIdSchema = z.uuid(uuidMessage);
export const planItemIdSchema = z.uuid(uuidMessage);

export const planStatusSchema = z.enum([
  "active",
  "generating",
  "failed",
  "archived",
]);

export const planStatusFilterSchema = planStatusSchema.optional();

/**
 * Body of `POST /api/plans`. `.strict()` rejects unknown fields — there is
 * deliberately no `user_id` here: the identity comes from the verified
 * session, and the column grants would refuse a forged one anyway.
 */
export const createPlanSchema = z
  .object({
    exam_date: examDateSchema,
    hours_per_day: z
      .number()
      .min(PLAN_HOURS_MIN, `Hours per day must be at least ${PLAN_HOURS_MIN}.`)
      .max(PLAN_HOURS_MAX, `Hours per day must be at most ${PLAN_HOURS_MAX}.`),
    topics: z
      .array(
        z
          .string()
          .trim()
          .min(1, "Topics cannot be empty.")
          .max(
            PLAN_TOPIC_LENGTH_MAX,
            `Each topic must be ${PLAN_TOPIC_LENGTH_MAX} characters or fewer.`,
          ),
      )
      .max(
        PLAN_TOPIC_MAX,
        `You can name at most ${PLAN_TOPIC_MAX} topics.`,
      )
      .default([]),
    room_id: z.uuid(uuidMessage).optional(),
    document_ids: z
      .array(z.uuid(uuidMessage))
      .max(
        PLAN_DOCUMENTS_MAX,
        `You can ground a plan in at most ${PLAN_DOCUMENTS_MAX} documents.`,
      )
      .default([]),
    regenerate: z.boolean().default(false),
  })
  .strict();

export type CreatePlanBody = z.infer<typeof createPlanSchema>;

/** Body of `POST /api/plans/[planId]/items/[itemId]/done`. */
export const markItemDoneSchema = z
  .object({
    done: z.boolean().default(true),
  })
  .strict();

export type MarkItemDoneBody = z.infer<typeof markItemDoneSchema>;

/**
 * Body of `POST /api/plans/[planId]/shift`. `mode` is fixed in v1 — the
 * only adjustment the spec defines ("I missed today": move what remains
 * from `from_date` forward). The dates themselves are computed
 * deterministically server-side in `lib/planner/shift.ts`.
 */
export const shiftPlanSchema = z
  .object({
    from_date: planDateSchema,
    mode: z.literal("shift_remaining").optional(),
  })
  .strict();

export type ShiftPlanBody = z.infer<typeof shiftPlanSchema>;

/** Body of `POST /api/plans/[planId]/complete-day`. */
export const completeDaySchema = z
  .object({
    date: planDateSchema,
  })
  .strict();

export type CompleteDayBody = z.infer<typeof completeDaySchema>;

/**
 * The exam window as `[min, max]` strings for UI hints (date-input min/max)
 * — same computation the schema above enforces, shared with the form.
 */
export function examDateInputBounds(today: string = utcTodayIso()): {
  min: string;
  max: string;
} {
  const { min, max } = examWindowBounds(today);
  return { min, max: addDaysIso(max, 0) };
}

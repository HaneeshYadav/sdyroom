import { z } from "zod";

import { INGEST_STEPS } from "@/lib/ai/types";

/** How many stuck rows one sweep call may advance (spec default: 10). */
export const SWEEP_LIMIT_DEFAULT = 10;
export const SWEEP_LIMIT_MAX = 50;

/**
 * Body of `POST /api/ai/ingest/[resourceId]`.
 *
 * Empty body means `{"step":"auto"}` — the resumable default the client loop
 * and the sweep both use. `.strict()`: every other field would silently be
 * ignored, and a request that *looks* like it addressed, say, a forced re-run
 * (`{ "force": true }`) must be refused rather than half-honoured.
 */
export const ingestStepSchema = z
  .object({
    step: z.enum(INGEST_STEPS).default("auto"),
  })
  .strict();

/**
 * Body of `POST /api/ai/ingest/sweep`.
 *
 * `room_id` narrows the sweep to one room the caller belongs to (membership is
 * checked against RLS visibility, not trusted from the body); absent sweeps
 * everything the caller can see. Unknown fields are rejected for the same
 * reason as above.
 */
export const ingestSweepSchema = z
  .object({
    room_id: z.uuid("That room id is not valid.").optional(),
    limit: z.coerce
      .number()
      .int("Limit must be a whole number.")
      .min(1, "Limit must be at least 1.")
      .max(SWEEP_LIMIT_MAX, `Limit must be at most ${SWEEP_LIMIT_MAX}.`)
      .default(SWEEP_LIMIT_DEFAULT),
  })
  .strict();

/** Query of `GET /api/ai/usage` — optional room scope. */
export const aiUsageQuerySchema = z
  .object({
    room_id: z.uuid("That room id is not valid.").optional(),
  })
  .strict();

export type IngestStepInput = z.infer<typeof ingestStepSchema>;
export type IngestSweepInput = z.infer<typeof ingestSweepSchema>;
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;

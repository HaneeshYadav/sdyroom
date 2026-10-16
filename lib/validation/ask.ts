import { z } from "zod";

/** How many resource ids one question may narrow the search to. */
export const ASK_MAX_RESOURCE_IDS = 25;

/**
 * Body of `POST /api/rooms/[id]/ask`.
 *
 * The question is trimmed then bounded to the spec's 1–2000 characters;
 * `resource_ids` optionally narrows retrieval to a subset of the room's
 * indexed documents (membership and RLS are re-checked server-side, never
 * trusted from the body); `conversation_id` is a client-generated uuid that
 * groups turns into one conversation. `.strict()`: an unknown field is a
 * mistake that must be refused, not silently ignored.
 */
export const askBodySchema = z
  .object({
    question: z
      .string("Ask a question first.")
      .trim()
      .min(1, "Ask a question first.")
      .max(2000, "Questions are limited to 2000 characters."),
    resource_ids: z
      .array(z.uuid("That resource id is not valid."))
      .max(ASK_MAX_RESOURCE_IDS, `Choose at most ${ASK_MAX_RESOURCE_IDS} documents.`)
      .optional(),
    conversation_id: z.uuid("That conversation id is not valid.").optional(),
  })
  .strict();

/** Query of `GET /api/rooms/[id]/ask/history` — opaque cursor + limit. */
export const askHistoryQuerySchema = z
  .object({
    cursor: z.string().min(1).max(400).optional(),
    limit: z.coerce
      .number()
      .int("Limit must be a whole number.")
      .min(1, "Limit must be at least 1.")
      .max(50, "Limit must be at most 50.")
      .default(20),
  })
  .strict();

export type AskBody = z.infer<typeof askBodySchema>;
export type AskHistoryQuery = z.infer<typeof askHistoryQuerySchema>;

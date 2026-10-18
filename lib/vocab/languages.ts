/**
 * The preferred-language vocabulary — the single source settings and room
 * creation both read, so the language select on `/settings` and the language
 * field on the create-room form can never drift apart.
 *
 * Closed on purpose: `PATCH /api/profile` rejects anything outside this list
 * (`400 validation`), and the room-create form offers exactly these options,
 * which is what keeps the discovery language filter coherent as data
 * accumulates. The database column (0023) only enforces trimmed length —
 * widening the list here is enough, no migration needed.
 *
 * Values are display-cased strings rather than opaque codes: the app renders
 * them raw in filters and rosters today ("English" in the fixtures), so the
 * string *is* the presentation. Expanding the list is a standing product
 * question.
 */
export const LANGUAGES = [
  "English",
  "Hindi",
  "Hinglish",
  "Telugu",
  "Tamil",
] as const;

export type Language = (typeof LANGUAGES)[number];

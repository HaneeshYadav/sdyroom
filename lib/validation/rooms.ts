import { z } from "zod";

export const ROOM_NAME_MIN = 1;
export const ROOM_NAME_MAX = 100;
export const CAPACITY_MIN = 1;
export const CAPACITY_MAX = 100;
export const CAPACITY_DEFAULT = 4;
export const EXAM_TRACK_MAX = 80;
export const SUBJECT_MAX = 80;
export const LANGUAGE_MAX = 40;
export const SHARED_GOAL_MAX = 500;
export const ROOM_QUERY_MAX = 100;

export const roomVisibilitySchema = z.enum(["public", "private"]);
export const roomStatusSchema = z.enum(["open", "closed"]);

/**
 * Discovery sort orders (PR 17). `relevance` is only valid together with a
 * query — the database enforces that too (`22023`), this schema keeps the
 * error at the edge where it belongs.
 */
export const ROOM_SORTS = [
  "recent",
  "active",
  "largest",
  "name",
  "relevance",
] as const;
export const roomSortSchema = z.enum(ROOM_SORTS);
export type RoomSort = z.infer<typeof roomSortSchema>;

export const ROOM_LIMIT_DEFAULT = 20;
export const ROOM_LIMIT_MAX = 50;
export const MIN_MEMBERS_MAX = 100;
export const ROOM_CURSOR_MAX = 2000;

/**
 * Optional free text: trimmed, length-checked after trimming (matching the
 * CHECK constraints in 0001_init.sql), then normalised to null — whether the
 * field is missing or blank — so the RPC stores NULL instead of an empty
 * string.
 */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .optional()
    .transform((value) => (value === undefined || value === "" ? null : value));

/**
 * Every user-supplied room field. There is deliberately no owner id: the
 * database derives the owner from auth.uid() inside create_room().
 */
export const createRoomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(ROOM_NAME_MIN, "Room name is required")
    .max(ROOM_NAME_MAX, `Room name must be ${ROOM_NAME_MAX} characters or fewer`),
  capacity: z
    .coerce.number()
    .int("Capacity must be a whole number")
    .min(CAPACITY_MIN, `Capacity must be at least ${CAPACITY_MIN}`)
    .max(CAPACITY_MAX, `Capacity must be at most ${CAPACITY_MAX}`)
    .default(CAPACITY_DEFAULT),
  visibility: roomVisibilitySchema.default("public"),
  exam_track: optionalText(EXAM_TRACK_MAX, "Exam track"),
  subject: optionalText(SUBJECT_MAX, "Subject"),
  language: optionalText(LANGUAGE_MAX, "Language"),
  shared_goal: optionalText(SHARED_GOAL_MAX, "Shared goal"),
  status: roomStatusSchema.default("open"),
});

/**
 * Discovery query for `GET /api/rooms` and the browse page (PR 17). Every
 * value is normalised before it reaches the RPC: text filters trim and blank
 * out, numbers coerce then bound, `sort` must be one of the five orders, and
 * `cursor` is length-capped here and shape-validated per sort at the route
 * (it carries sort key values, so its shape depends on the resolved sort).
 * Unknown searchParams keys are ignored, not rejected — shareable URLs grow
 * extra tracking junk without breaking the reader.
 */
export const roomDiscoverySchema = z.object({
  q: z
    .string()
    .trim()
    .max(ROOM_QUERY_MAX, `Search must be ${ROOM_QUERY_MAX} characters or fewer`)
    .default(""),
  subject: z
    .string()
    .trim()
    .max(SUBJECT_MAX, `Subject must be ${SUBJECT_MAX} characters or fewer`)
    .optional()
    .transform((value) =>
      value === undefined || value === "" ? null : value,
    ),
  exam_track: z
    .string()
    .trim()
    .max(EXAM_TRACK_MAX, `Exam track must be ${EXAM_TRACK_MAX} characters or fewer`)
    .optional()
    .transform((value) =>
      value === undefined || value === "" ? null : value,
    ),
  language: z
    .string()
    .trim()
    .max(LANGUAGE_MAX, `Language must be ${LANGUAGE_MAX} characters or fewer`)
    .optional()
    .transform((value) =>
      value === undefined || value === "" ? null : value,
    ),
  min_members: z.coerce
    .number()
    .int("Minimum members must be a whole number")
    .min(0, "Minimum members cannot be negative")
    .max(MIN_MEMBERS_MAX, `Minimum members must be at most ${MIN_MEMBERS_MAX}`)
    .default(0),
  sort: roomSortSchema.optional(),
  limit: z.coerce
    .number()
    .int("Limit must be a whole number")
    .min(1, "Limit must be at least 1")
    .max(ROOM_LIMIT_MAX, `Limit must be at most ${ROOM_LIMIT_MAX}`)
    .default(ROOM_LIMIT_DEFAULT),
  cursor: z
    .string()
    .max(ROOM_CURSOR_MAX, "Cursor is too long")
    .optional(),
});

/**
 * The same optional text rule as on create, but as a *patch* value: absent
 * means "leave it alone" (the key never appears in the parsed output, so it
 * is dropped from the RPC's change set), while `null` or a blank string
 * means "clear it". Length and trim still apply before the database's CHECK
 * constraints would.
 */
const optionalTextPatch = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .nullable()
    .optional()
    .transform((value) =>
      value === undefined ? undefined : value === null || value === "" ? null : value,
    );

/**
 * Body of `PATCH /api/rooms/[id]` — the owner's edit form. `.strict()`
 * refuses unknown fields (`owner_id`, `visibility`, `id`, `created_at`,
 * `updated_at` are not addressable here, and the database holds no UPDATE
 * grant for them either), and `.partial()` makes every listed field optional
 * so a PATCH carries only what changed. An empty object parses successfully
 * and the route rejects it with `invalid_request`, matching the goals PATCH.
 *
 * `name` has no default and no blank→null transform: a room always has a
 * name, so an empty string is a validation error rather than a clear.
 */
export const updateRoomSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(ROOM_NAME_MIN, "Room name is required")
      .max(ROOM_NAME_MAX, `Room name must be ${ROOM_NAME_MAX} characters or fewer`),
    capacity: z
      .coerce.number()
      .int("Capacity must be a whole number")
      .min(CAPACITY_MIN, `Capacity must be at least ${CAPACITY_MIN}`)
      .max(CAPACITY_MAX, `Capacity must be at most ${CAPACITY_MAX}`),
    status: roomStatusSchema,
    exam_track: optionalTextPatch(EXAM_TRACK_MAX, "Exam track"),
    subject: optionalTextPatch(SUBJECT_MAX, "Subject"),
    language: optionalTextPatch(LANGUAGE_MAX, "Language"),
    shared_goal: optionalTextPatch(SHARED_GOAL_MAX, "Shared goal"),
  })
  .strict()
  .partial();

/**
 * Dynamic route id for `/api/rooms/[id]/join` and `/leave`. Room ids are
 * UUIDs, so anything else is a 400 before the request reaches the database.
 */
export const roomIdSchema = z.uuid();

export type CreateRoomInput = z.infer<typeof createRoomSchema>;

export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;

export type RoomSearchInput = z.infer<typeof roomDiscoverySchema>;

/**
 * Per-sort cursor payloads the keyset pagination carries (PR 17). The wire
 * format is opaque base64url JSON; these schemas validate the decoded object
 * for the sort it will be replayed against, so a forged or truncated cursor
 * is a 400 before it reaches SQL. `i` is always the id tiebreaker.
 */
export const roomCursorRecentSchema = z.object({
  c: z.string(),
  i: z.uuid(),
});

export const roomCursorActiveSchema = z.object({
  c: z.union([z.string(), z.null()]),
  i: z.uuid(),
});

export const roomCursorLargestSchema = z.object({
  m: z.number().int().min(0),
  i: z.uuid(),
});

export const roomCursorNameSchema = z.object({
  n: z.string().min(1),
  i: z.uuid(),
});

export const roomCursorRelevanceSchema = z.object({
  r: z.number().int().min(0).max(2),
  m: z.number().int().min(0),
  i: z.uuid(),
});

export type RoomCursorRecent = z.infer<typeof roomCursorRecentSchema>;
export type RoomCursorActive = z.infer<typeof roomCursorActiveSchema>;
export type RoomCursorLargest = z.infer<typeof roomCursorLargestSchema>;
export type RoomCursorName = z.infer<typeof roomCursorNameSchema>;
export type RoomCursorRelevance = z.infer<typeof roomCursorRelevanceSchema>;

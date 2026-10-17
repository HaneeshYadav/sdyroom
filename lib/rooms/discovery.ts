import type { SupabaseClient } from "@supabase/supabase-js";
import {
  roomCursorActiveSchema,
  roomCursorLargestSchema,
  roomCursorNameSchema,
  roomCursorRecentSchema,
  roomCursorRelevanceSchema,
  type RoomCursorActive,
  type RoomCursorLargest,
  type RoomCursorName,
  type RoomCursorRecent,
  type RoomCursorRelevance,
  type RoomSearchInput,
  type RoomSort,
} from "@/lib/validation/rooms";
import type {
  DiscoveredRoom,
  RoomSummary,
  ViewerMembership,
} from "./types";

/**
 * Failure from the discovery data layer. `validation` maps to 400 (bad
 * cursor or a database-level input refusal such as `22023`), `not_found` to
 * 404 (preview), `query_failed` to 500 — SQL text never reaches a response.
 */
export class DiscoveryError extends Error {
  readonly code: "validation" | "not_found" | "query_failed";

  constructor(
    code: "validation" | "not_found" | "query_failed",
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}

const DISCOVERY_STATUS = {
  validation: 400,
  not_found: 404,
  query_failed: 500,
} as const;

export function discoveryErrorStatus(error: DiscoveryError): number {
  return DISCOVERY_STATUS[error.code];
}

/**
 * The sort a listing actually runs: an explicit choice wins; otherwise a
 * query defaults to relevance and a bare listing to recency. Mirrors the
 * database default so the page, the API and the RPC always agree on which
 * keyset the cursor belongs to. Whitespace-only queries count as absent —
 * Zod already trims at the edge, this keeps the layer safe on its own.
 */
export function resolveDiscoverySort(
  search: Pick<RoomSearchInput, "q" | "sort">,
): RoomSort {
  if (search.sort) {
    return search.sort;
  }
  return search.q.trim() ? "relevance" : "recent";
}

const CURSOR_SCHEMAS = {
  recent: roomCursorRecentSchema,
  active: roomCursorActiveSchema,
  largest: roomCursorLargestSchema,
  name: roomCursorNameSchema,
  relevance: roomCursorRelevanceSchema,
} satisfies Record<RoomSort, { safeParse: (value: unknown) => unknown }>;

type DecodedCursor = {
  recent: RoomCursorRecent;
  active: RoomCursorActive;
  largest: RoomCursorLargest;
  name: RoomCursorName;
  relevance: RoomCursorRelevance;
};

/**
 * Relevance rank for one room name against the query, mirroring the SQL:
 * 0 exact, 1 prefix, 2 anything else in the matched set. Case is folded the
 * same way (`lower` on both sides); room names are short user text where
 * SQL `lower` and `toLowerCase` agree.
 */
export function relevanceRank(name: string, q: string): 0 | 1 | 2 {
  const needle = q.trim().toLowerCase();
  const haystack = name.toLowerCase();
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  return 2;
}

/**
 * Encodes the keyset for the next page as opaque base64url JSON. The payload
 * carries only sort values and the room id — never a user id, never a filter
 * — so a decoded cursor cannot reveal anything the listing would not.
 */
export function encodeRoomCursor(
  sort: RoomSort,
  room: DiscoveredRoom,
  q: string,
): string {
  let payload: unknown;
  switch (sort) {
    case "recent":
      payload = { c: room.created_at, i: room.id };
      break;
    case "active":
      payload = { c: room.last_activity_at, i: room.id };
      break;
    case "largest":
      payload = { m: room.member_count, i: room.id };
      break;
    case "name":
      payload = { n: room.name, i: room.id };
      break;
    case "relevance":
      payload = {
        r: relevanceRank(room.name, q),
        m: room.member_count,
        i: room.id,
      };
      break;
  }
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decodes a wire cursor for the sort it will be replayed against. Anything
 * that is not valid base64url JSON matching that sort's schema throws
 * `validation`, which the route turns into a 400 before SQL sees it.
 */
export function decodeRoomCursor<K extends RoomSort>(
  sort: K,
  encoded: string,
): DecodedCursor[K] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
  } catch {
    throw new DiscoveryError("validation", "That cursor is not valid.");
  }

  const result = CURSOR_SCHEMAS[sort].safeParse(parsedJson);
  if (!result.success) {
    throw new DiscoveryError("validation", "That cursor is not valid.");
  }
  return result.data as DecodedCursor[K];
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function viewerRole(value: unknown): "owner" | "student" | null {
  return value === "owner" ? "owner" : value === "student" ? "student" : null;
}

/**
 * Maps one `list_public_rooms` row onto the public shape. Only the listed
 * fields survive, so anything else the row might carry (an owner id, a
 * future private column) can never leak into an API or page response.
 */
export function toDiscoveredRoom(
  row: Record<string, unknown>,
): DiscoveredRoom {
  return {
    id: text(row.id),
    name: text(row.name),
    shared_goal: textOrNull(row.shared_goal),
    subject: textOrNull(row.subject),
    exam_track: textOrNull(row.exam_track),
    language: textOrNull(row.language),
    status: text(row.status),
    capacity: count(row.capacity),
    member_count: count(row.member_count),
    last_activity_at: textOrNull(row.last_activity_at),
    viewer_role: viewerRole(row.viewer_role),
    created_at: text(row.created_at),
  };
}

export function toViewerMembership(
  role: "owner" | "student" | null,
): ViewerMembership {
  return role === "owner" ? "owner" : role === "student" ? "member" : "none";
}

export function toRoomSummary(room: DiscoveredRoom): RoomSummary {
  return {
    ...room,
    viewer_membership: toViewerMembership(room.viewer_role),
  };
}

export type DiscoveryPage = {
  rooms: RoomSummary[];
  has_more: boolean;
  next_cursor: string | null;
};

/**
 * One round trip through `list_public_rooms`: filter, rank, keyset and
 * enrich all happen in the database (0022). The RPC returns at most
 * `limit + 1` rows; the extra row is dropped here and only used to decide
 * `has_more`, so no second count query is needed. A database input refusal
 * (`22023`) becomes `validation`; anything else is `query_failed` — an
 * error is never reported as an empty result.
 */
export async function searchPublicRooms(
  client: SupabaseClient,
  search: RoomSearchInput,
  cursor?: string,
): Promise<DiscoveryPage> {
  const q = search.q.trim();
  const sort = resolveDiscoverySort({ q, sort: search.sort });
  const decoded = cursor ? decodeRoomCursor(sort, cursor) : null;

  const { data, error } = await client.rpc("list_public_rooms", {
    p_q: q === "" ? null : q,
    p_subject: search.subject,
    p_exam_track: search.exam_track,
    p_language: search.language,
    p_min_members: search.min_members,
    p_sort: sort,
    p_limit: search.limit,
    p_cursor: decoded,
  });

  if (error) {
    if (error.code === "22023") {
      throw new DiscoveryError("validation", "Those search options are not valid.");
    }
    throw new DiscoveryError(
      "query_failed",
      "Public rooms could not be loaded.",
    );
  }

  const rows = ((data ?? []) as Record<string, unknown>[]).map(toDiscoveredRoom);
  const hasMore = rows.length > search.limit;
  const page = hasMore ? rows.slice(0, search.limit) : rows;
  const last = page[page.length - 1];

  return {
    rooms: page.map(toRoomSummary),
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeRoomCursor(sort, last, q) : null,
  };
}

export type RoomPreview = {
  id: string;
  name: string;
  shared_goal: string | null;
  subject: string | null;
  exam_track: string | null;
  language: string | null;
  visibility: string;
  status: string;
  capacity: number;
  member_count: number;
  created_at: string;
  is_member: boolean;
  viewer_role: "owner" | "student" | null;
};

function toRoomPreview(row: Record<string, unknown>): RoomPreview {
  return {
    id: text(row.id),
    name: text(row.name),
    shared_goal: textOrNull(row.shared_goal),
    subject: textOrNull(row.subject),
    exam_track: textOrNull(row.exam_track),
    language: textOrNull(row.language),
    visibility: text(row.visibility),
    status: text(row.status),
    capacity: count(row.capacity),
    member_count: count(row.member_count),
    created_at: text(row.created_at),
    is_member: row.is_member === true,
    viewer_role: viewerRole(row.viewer_role),
  };
}

/**
 * Public-safe detail for one room through `room_preview` (0022). Returns
 * `null` for a missing room *and* for a private room the caller is not a
 * member of — the database raises the same `P0002` for both, so the route
 * cannot be used as an existence oracle even by accident. A member previewing
 * their own private room gets the row with `is_member: true`.
 */
export async function getRoomPreview(
  client: SupabaseClient,
  roomId: string,
): Promise<RoomPreview | null> {
  const { data, error } = await client.rpc("room_preview", {
    p_room_id: roomId,
  });

  if (error) {
    if (error.code === "P0002") {
      return null;
    }
    throw new DiscoveryError(
      "query_failed",
      "That room could not be loaded.",
    );
  }

  const row = ((data ?? []) as Record<string, unknown>[])[0];
  if (!row) {
    return null;
  }
  return toRoomPreview(row);
}

export type RoomFilterOptions = {
  subjects: string[];
  exam_tracks: string[];
  languages: string[];
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Distinct public values behind the subject / exam-track / language selects,
 * from `room_filter_options` (0022). Private rooms contribute nothing — not
 * even a distinct value — and the database caps each list at 100.
 */
export async function getRoomFilterOptions(
  client: SupabaseClient,
): Promise<RoomFilterOptions> {
  const { data, error } = await client.rpc("room_filter_options", {});

  if (error) {
    throw new DiscoveryError(
      "query_failed",
      "Room filters could not be loaded.",
    );
  }

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    subjects: stringList(row.subjects),
    exam_tracks: stringList(row.exam_tracks),
    languages: stringList(row.languages),
  };
}

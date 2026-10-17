import type { SupabaseClient } from "@supabase/supabase-js";
import type { UpdateRoomInput } from "@/lib/validation/rooms";
import { toPublicRoom } from "./shape";
import { PUBLIC_ROOM_COLUMNS, type PublicRoom } from "./types";

export class RoomQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomQueryError";
  }
}

/**
 * Failure carrying the HTTP status the API layer returns. Codes come from
 * `update_room` / `delete_room` envelopes (the 0002/0007 convention): SQL
 * text and constraint names never reach a response, and an unknown code
 * throws instead of being forwarded.
 */
export type RoomMutationErrorCode =
  | "not_found"
  | "not_owner"
  | "invalid_request"
  | "validation"
  | "capacity_below_membership";

export class RoomMutationError extends Error {
  readonly code: RoomMutationErrorCode;
  readonly status: number;
  /** Present only for `capacity_below_membership` — the floor that refused. */
  readonly memberCount?: number;

  constructor(
    code: RoomMutationErrorCode,
    message: string,
    status: number,
    memberCount?: number,
  ) {
    super(message);
    this.name = "RoomMutationError";
    this.code = code;
    this.status = status;
    if (memberCount !== undefined) {
      this.memberCount = memberCount;
    }
  }
}

const MUTATION_RESULTS: Record<
  string,
  { code: RoomMutationErrorCode; status: number; message: string }
> = {
  room_not_found: {
    code: "not_found",
    status: 404,
    message: "That room does not exist or is not available.",
  },
  not_owner: {
    code: "not_owner",
    status: 403,
    message: "Only the room owner can manage this room.",
  },
  invalid_request: {
    code: "invalid_request",
    status: 400,
    message: "Provide at least one field to update.",
  },
  validation: {
    code: "validation",
    status: 400,
    message: "Those room details are not valid.",
  },
};

function mutationError(envelope: {
  code?: unknown;
  member_count?: unknown;
}): RoomMutationError | null {
  const code = typeof envelope.code === "string" ? envelope.code : null;
  if (code === null || code === "updated" || code === "deleted") {
    return null;
  }

  if (code === "capacity_below_membership") {
    const count = Number(envelope.member_count);
    const memberCount = Number.isFinite(count) ? count : 0;
    return new RoomMutationError(
      "capacity_below_membership",
      `Capacity cannot be lower than the current member count (${memberCount}).`,
      409,
      memberCount,
    );
  }

  const mapped = MUTATION_RESULTS[code];
  if (!mapped) {
    throw new Error(`unexpected room mutation code: ${code}`);
  }
  return new RoomMutationError(mapped.code, mapped.message, mapped.status);
}

/**
 * The room row **for its owner only** — the settings page's gate.
 *
 * Two RLS reads, each scoped to the caller's own rows: the room row is
 * visible to any member (`rooms_select_member`), so membership decides
 * alone. A non-member matches no room row (404-equivalent `null`, identical
 * to a missing room), and a member who is not the owner reads their own
 * `room_members` row and finds `role = student` — also `null`. The page
 * turns `null` into `notFound()`, so `/rooms/[id]/settings` never reveals
 * which rooms exist and never renders owner controls to anyone else.
 */
export async function getOwnedRoom(
  client: SupabaseClient,
  roomId: string,
): Promise<PublicRoom | null> {
  const { data: roomRow, error: roomError } = await client
    .from("rooms")
    .select(PUBLIC_ROOM_COLUMNS)
    .eq("id", roomId)
    .maybeSingle();

  if (roomError) {
    throw new RoomQueryError(roomError.message);
  }
  if (!roomRow) {
    return null;
  }

  const { data: membership, error: memberError } = await client
    .from("room_members")
    .select("role")
    .eq("room_id", roomId)
    .limit(1);

  if (memberError) {
    throw new RoomQueryError(memberError.message);
  }
  if (!membership || membership.length === 0 || membership[0].role !== "owner") {
    return null;
  }

  return toPublicRoom(roomRow as Record<string, unknown>);
}

/**
 * Edits a room through `update_room`: a partial change set under the room
 * row lock, owner re-proven from `auth.uid()`, capacity floored at the
 * current member count. Absent keys are dropped here (a patch value that is
 * `undefined` never reaches the RPC), so "unchanged" and "cleared" stay
 * distinct all the way down. The response is the updated row's public shape —
 * always re-read from the database, never the caller's input echoed back.
 */
export async function updateRoom(
  client: SupabaseClient,
  roomId: string,
  patch: UpdateRoomInput,
): Promise<PublicRoom> {
  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.shared_goal !== undefined) changes.shared_goal = patch.shared_goal;
  if (patch.exam_track !== undefined) changes.exam_track = patch.exam_track;
  if (patch.subject !== undefined) changes.subject = patch.subject;
  if (patch.language !== undefined) changes.language = patch.language;
  if (patch.capacity !== undefined) changes.capacity = patch.capacity;
  if (patch.status !== undefined) changes.status = patch.status;

  const { data, error } = await client.rpc("update_room", {
    p_room_id: roomId,
    p_changes: changes,
  });

  if (error) {
    throw new Error(`update_room failed: ${error.message}`);
  }
  if (!data || typeof data !== "object") {
    throw new Error("update_room returned no result");
  }

  const failure = mutationError(data as Record<string, unknown>);
  if (failure) {
    throw failure;
  }

  return toPublicRoom(data as Record<string, unknown>);
}

/**
 * Deletes a room through `delete_room` — owner-only, one cascade. Storage
 * cleanup has already happened at this point (the route removes objects
 * first); this function only decides whether the row may disappear.
 */
export async function deleteRoom(
  client: SupabaseClient,
  roomId: string,
): Promise<void> {
  const { data, error } = await client.rpc("delete_room", {
    p_room_id: roomId,
  });

  if (error) {
    throw new Error(`delete_room failed: ${error.message}`);
  }
  if (!data || typeof data !== "object") {
    throw new Error("delete_room returned no result");
  }

  const failure = mutationError(data as Record<string, unknown>);
  if (failure) {
    throw failure;
  }
}

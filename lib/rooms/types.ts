export type PublicRoom = {
  id: string;
  name: string;
  exam_track: string | null;
  subject: string | null;
  language: string | null;
  capacity: number;
  status: string;
  shared_goal: string | null;
  created_at: string;
};

/**
 * Explicit column list. Never use `SELECT *` here: it would drag owner ids and
 * any future private column straight into public responses.
 */
export const PUBLIC_ROOM_COLUMNS =
  "id, name, exam_track, subject, language, capacity, status, shared_goal, created_at";

/**
 * The caller's own relationship to a room, never anyone else's. Derived from
 * `room_members` through RLS (`room_members_select_own`), so a student only
 * ever learns their own membership and role.
 */
export type ViewerMembership = "none" | "member" | "owner";

/**
 * One row of `list_public_rooms` (PR 17), already filtered to public rooms
 * inside the database. `member_count` is the aggregate seat usage computed in
 * the RPC; `viewer_role` is the caller's own role or null — it reveals
 * nothing about anyone else. `last_activity_at` is derived (newest focus
 * session or room message) and null when a room has neither.
 */
export type DiscoveredRoom = {
  id: string;
  name: string;
  shared_goal: string | null;
  subject: string | null;
  exam_track: string | null;
  language: string | null;
  status: string;
  capacity: number;
  member_count: number;
  last_activity_at: string | null;
  viewer_role: "owner" | "student" | null;
  created_at: string;
};

/**
 * What `/rooms` renders: a discovered public room plus the viewer's own
 * membership in the `ViewerMembership` vocabulary the card already speaks.
 * No participant identities, emails or private-room rows are ever attached.
 */
export type RoomSummary = DiscoveredRoom & {
  viewer_membership: ViewerMembership;
};

/** One page of discovery results, as the API and the browse page exchange it. */
export type RoomDiscoveryPage = {
  rooms: RoomSummary[];
  has_more: boolean;
  next_cursor: string | null;
};

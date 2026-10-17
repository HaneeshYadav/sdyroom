/**
 * Rate-limit key naming — the shared contract for every throttled endpoint.
 *
 * A key is `route[:scope]:subject`, where `subject` is always the caller's
 * user id (identity comes from the session, never from the request). Keys are
 * deliberately opaque strings: `rate_limit_take()` only ever sees them, so a
 * new route can adopt the mechanism without a migration.
 *
 * The numbers here are published in `docs/API_CONTRACTS.md` ("Rate limits")
 * and are part of the API contract — change them there too. They are split
 * per concern: an overall per-user ceiling stops one account from doing
 * unbounded work, while a per-target key stops it from concentrating all of
 * that work on one room, report thread or invitation.
 */
export type RateLimitSpec = {
  key: string;
  max: number;
  windowSeconds: number;
};

/** Overall per-user ceiling for uploads, across every room and personal. */
export const UPLOAD_USER_LIMIT = { max: 20, windowSeconds: 60 } as const;

/** Per-target upload ceiling: one room (or the personal library) at a time. */
export const UPLOAD_TARGET_LIMIT = { max: 10, windowSeconds: 60 } as const;

/** Deletions are cheap but destructive; this bounds scripted churn. */
export const RESOURCE_DELETE_LIMIT = { max: 30, windowSeconds: 60 } as const;

/** Signed-URL issuance. Generous: opening files is normal use, not abuse. */
export const DOWNLOAD_LIMIT = { max: 120, windowSeconds: 60 } as const;

/** Orphan sweeps do real work over storage; they are maintenance, not UI. */
export const CLEANUP_LIMIT = { max: 5, windowSeconds: 60 } as const;

/** Report filing — limit per room, per reporter. */
export const REPORT_LIMIT = { max: 20, windowSeconds: 3600 } as const;

/** Block/unblock — a global per-user action, not room-scoped. */
export const BLOCK_LIMIT = { max: 30, windowSeconds: 3600 } as const;

/** Mute/unmute — a per-room moderator action. */
export const MUTE_LIMIT = { max: 30, windowSeconds: 3600 } as const;

/** Invitation creation — limit per room, per inviter. */
export const INVITE_LIMIT = { max: 10, windowSeconds: 3600 } as const;

/**
 * Ingest step calls (`POST /api/ai/ingest/[resourceId]`). Each call runs one
 * bounded step, and a full document needs a handful of calls — 30/60s gives
 * a patient client room for a whole queue while stopping a script from
 * re-driving extract loops against one resource.
 */
export const INGEST_LIMIT = { max: 30, windowSeconds: 60 } as const;

/** Sweep calls — maintenance, not UI; one sweep already advances many rows. */
export const SWEEP_LIMIT = { max: 6, windowSeconds: 60 } as const;

/**
 * Ask calls (`POST /api/rooms/[id]/ask`). One question is one full RAG pass
 * (embed + retrieve + complete); 20/60s per room bounds a scripted question
 * loop while leaving a patient study session untouched.
 */
export const ASK_LIMIT = { max: 20, windowSeconds: 60 } as const;

/**
 * Generation calls (`POST /api/rooms/[id]/generate` and its `.../step`).
 * One quiz or deck is two requests (create + one bounded step) and spends a
 * full provider completion; 10/60s per room bounds a scripted generation
 * loop while leaving a patient build session untouched.
 */
export const GENERATE_LIMIT = { max: 10, windowSeconds: 60 } as const;

export function uploadUserKey(userId: string): string {
  return `upload:user:${userId}`;
}

/** `roomId` is the literal `personal` for the private library. */
export function uploadTargetKey(userId: string, roomId: string | null): string {
  return `upload:${roomId ?? "personal"}:${userId}`;
}

export function resourceDeleteKey(userId: string): string {
  return `resource_delete:user:${userId}`;
}

export function downloadKey(userId: string): string {
  return `download:user:${userId}`;
}

export function cleanupKey(userId: string): string {
  return `cleanup:user:${userId}`;
}

export function reportKey(roomId: string, userId: string): string {
  return `report:${roomId}:${userId}`;
}

export function blockKey(userId: string): string {
  return `block:user:${userId}`;
}

export function muteKey(roomId: string, userId: string): string {
  return `mute:${roomId}:${userId}`;
}

export function inviteKey(roomId: string, userId: string): string {
  return `invite:${roomId}:${userId}`;
}

/** Spec + key together, so a call site is one argument. */
export function uploadUserSpec(userId: string): RateLimitSpec {
  return { key: uploadUserKey(userId), ...UPLOAD_USER_LIMIT };
}

export function uploadTargetSpec(userId: string, roomId: string | null): RateLimitSpec {
  return { key: uploadTargetKey(userId, roomId), ...UPLOAD_TARGET_LIMIT };
}

export function resourceDeleteSpec(userId: string): RateLimitSpec {
  return { key: resourceDeleteKey(userId), ...RESOURCE_DELETE_LIMIT };
}

export function downloadSpec(userId: string): RateLimitSpec {
  return { key: downloadKey(userId), ...DOWNLOAD_LIMIT };
}

export function cleanupSpec(userId: string): RateLimitSpec {
  return { key: cleanupKey(userId), ...CLEANUP_LIMIT };
}

export function reportSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: reportKey(roomId, userId), ...REPORT_LIMIT };
}

export function blockSpec(userId: string): RateLimitSpec {
  return { key: blockKey(userId), ...BLOCK_LIMIT };
}

export function muteSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: muteKey(roomId, userId), ...MUTE_LIMIT };
}

export function inviteSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: inviteKey(roomId, userId), ...INVITE_LIMIT };
}

export function ingestKey(userId: string): string {
  return `ingest:user:${userId}`;
}

export function sweepKey(userId: string): string {
  return `sweep:user:${userId}`;
}

export function ingestSpec(userId: string): RateLimitSpec {
  return { key: ingestKey(userId), ...INGEST_LIMIT };
}

export function sweepSpec(userId: string): RateLimitSpec {
  return { key: sweepKey(userId), ...SWEEP_LIMIT };
}

export function askKey(roomId: string, userId: string): string {
  return `ask:${roomId}:${userId}`;
}

export function askSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: askKey(roomId, userId), ...ASK_LIMIT };
}

export function generateKey(roomId: string, userId: string): string {
  return `generate:${roomId}:${userId}`;
}

export function generateSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: generateKey(roomId, userId), ...GENERATE_LIMIT };
}

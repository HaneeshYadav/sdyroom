/**
 * Daily AI spend — the read side of the `ai_usage` ledger.
 *
 * The same RPC (`ai_usage_daily`, migration 0013) backs both this module and
 * the embed step's pre-check, so the number the UI shows and the number the
 * cap enforces can never diverge: one query shape, one scope rule (personal
 * spend counts per user, room spend counts per room), one 50 MiB/day limit.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type AiUsageSummary = {
  scope: "user" | "room";
  used_bytes: number;
  used_tokens: number;
  limit_bytes: number;
  day_start: string;
};

function isSummary(value: unknown): value is AiUsageSummary {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.scope === "user" || record.scope === "room") &&
    typeof record.used_bytes === "number" &&
    typeof record.used_tokens === "number" &&
    typeof record.limit_bytes === "number" &&
    typeof record.day_start === "string"
  );
}

/**
 * Today's spend for one scope. `userId` must be the session's user — the RPC
 * refuses anything else (`not_authorized`) and refuses non-members for a room
 * (`not_found`), so this function can surface those codes unchanged.
 */
export async function fetchAiUsageDaily(
  client: SupabaseClient,
  userId: string,
  roomId: string | null,
): Promise<AiUsageSummary> {
  const { data, error } = await client.rpc("ai_usage_daily", {
    p_user_id: userId,
    p_room_id: roomId,
  });

  if (error) {
    throw new UsageError(error.code ?? "unknown", error.message);
  }
  if (!isSummary(data)) {
    throw new UsageError("unexpected", "usage response was malformed");
  }
  return data;
}

/** Carries the database's own code/message so routes map without guessing. */
export class UsageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UsageError";
    this.code = code;
  }
}

import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, validationResponse } from "@/lib/api/responses";
import { aiConfig } from "@/lib/ai/config";
import { UsageError, fetchAiUsageDaily } from "@/lib/ai/usage";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { aiUsageQuerySchema } from "@/lib/validation/ai";

/**
 * GET /api/ai/usage?room_id= — today's AI spend for one scope.
 *
 * Same RPC the embed cap enforces (`ai_usage_daily`), so what this endpoint
 * reports and what the database refuses can never drift: personal spend
 * counts per user, room spend counts per room, both against the 50 MiB/day
 * limit. `room_id` is membership-proven (404 for non-members, same as a
 * missing room); absent means the caller's personal scope.
 *
 * Answer: `200 { used_bytes, used_tokens, limit_bytes, provider }`.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse(
      "unauthenticated",
      "Sign in to check AI usage.",
      401,
    );
  }

  const parsed = aiUsageQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );

  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  try {
    const roomId = parsed.data.room_id ?? null;

    if (roomId !== null) {
      await requireRoomMembership(supabase, roomId);
    }

    const usage = await fetchAiUsageDaily(supabase, claims.sub, roomId);

    return NextResponse.json({
      used_bytes: usage.used_bytes,
      used_tokens: usage.used_tokens,
      limit_bytes: usage.limit_bytes,
      provider: aiConfig().provider,
    });
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }

    if (error instanceof UsageError) {
      if (error.code === "not_found") {
        return errorResponse(
          "not_found",
          "That room does not exist or is not available.",
          404,
        );
      }
      if (error.code === "unauthenticated" || error.code === "42501") {
        return errorResponse(
          "unauthenticated",
          "Sign in to check AI usage.",
          401,
        );
      }
      console.error("[api/ai/usage] rpc failed:", error.code);
      return errorResponse(
        "usage_unavailable",
        "Usage could not be loaded right now. Try again.",
        500,
      );
    }

    console.error(
      "[api/ai/usage] failed:",
      error instanceof Error ? error.message : error,
    );

    return errorResponse(
      "usage_unavailable",
      "Usage could not be loaded right now. Try again.",
      500,
    );
  }
}

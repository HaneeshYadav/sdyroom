import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import {
  AnalyticsError,
  fetchRoomAnalytics,
} from "@/lib/analytics/queries";
import { RANGE_DAYS } from "@/lib/analytics/range";
import { createClient } from "@/lib/supabase/server";
import {
  ANALYTICS_RANGE_MESSAGE,
  analyticsRangeSchema,
} from "@/lib/validation/analytics";
import { roomIdSchema } from "@/lib/validation/rooms";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type RoomContext = { params: Promise<{ id: string }> };

/**
 * GET /api/analytics/rooms/[id] — the room's aggregate panel, owner or
 * moderator only.
 *
 * The privilege check lives inside `analytics_room` (owner or a
 * `room_moderators` row), not just here: a plain member, a non-member and a
 * missing room all arrive as the same `not_found` → 404, so the URL never
 * reveals which rooms exist or who can moderate them. The payload is counts
 * and minutes only — no member-identifying rows, ever (asserted in tests).
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ range, summary, days }` |
 * | 400 | `{ "error": { "code": "validation" } }` — bad id or range |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — member, non-member or missing |
 * | 500 | `{ "error": { "code": "analytics_failed" } }` |
 */
async function GET_raw(request: NextRequest, { params }: RoomContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse(
      "unauthenticated",
      "Sign in to view room analytics.",
      401,
    );
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "roomId", message: "Room id must be a UUID." },
    ]);
  }

  const parsedRange = analyticsRangeSchema.safeParse(
    request.nextUrl.searchParams.get("range"),
  );
  if (!parsedRange.success) {
    return errorResponse(
      "validation",
      "Choose a range of 7d, 30d or 90d.",
      400,
      [{ path: "range", message: ANALYTICS_RANGE_MESSAGE }],
    );
  }

  try {
    const analytics = await fetchRoomAnalytics(supabase, {
      roomId: parsedRoomId.data,
      days: RANGE_DAYS[parsedRange.data],
    });
    return NextResponse.json({
      range: parsedRange.data,
      summary: analytics.summary,
      days: analytics.days,
    });
  } catch (error) {
    if (error instanceof AnalyticsError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/analytics/rooms] failed:", errorFields(error));
    return errorResponse(
      "analytics_failed",
      "Could not load room analytics.",
      500,
    );
  }
}

export const GET = withLogging(GET_raw);

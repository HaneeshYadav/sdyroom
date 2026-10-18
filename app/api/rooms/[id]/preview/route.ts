import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import {
  DiscoveryError,
  discoveryErrorStatus,
  getRoomPreview,
} from "@/lib/rooms/discovery";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

/**
 * GET /api/rooms/[id]/preview — public-safe room detail (PR 17).
 * Requires a session (401) but no membership: any signed-in student can
 * preview a public room. A private room the caller does not belong to and a
 * room that does not exist both answer the identical 404 `not_found`, because
 * `room_preview` raises the same `P0002` for both — the endpoint is never an
 * existence oracle. A member previewing their own private room gets the row
 * with `is_member: true`.
 */
async function GET_raw(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse(
      "unauthenticated",
      "Sign in to preview public rooms.",
      401,
    );
  }

  const roomId = (await context.params).id;
  const parsedId = roomIdSchema.safeParse(roomId);
  if (!parsedId.success) {
    return errorResponse("not_found", "That room is not available.", 404);
  }

  try {
    const room = await getRoomPreview(supabase, parsedId.data);
    if (!room) {
      return errorResponse("not_found", "That room is not available.", 404);
    }
    return NextResponse.json({ room, is_member: room.is_member });
  } catch (error) {
    if (error instanceof DiscoveryError) {
      return errorResponse(
        error.code,
        error.message,
        discoveryErrorStatus(error),
      );
    }
    logError("[api/rooms/preview] failed:", errorFields(error));
    return errorResponse(
      "preview_failed",
      "That room could not be loaded.",
      500,
    );
  }
}

export const GET = withLogging(GET_raw);

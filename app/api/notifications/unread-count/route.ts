import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import {
  countUnreadNotifications,
  NotificationQueryError,
} from "@/lib/notifications/queries";
import { createClient } from "@/lib/supabase/server";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

/**
 * GET /api/notifications/unread-count — the header badge's cheapest read:
 * one indexed count of the caller's own unread rows, through the
 * invoker's-rights `notifications_unread_count()` RPC. Deliberately separate
 * from the list so the bell never downloads rows it will not show.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "unread_count": 3 }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 500 | `{ "error": { "code": "notifications_failed" } }` |
 */
async function GET_raw(request: NextRequest) {
  void request;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to view notifications.", 401);
  }

  try {
    const unreadCount = await countUnreadNotifications(supabase);
    return NextResponse.json({ unread_count: unreadCount });
  } catch (error) {
    if (error instanceof NotificationQueryError) {
      logError("[api/notifications/unread-count] failed:", errorFields(error));
      return errorResponse(
        "notifications_failed",
        "The unread count could not be loaded.",
        500,
      );
    }
    throw error;
  }
}

export const GET = withLogging(GET_raw);

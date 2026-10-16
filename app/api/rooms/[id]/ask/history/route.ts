import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, validationResponse } from "@/lib/api/responses";
import { AskError, listAskHistory } from "@/lib/ai/ask";
import { decodeCursorSchema } from "@/lib/notifications/validation";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { askHistoryQuerySchema } from "@/lib/validation/ask";
import { roomIdSchema } from "@/lib/validation/rooms";

type HistoryContext = { params: Promise<{ id: string }> };

/**
 * GET /api/rooms/[id]/ask/history?limit=&cursor= — the caller's own Q/A
 * history for one room, newest first.
 *
 * Only the signed-in user's own rows come back (0018 policy + column-scoped
 * SELECT); a non-member gets the same 404 as a missing room. The cursor is
 * the shared opaque `created_at|id` encoding — the ask client passes back
 * `next_cursor` verbatim.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "items": [{ id, question, answer, citations, conversation_id, created_at }], "next_cursor": string \| null }` |
 * | 400 | `{ "error": { "code": "validation" } }` — bad limit or cursor |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "conversation_history_failed" } }` |
 */
export async function GET(request: NextRequest, { params }: HistoryContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to load history.", 401);
  }

  const { id: roomId } = await params;
  const parsedRoom = roomIdSchema.safeParse(roomId);
  if (!parsedRoom.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const parsedQuery = askHistoryQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsedQuery.success) {
    return validationResponse(parsedQuery.error);
  }

  let cursor: { createdAt: string; id: string } | undefined;
  if (parsedQuery.data.cursor !== undefined) {
    const parsedCursor = decodeCursorSchema.safeParse(parsedQuery.data.cursor);
    if (!parsedCursor.success) {
      return validationResponse(parsedCursor.error);
    }
    cursor = parsedCursor.data;
  }

  try {
    await requireRoomMembership(supabase, parsedRoom.data);
    const page = await listAskHistory(supabase, {
      roomId: parsedRoom.data,
      limit: parsedQuery.data.limit,
      cursor,
    });
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof AskError) {
      return errorResponse(error.code, error.message, error.status);
    }
    console.error(
      "[api/rooms/ask/history] failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse(
      "conversation_history_failed",
      "Could not load conversation history.",
      500,
    );
  }
}

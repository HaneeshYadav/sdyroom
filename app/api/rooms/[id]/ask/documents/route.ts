import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import { AskError, listAskDocuments } from "@/lib/ai/ask";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";

type DocumentsContext = { params: Promise<{ id: string }> };

/**
 * GET /api/rooms/[id]/ask/documents — the room's documents as the ask scope
 * selector needs them: `{ resource_id, title, status, chunks }`.
 *
 * Visibility is RLS on `study_resources` (membership-proven by the route),
 * never a body-trusted list. Status rides along — including `pending`,
 * `processing` and `failed` — so the UI can explain why a file is not
 * askable instead of hiding it.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "documents": [{ resource_id, title, status, chunks }] }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "documents_failed" } }` |
 */
export async function GET(request: NextRequest, { params }: DocumentsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to list documents.", 401);
  }

  const { id: roomId } = await params;
  const parsedRoom = roomIdSchema.safeParse(roomId);
  if (!parsedRoom.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  try {
    await requireRoomMembership(supabase, parsedRoom.data);
    const documents = await listAskDocuments(supabase, parsedRoom.data);
    return NextResponse.json({ documents });
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof AskError) {
      return errorResponse(error.code, error.message, error.status);
    }
    console.error(
      "[api/rooms/ask/documents] failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("documents_failed", "Could not list documents.", 500);
  }
}

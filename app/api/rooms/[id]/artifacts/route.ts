import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, validationResponse } from "@/lib/api/responses";
import { GenerateError, listArtifacts } from "@/lib/ai/generate";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { artifactsQuerySchema } from "@/lib/validation/generate";
import { roomIdSchema } from "@/lib/validation/rooms";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type ArtifactsContext = { params: Promise<{ id: string }> };

/**
 * GET /api/rooms/[id]/artifacts?kind= — the room's generated quizzes and
 * decks, newest first, for a member (RLS: room members only). Each row
 * carries `is_creator` so the UI shows delete/regenerate affordances only
 * to the artifact's owner.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "artifacts": [{ id, kind, status, error_code, difficulty, question_count, card_count, created_at, href, is_creator }], "has_more": false }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "artifacts_failed" } }` |
 */
async function GET_raw(request: NextRequest, { params }: ArtifactsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to load quizzes and decks.", 401);
  }

  const { id: roomId } = await params;
  const parsedRoom = roomIdSchema.safeParse(roomId);
  if (!parsedRoom.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const parsedQuery = artifactsQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsedQuery.success) {
    return validationResponse(parsedQuery.error);
  }

  try {
    await requireRoomMembership(supabase, parsedRoom.data);
    const artifacts = await listArtifacts(supabase, {
      roomId: parsedRoom.data,
      viewerId: claims.sub,
      kind: parsedQuery.data.kind,
    });
    return NextResponse.json({ artifacts, has_more: false });
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof GenerateError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/rooms/artifacts] list failed:", errorFields(error));
    return errorResponse("artifacts_failed", "Could not load quizzes and decks.", 500);
  }
}

export const GET = withLogging(GET_raw);

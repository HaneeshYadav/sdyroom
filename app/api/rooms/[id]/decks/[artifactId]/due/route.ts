import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import { GenerateError, listDueCards } from "@/lib/ai/generate";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { artifactIdSchema } from "@/lib/validation/generate";
import { roomIdSchema } from "@/lib/validation/rooms";

type DueContext = { params: Promise<{ id: string; artifactId: string }> };

/**
 * GET /api/rooms/[id]/decks/[artifactId]/due — the caller's own review
 * state for every card in a deck plus how many are due right now (never
 * reviewed, or `next_review_at` in the past). Own-row RLS: another member's
 * schedule never appears.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ cards: [{ ordinal, front, back, citations, grade, streak, next_review_at, due }], due_count }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "artifact_not_ready" } }` |
 * | 500 | `{ "error": { "code": "review_failed" } }` |
 */
export async function GET(request: NextRequest, { params }: DueContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to load due cards.", 401);
  }

  const { id: roomId, artifactId } = await params;
  const parsedRoom = roomIdSchema.safeParse(roomId);
  if (!parsedRoom.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }
  const parsedArtifact = artifactIdSchema.safeParse(artifactId);
  if (!parsedArtifact.success) {
    return errorResponse("validation", "That artifact id is not valid.", 400, [
      { path: "artifactId", message: "Artifact id must be a UUID." },
    ]);
  }

  try {
    await requireRoomMembership(supabase, parsedRoom.data);
    const result = await listDueCards(supabase, {
      roomId: parsedRoom.data,
      artifactId: parsedArtifact.data,
      viewerId: claims.sub,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof GenerateError) {
      return errorResponse(error.code, error.message, error.status);
    }
    console.error(
      "[api/rooms/decks/due] failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("review_failed", "Could not load due cards.", 500);
  }
}

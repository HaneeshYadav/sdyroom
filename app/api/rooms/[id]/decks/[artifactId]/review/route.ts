import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, readOptionalJsonBody, validationResponse } from "@/lib/api/responses";
import { GenerateError, reviewFlashcard } from "@/lib/ai/generate";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { artifactIdSchema, reviewBodySchema } from "@/lib/validation/generate";
import { roomIdSchema } from "@/lib/validation/rooms";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type ReviewContext = { params: Promise<{ id: string; artifactId: string }> };

/**
 * POST /api/rooms/[id]/decks/[artifactId]/review — grade one flashcard.
 *
 * Body `{ card_ordinal, grade: "again" | "got_it" }`. The SM-2-lite schedule
 * is computed inside `review_card` (0019) — the database is the authority —
 * and the response carries the new `next_review_at`, `interval_days`,
 * `streak` and the remaining `due_count`. One row per (user, card): grading
 * the same card again moves the schedule instead of stacking rows.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ next_review_at, interval_days, streak, due_count }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "artifact_not_ready" } }` |
 * | 500 | `{ "error": { "code": "review_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: ReviewContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to review cards.", 401);
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

  const body = await readOptionalJsonBody(request);
  if (!body.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }
  const parsed = reviewBodySchema.safeParse(body.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  try {
    await requireRoomMembership(supabase, parsedRoom.data);
    const result = await reviewFlashcard(supabase, {
      artifactId: parsedArtifact.data,
      cardOrdinal: parsed.data.card_ordinal,
      grade: parsed.data.grade,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof GenerateError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/rooms/decks/review] failed:", errorFields(error));
    return errorResponse("review_failed", "Could not save that grade.", 500);
  }
}

export const POST = withLogging(POST_raw);

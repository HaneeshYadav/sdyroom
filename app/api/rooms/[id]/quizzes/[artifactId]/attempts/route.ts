import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, readOptionalJsonBody, validationResponse } from "@/lib/api/responses";
import {
  GenerateError,
  listQuizAttempts,
  recordQuizAttempt,
} from "@/lib/ai/generate";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { artifactIdSchema, attemptBodySchema } from "@/lib/validation/generate";
import { roomIdSchema } from "@/lib/validation/rooms";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type AttemptsContext = { params: Promise<{ id: string; artifactId: string }> };

/**
 * POST /api/rooms/[id]/quizzes/[artifactId]/attempts — submit one quiz
 * attempt. Scoring is deterministic and server-side (`record_attempt`
 * compares against the stored answer key); the body carries only the chosen
 * indices, and a forged score would be ignored because the schema does not
 * allow one. Unlimited retakes — every submit is its own immutable row.
 *
 * GET — the caller's own attempts on this artifact, newest first (own-row
 * RLS; nobody else's results ever appear).
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "attempt": { id, score, total, correct, results, duration_ms, created_at } }` |
 * | 200 | `{ "attempts": [{ id, score, total, correct, duration_ms, created_at }] }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "artifact_not_ready" } }` |
 * | 500 | `{ "error": { "code": "attempts_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: AttemptsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to submit an attempt.", 401);
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
  const parsed = attemptBodySchema.safeParse(body.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  try {
    await requireRoomMembership(supabase, parsedRoom.data);
    const attempt = await recordQuizAttempt(supabase, {
      roomId: parsedRoom.data,
      artifactId: parsedArtifact.data,
      answers: parsed.data.answers,
      durationMs: parsed.data.duration_ms,
    });
    return NextResponse.json({ attempt }, { status: 201 });
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof GenerateError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/rooms/quizzes/attempts] submit failed:", errorFields(error));
    return errorResponse("attempts_failed", "Could not record that attempt.", 500);
  }
}

export const POST = withLogging(POST_raw);

async function GET_raw(request: NextRequest, { params }: AttemptsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to load attempts.", 401);
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
    const attempts = await listQuizAttempts(supabase, {
      artifactId: parsedArtifact.data,
    });
    return NextResponse.json({ attempts });
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof GenerateError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/rooms/quizzes/attempts] list failed:", errorFields(error));
    return errorResponse("attempts_failed", "Could not load attempts.", 500);
  }
}

export const GET = withLogging(GET_raw);

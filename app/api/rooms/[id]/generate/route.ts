import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, readOptionalJsonBody, validationResponse } from "@/lib/api/responses";
import {
  artifactKindFor,
  generateBodySchema,
} from "@/lib/validation/generate";
import {
  createArtifact,
  GenerateError,
} from "@/lib/ai/generate";
import { AiProviderError } from "@/lib/ai/provider";
import { RetrieveError } from "@/lib/ai/retrieve";
import { generateSpec } from "@/lib/rate-limit/keys";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";

type GenerateContext = { params: Promise<{ id: string }> };

/**
 * POST /api/rooms/[id]/generate — start one quiz or deck build.
 *
 * Creates a `generating` artifact (201) and hands it to the client, which
 * immediately drives `POST …/generate/[artifactId]/step` — the same
 * resumable one-bounded-step-per-request model PR 12's ingest uses, so a
 * generation survives a dropped connection without an in-memory task.
 * Regeneration is simply a new artifact; the old one stays unless the UI
 * deletes it.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "artifact": { id, kind, status: "generating", href } }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "ai_quota_exceeded" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "no_documents_indexed" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 500 | `{ "error": { "code": "generate_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: GenerateContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to generate study material.", 401);
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
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    console.error(
      "[api/rooms/generate] membership check failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("generate_failed", "Could not check room access.", 500);
  }

  const limited = await rateLimitedResponse(
    supabase,
    generateSpec(parsedRoom.data, claims.sub),
  );
  if (limited) {
    return limited;
  }

  const body = await readOptionalJsonBody(request);
  if (!body.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }
  const parsed = generateBodySchema.safeParse(body.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  try {
    const artifact = await createArtifact(supabase, {
      roomId: parsedRoom.data,
      kind: artifactKindFor(parsed.data.mode),
      difficulty: parsed.data.difficulty,
      count: parsed.data.count,
      resourceIds: parsed.data.resource_ids,
    });
    return NextResponse.json({ artifact }, { status: 201 });
  } catch (error) {
    if (error instanceof GenerateError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof AiProviderError || error instanceof RetrieveError) {
      return errorResponse("ai_provider_failed", error.message, 502);
    }
    console.error(
      "[api/rooms/generate] create failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("generate_failed", "Could not start generation.", 500);
  }
}

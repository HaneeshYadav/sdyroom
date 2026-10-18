import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import {
  GenerateError,
  runGenerationStep,
} from "@/lib/ai/generate";
import { AiProviderError } from "@/lib/ai/provider";
import { RetrieveError } from "@/lib/ai/retrieve";
import { generateSpec } from "@/lib/rate-limit/keys";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { artifactIdSchema } from "@/lib/validation/generate";
import { roomIdSchema } from "@/lib/validation/rooms";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type StepContext = { params: Promise<{ id: string; artifactId: string }> };

/**
 * POST /api/rooms/[id]/generate/[artifactId]/step — one bounded generation
 * step: retrieve → complete → parse-validate → `complete_artifact`.
 *
 * Creator-only (403 for other members), idempotent once the artifact is
 * `ready` or `failed` (the existing state comes back with `deduped: true`
 * and no second provider call). Malformed model output fails the artifact
 * with `ai_provider_failed` and answers 502 — never a `ready` row.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ status: "ready" \| "failed", question_count?, card_count?, model, provider, error_code?, deduped }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_creator" \| "ai_quota_exceeded" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "no_documents_indexed" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 502 | `{ "error": { "code": "ai_provider_failed" } }` |
 * | 500 | `{ "error": { "code": "generate_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: StepContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to generate study material.", 401);
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
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/rooms/generate/step] membership check failed:", errorFields(error));
    return errorResponse("generate_failed", "Could not check room access.", 500);
  }

  const limited = await rateLimitedResponse(
    supabase,
    generateSpec(parsedRoom.data, claims.sub),
  );
  if (limited) {
    return limited;
  }

  try {
    const result = await runGenerationStep(supabase, {
      roomId: parsedRoom.data,
      artifactId: parsedArtifact.data,
      userId: claims.sub,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof GenerateError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof AiProviderError || error instanceof RetrieveError) {
      return errorResponse("ai_provider_failed", error.message, 502);
    }
    logError("[api/rooms/generate/step] step failed:", errorFields(error));
    return errorResponse("generate_failed", "Could not advance generation.", 500);
  }
}

export const POST = withLogging(POST_raw);

import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import {
  deleteArtifact,
  GenerateError,
  getArtifact,
} from "@/lib/ai/generate";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { artifactIdSchema } from "@/lib/validation/generate";
import { roomIdSchema } from "@/lib/validation/rooms";

type ArtifactContext = { params: Promise<{ id: string; artifactId: string }> };

/**
 * GET /api/rooms/[id]/artifacts/[artifactId] — one artifact with its full
 * payload, for a member of the room (404 parity for non-members and missing
 * rooms alike). Other users' attempt results are never included: attempts
 * are own-row only (0019), and this route does not read them.
 *
 * DELETE — creator only (403 for other members); cascades attempts and
 * review rows inside the database.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "artifact": { …summary, payload, model, resource_ids } }` |
 * | 204 | DELETE ok: `{ "deleted": true }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_creator" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "artifacts_failed" } }` |
 */
export async function GET(request: NextRequest, { params }: ArtifactContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to open this item.", 401);
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
    const artifact = await getArtifact(supabase, {
      roomId: parsedRoom.data,
      artifactId: parsedArtifact.data,
      viewerId: claims.sub,
    });
    return NextResponse.json({ artifact });
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof GenerateError) {
      return errorResponse(error.code, error.message, error.status);
    }
    console.error(
      "[api/rooms/artifacts] read failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("artifacts_failed", "Could not load that item.", 500);
  }
}

export async function DELETE(request: NextRequest, { params }: ArtifactContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to delete this item.", 401);
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
    await deleteArtifact(supabase, parsedArtifact.data);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof GenerateError) {
      return errorResponse(error.code, error.message, error.status);
    }
    console.error(
      "[api/rooms/artifacts] delete failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse("artifacts_failed", "Could not delete that item.", 500);
  }
}

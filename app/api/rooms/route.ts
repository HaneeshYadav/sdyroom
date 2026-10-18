import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import {
  DiscoveryError,
  discoveryErrorStatus,
  searchPublicRooms,
} from "@/lib/rooms/discovery";
import { getProfile } from "@/lib/profiles/queries";
import { createRoom, RoomError } from "@/lib/rooms/create";
import { createClient } from "@/lib/supabase/server";
import { createRoomSchema, roomDiscoverySchema } from "@/lib/validation/rooms";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

/**
 * GET /api/rooms — public room discovery (PR 17).
 * Requires a session (401 otherwise) and returns only public rooms: the
 * `list_public_rooms` RPC hard-codes that filter, so no parameter here can
 * widen visibility. `q`/`subject`/`exam_track`/`language`/`min_members`
 * filter, `sort` picks the keyset (`recent`|`active`|`largest`|`name`, or
 * `relevance` when a query is present and no sort is given), `limit` is
 * capped at 50, and `cursor` is the opaque base64url keyset of the previous
 * page — a malformed one is a 400 before SQL sees it. The response keeps the
 * original `{ rooms }` fields and adds `has_more`/`next_cursor` so existing
 * consumers stay valid.
 */
async function GET_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to list public rooms.", 401);
  }

  const params = request.nextUrl.searchParams;
  const parsedSearch = roomDiscoverySchema.safeParse({
    q: params.get("q") ?? undefined,
    subject: params.get("subject") ?? undefined,
    exam_track: params.get("exam_track") ?? undefined,
    language: params.get("language") ?? undefined,
    min_members: params.get("min_members") ?? undefined,
    sort: params.get("sort") ?? undefined,
    limit: params.get("limit") ?? undefined,
    cursor: params.get("cursor") ?? undefined,
  });

  if (!parsedSearch.success) {
    return validationResponse(parsedSearch.error);
  }

  try {
    const page = await searchPublicRooms(
      supabase,
      parsedSearch.data,
      parsedSearch.data.cursor,
    );
    return NextResponse.json({
      rooms: page.rooms.map((room) => ({
        ...room,
        href: `/rooms/${room.id}/preview`,
      })),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
    });
  } catch (error) {
    if (error instanceof DiscoveryError) {
      return errorResponse(error.code, error.message, discoveryErrorStatus(error));
    }
    logError("[api/rooms] list failed:", errorFields(error));
    return errorResponse(
      "query_failed",
      "Public rooms could not be loaded.",
      500,
    );
  }
}

export const GET = withLogging(GET_raw);

/**
 * POST /api/rooms — creates a room through the create_room RPC.
 * 401 without a session, 403 before onboarding, 400 on invalid fields.
 * The owner is never accepted from the client.
 */
async function POST_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to create a room.", 401);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse(
      "invalid_json",
      "The request body must be JSON.",
      400,
    );
  }

  const parsedRoom = createRoomSchema.safeParse(parsedBody.body);
  if (!parsedRoom.success) {
    return validationResponse(parsedRoom.error);
  }

  try {
    const profile = await getProfile(supabase, claims.sub);
    if (!profile) {
      return errorResponse(
        "onboarding_required",
        "Choose a study alias before creating a room.",
        403,
      );
    }
  } catch (error) {
    logError("[api/rooms] profile lookup failed:", errorFields(error));
    return errorResponse(
      "query_failed",
      "Your profile could not be loaded.",
      500,
    );
  }

  try {
    const room = await createRoom(supabase, parsedRoom.data);
    return NextResponse.json({ room }, { status: 201 });
  } catch (error) {
    if (error instanceof RoomError) {
      return errorResponse(error.code, error.message, error.status);
    }

    logError("[api/rooms] create failed:", errorFields(error));
    return errorResponse(
      "rpc_failed",
      "The room could not be created. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);

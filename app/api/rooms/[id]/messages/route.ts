import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { ChatError, createMessage, listMessages } from "@/lib/chat/queries";
import { RoomAccessError, requireRoomMembership } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { messagesQuerySchema, sendMessageSchema } from "@/lib/validation/chat";
import { roomIdSchema } from "@/lib/validation/rooms";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { messageSpec } from "@/lib/rate-limit/keys";

type MessagesContext = { params: Promise<{ id: string }> };

/**
 * GET /api/rooms/[id]/messages — one page of the room's chat history.
 *
 * Membership is confirmed first so a non-member gets the same 404 the
 * workspace gives, and RLS narrows the rows to rooms the caller belongs to.
 * Each message carries `is_own` computed for the viewer and never exposes
 * sender ids: the same audience that can read a message can see the sender's
 * study alias, and that is all the UI needs.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "messages": [...], "has_more": bool }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "messages_failed" } }` |
 */
async function GET_raw(request: NextRequest, { params }: MessagesContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to view messages.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const search = request.nextUrl.searchParams;
  const before = search.get("before");
  const limit = search.get("limit");
  const parsedQuery = messagesQuerySchema.safeParse({
    ...(before !== null ? { before } : {}),
    ...(limit !== null ? { limit } : {}),
  });
  if (!parsedQuery.success) {
    return validationResponse(parsedQuery.error);
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
    const page = await listMessages(supabase, {
      roomId: parsedRoomId.data,
      viewerId: claims.sub,
      before: parsedQuery.data.before,
      limit: parsedQuery.data.limit,
    });
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof ChatError) {
      return errorResponse(error.code, error.message, error.status);
    }

    logError("[api/rooms/messages] list failed:", errorFields(error));
    return errorResponse(
      "messages_failed",
      "Messages could not be loaded.",
      500,
    );
  }
}

export const GET = withLogging(GET_raw);

/**
 * POST /api/rooms/[id]/messages — append one of the caller's own messages.
 *
 * The user id is never taken from the body: it comes from the verified
 * session claims, and `room_messages_insert_own` checks the same identity
 * again, so a forged `user_id` cannot be written. The alias is stamped from
 * the caller's own profile row rather than the request, so the history shows
 * the name they actually registered.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "message": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "message_create_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: MessagesContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to send a message.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsedMessage = sendMessageSchema.safeParse(parsedBody.body);
  if (!parsedMessage.success) {
    return validationResponse(parsedMessage.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    messageSpec(parsedRoomId.data, claims.sub),
    "You're sending messages too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("alias")
      .eq("id", claims.sub)
      .maybeSingle();

    if (profileError || !profile || typeof profile.alias !== "string") {
      throw new Error(
        `alias lookup failed: ${profileError?.message ?? "profile not found"}`,
      );
    }

    const message = await createMessage(supabase, {
      roomId: parsedRoomId.data,
      userId: claims.sub,
      alias: profile.alias,
      body: parsedMessage.data.body,
    });
    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof ChatError) {
      return errorResponse(error.code, error.message, error.status);
    }

    logError("[api/rooms/messages] create failed:", errorFields(error));
    return errorResponse(
      "message_create_failed",
      "The message could not be sent. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);

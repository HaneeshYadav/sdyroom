import { RoomPreview } from "@/components/rooms/room-preview";
import { getRoomPreview } from "@/lib/rooms/discovery";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Room preview · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

type PreviewPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
};

/**
 * The `from` back-reference is only honoured as a same-site query string
 * (`?q=…&subject=…`); anything else degrades to the plain browse page, so a
 * crafted link can never point the Back affordance off-site or at another
 * route.
 */
function safeBackPath(from: string | undefined): string {
  if (from && /^\?[A-Za-z0-9%&=+_.-]{0,500}$/.test(from)) {
    return `/rooms${from}`;
  }
  return "/rooms";
}

/**
 * Room preview page (PR 17): public-safe detail for one room, linkable and
 * shareable. A private room the caller does not belong to and a room that
 * does not exist both render the app's not-found page — the RPC raises the
 * same `P0002` for both, so this URL is never an existence oracle (streaming
 * makes the HTTP status unreliable by design; the rendered page is the
 * contract, same convention as the rest of the app).
 */
export default async function RoomPreviewPage({
  params,
  searchParams,
}: PreviewPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    redirect("/auth/login");
  }

  const roomId = (await params).id;
  const parsedId = roomIdSchema.safeParse(roomId);
  if (!parsedId.success) {
    notFound();
  }

  const room = await getRoomPreview(supabase, parsedId.data);
  if (!room) {
    notFound();
  }

  const { from } = await searchParams;
  return <RoomPreview room={room} backPath={safeBackPath(from)} />;
}

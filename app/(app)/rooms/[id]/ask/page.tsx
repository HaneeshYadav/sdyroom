import { AskPanel } from "@/components/ai/ask-panel";
import { Badge } from "@/components/ui/badge";
import { aiConfig } from "@/lib/ai/config";
import { listAskDocuments, listAskHistory } from "@/lib/ai/ask";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Ask my notes · SdyRoom",
};

// Session-gated page: history is personal, so it renders per request.
export const instant = false;

const HISTORY_PAGE_SIZE = 20;

type AskPageProps = {
  params: Promise<{ id: string }>;
};

/**
 * `/rooms/[id]/ask` — "Ask my notes".
 *
 * Membership is proven here exactly like the workspace page: a non-member
 * and a missing room both land on the same 404, so the URL never reveals
 * which rooms exist. History is the viewer's own rows only (0018 policy);
 * the document list is RLS-scoped to what this member may already read.
 * Demo mode (no configured provider) is decided server-side from config and
 * passed down — the browser never reads env.
 */
export default async function AskPage({ params }: AskPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const viewerId = data?.claims?.sub;

  if (!viewerId) {
    redirect("/auth/login");
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    notFound();
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
  } catch (error) {
    if (error instanceof RoomAccessError) {
      notFound();
    }
    throw error;
  }

  const [history, documents, roomRow] = await Promise.all([
    listAskHistory(supabase, {
      roomId: parsedRoomId.data,
      limit: HISTORY_PAGE_SIZE,
      cursor: undefined,
    }),
    listAskDocuments(supabase, parsedRoomId.data),
    supabase
      .from("rooms")
      .select("name")
      .eq("id", parsedRoomId.data)
      .maybeSingle(),
  ]);

  const roomName =
    typeof roomRow.data?.name === "string" ? roomRow.data.name : "Study room";
  const demoMode = aiConfig().provider === "mock";

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`/rooms/${parsedRoomId.data}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {roomName}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">Ask my notes</h1>
          {demoMode && <Badge variant="secondary">Demo mode</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          Ask questions about this room&apos;s indexed documents. Answers cite
          the passages they come from — never anything else.
        </p>
      </header>

      <AskPanel
        key={`ask-${parsedRoomId.data}`}
        roomId={parsedRoomId.data}
        documents={documents}
        initialHistory={history.items}
        demoMode={demoMode}
      />
    </section>
  );
}

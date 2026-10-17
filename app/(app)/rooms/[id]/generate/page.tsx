import { ArtifactList } from "@/components/ai/artifact-list";
import { GenerateForm } from "@/components/ai/generate-form";
import { Badge } from "@/components/ui/badge";
import { aiConfig } from "@/lib/ai/config";
import { listAskDocuments } from "@/lib/ai/ask";
import { listArtifacts } from "@/lib/ai/generate";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Generate · SdyRoom",
};

// Session-gated page: the artifact library is membership-scoped.
export const instant = false;

type GeneratePageProps = {
  params: Promise<{ id: string }>;
};

/**
 * `/rooms/[id]/generate` — the quiz/deck generator and the room's
 * "Quizzes & decks" library.
 *
 * Membership is proven exactly like the workspace page: a non-member and a
 * missing room both land on the same 404. Documents and artifacts are
 * RLS-scoped to what this member may already read. Regenerating an artifact
 * creates a new one (the old stays unless deleted) — stated in the UI copy
 * and in `docs/API_CONTRACTS.md`.
 */
export default async function GeneratePage({ params }: GeneratePageProps) {
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

  const [documents, artifacts, roomRow] = await Promise.all([
    listAskDocuments(supabase, parsedRoomId.data),
    listArtifacts(supabase, {
      roomId: parsedRoomId.data,
      viewerId,
    }),
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
          <h1 className="text-2xl font-semibold">Quizzes &amp; decks</h1>
          {demoMode && <Badge variant="secondary">Demo mode</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          Turn this room&apos;s indexed documents into revision quizzes and
          flashcards. Every question and card is grounded in — and cites — the
          material you select. Generating again creates a new item; the old
          one and its history stay unless you delete them.
        </p>
      </header>

      <GenerateForm
        key={`generate-${parsedRoomId.data}`}
        roomId={parsedRoomId.data}
        documents={documents}
        demoMode={demoMode}
      />

      <ArtifactList
        key={`artifacts-${parsedRoomId.data}`}
        roomId={parsedRoomId.data}
        artifacts={artifacts}
      />
    </section>
  );
}

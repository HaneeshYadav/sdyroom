import { FlashcardDeck } from "@/components/ai/flashcard-deck";
import { Badge } from "@/components/ui/badge";
import { aiConfig } from "@/lib/ai/config";
import {
  GenerateError,
  getArtifact,
  listDueCards,
  type DeckPayloadWithSources,
} from "@/lib/ai/generate";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Flashcards · SdyRoom",
};

export const instant = false;

type DeckPageProps = {
  params: Promise<{ id: string; artifactId: string }>;
};

/**
 * `/rooms/[id]/decks/[artifactId]` — the flashcard reviewer.
 *
 * Membership and visibility are re-proven on every request. The due state
 * is the viewer's own rows only (0019 policy); another member's schedule
 * never appears here. A quiz id or an unready deck gets an honest inline
 * state, not a crash.
 */
export default async function DeckPage({ params }: DeckPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const viewerId = data?.claims?.sub;

  if (!viewerId) {
    redirect("/auth/login");
  }

  const { id, artifactId } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  const parsedArtifactId = roomIdSchema.safeParse(artifactId);
  if (!parsedRoomId.success || !parsedArtifactId.success) {
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

  let artifact;
  try {
    artifact = await getArtifact(supabase, {
      roomId: parsedRoomId.data,
      artifactId: parsedArtifactId.data,
      viewerId,
    });
  } catch (error) {
    if (error instanceof GenerateError && error.code === "not_found") {
      notFound();
    }
    throw error;
  }

  const roomRow = await supabase
    .from("rooms")
    .select("name")
    .eq("id", parsedRoomId.data)
    .maybeSingle();
  const roomName =
    typeof roomRow.data?.name === "string" ? roomRow.data.name : "Study room";
  const demoMode = aiConfig().provider === "mock";

  if (artifact.kind !== "deck" || artifact.status !== "ready" || !artifact.payload) {
    return (
      <section className="flex flex-col gap-4">
        <Link
          href={`/rooms/${parsedRoomId.data}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {roomName}
        </Link>
        <div className="rounded-lg border border-dashed p-8 text-center">
          <h1 className="text-lg font-semibold">This deck is not available</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            It may still be generating, have failed, or the link points at a
            quiz. Generate a new deck to keep revising.
          </p>
        </div>
      </section>
    );
  }

  const due = await listDueCards(supabase, {
    roomId: parsedRoomId.data,
    artifactId: parsedArtifactId.data,
    viewerId,
  });

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`/rooms/${parsedRoomId.data}/generate`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Quizzes &amp; decks
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">Flashcards</h1>
          <Badge variant="outline">{artifact.difficulty}</Badge>
          {demoMode && <Badge variant="secondary">Demo mode</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          Flip each card, then grade it. Grades feed a simple schedule —
          “Got it” cards return in a few days, “Again” cards come back soon.
        </p>
      </header>

      <FlashcardDeck
        key={`deck-${artifact.id}`}
        roomId={parsedRoomId.data}
        artifact={{
          ...artifact,
          payload: artifact.payload as DeckPayloadWithSources,
        }}
        initialDue={due}
      />
    </section>
  );
}

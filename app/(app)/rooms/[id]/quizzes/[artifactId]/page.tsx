import { QuizRunner } from "@/components/ai/quiz-runner";
import { Badge } from "@/components/ui/badge";
import { aiConfig } from "@/lib/ai/config";
import { getArtifact, type QuizPayloadWithSources } from "@/lib/ai/generate";
import { GenerateError } from "@/lib/ai/generate";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Quiz · SdyRoom",
};

export const instant = false;

type QuizPageProps = {
  params: Promise<{ id: string; artifactId: string }>;
};

/**
 * `/rooms/[id]/quizzes/[artifactId]` — the quiz runner.
 *
 * Membership and visibility are re-proven on every request (non-member ≡
 * missing room ≡ same 404). A quiz that is still generating or has failed
 * gets an honest inline state, not a crash; a deck id gets a 404.
 */
export default async function QuizPage({ params }: QuizPageProps) {
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

  const roomName = await roomNameFor(supabase, parsedRoomId.data);
  const demoMode = aiConfig().provider === "mock";

  if (artifact.kind !== "quiz" || !artifact.payload) {
    return (
      <section className="flex flex-col gap-4">
        <Link
          href={`/rooms/${parsedRoomId.data}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {roomName}
        </Link>
        <div className="rounded-lg border border-dashed p-8 text-center">
          <h1 className="text-lg font-semibold">This quiz is not available</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            It may have failed to generate, or the link points at a flashcard
            deck. Generate a new quiz to keep revising.
          </p>
        </div>
      </section>
    );
  }

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
          <h1 className="text-2xl font-semibold">Quiz</h1>
          <Badge variant="outline">{artifact.difficulty}</Badge>
          {demoMode && <Badge variant="secondary">Demo mode</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          One question at a time. Answers are scored on the server; the
          correct option is revealed with its explanation after you submit.
        </p>
      </header>

      <QuizRunner
        key={`quiz-${artifact.id}`}
        roomId={parsedRoomId.data}
        artifact={{
          ...artifact,
          payload: artifact.payload as QuizPayloadWithSources,
        }}
      />
    </section>
  );
}

async function roomNameFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  roomId: string,
): Promise<string> {
  const { data } = await supabase
    .from("rooms")
    .select("name")
    .eq("id", roomId)
    .maybeSingle();
  return typeof data?.name === "string" ? data.name : "Study room";
}

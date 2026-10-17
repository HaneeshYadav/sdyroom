"use client";

/**
 * Flashcard deck viewer (PR-14).
 *
 * Flip is a real button with `aria-pressed` (never hover-only), grading is
 * `Got it / Again`, and each grade is persisted through the `review_card`
 * RPC before the session advances — the server's `due_count` response is
 * what the UI shows, so a reload reflects the same numbers. The session
 * walks due cards first; a completion screen closes it out with the updated
 * due count.
 */

import { CitationList } from "@/components/ai/citation-list";
import { Button } from "@/components/ui/button";
import type {
  ArtifactDetail,
  DeckCardState,
  DeckPayloadWithSources,
  DueCardsResult,
} from "@/lib/ai/generate";
import Link from "next/link";
import { useMemo, useState } from "react";

export type FlashcardDeckProps = {
  roomId: string;
  artifact: ArtifactDetail & { payload: DeckPayloadWithSources };
  initialDue: DueCardsResult;
};

export function FlashcardDeck({ roomId, artifact, initialDue }: FlashcardDeckProps) {
  // Due cards first, then the rest in ordinal order — a stable session.
  const session = useMemo(() => {
    const due = initialDue.cards.filter((card) => card.due);
    const rest = initialDue.cards.filter((card) => !card.due);
    return [...due, ...rest];
  }, [initialDue.cards]);

  const [position, setPosition] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [dueCount, setDueCount] = useState(initialDue.due_count);
  const [gradedCount, setGradedCount] = useState(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sessionDone, setSessionDone] = useState(false);

  const card: DeckCardState | undefined = session[position];

  async function grade(value: "again" | "got_it") {
    if (!card || pending) {
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(
        `/api/rooms/${roomId}/decks/${artifact.id}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ card_ordinal: card.ordinal, grade: value }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setFailure(body?.error?.message ?? "Could not save that grade.");
        return;
      }
      setDueCount(typeof body.due_count === "number" ? body.due_count : 0);
      setGradedCount((count) => count + 1);
      setFlipped(false);
      if (position + 1 >= session.length) {
        setSessionDone(true);
      } else {
        setPosition((current) => current + 1);
      }
    } catch {
      setFailure("The connection dropped before the grade was saved.");
    } finally {
      setPending(false);
    }
  }

  if (session.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">This deck has no cards.</p>
      </div>
    );
  }

  if (sessionDone || !card) {
    return (
      <section className="flex flex-col items-center gap-4 rounded-lg border p-8 text-center">
        <h2 className="text-lg font-semibold">Session complete</h2>
        <p className="text-sm text-muted-foreground" data-testid="deck-session-done">
          You graded {gradedCount} card{gradedCount === 1 ? "" : "s"}.
          {" "}
          {dueCount} card{dueCount === 1 ? "" : "s"} still due later.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setPosition(0);
              setGradedCount(0);
              setSessionDone(false);
              setFlipped(false);
            }}
          >
            Review again
          </Button>
          <Button asChild variant="outline">
            <Link href={`/rooms/${roomId}/generate`}>Back to decks</Link>
          </Button>
        </div>
      </section>
    );
  }

  const citations = card.citations.map((citation) => {
    const source = artifact.payload?.sources[citation.n - 1];
    return {
      n: citation.n,
      resource_id: source?.resource_id ?? "",
      title: source?.title ?? `Source ${citation.n}`,
      href: source?.href ?? `/rooms/${roomId}`,
      ...(source?.pages ? { pages: source.pages } : {}),
    };
  });

  return (
    <section className="flex flex-col gap-4" data-testid="flashcard-deck">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span data-testid="deck-position">
          Card {position + 1} of {session.length}
        </span>
        <span data-testid="deck-due-count">{dueCount} due</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={session.length}
        aria-valuenow={position + (flipped ? 1 : 0)}
        aria-label="Deck session progress"
        className="h-2 overflow-hidden rounded-full bg-accent"
      >
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${(position / session.length) * 100}%` }}
        />
      </div>

      <div className="rounded-lg border p-6 text-center" data-testid="flashcard-card">
        <p className="mb-4 text-xs uppercase tracking-wide text-muted-foreground">
          {flipped ? "Answer" : "Prompt"}
        </p>
        <p className="text-lg font-medium" data-testid="flashcard-text">
          {flipped ? card.back : card.front}
        </p>
        {flipped && citations.length > 0 && (
          <div className="mt-4 flex justify-center">
            <CitationList citations={citations} />
          </div>
        )}
      </div>

      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="outline"
          aria-pressed={flipped}
          onClick={() => setFlipped((current) => !current)}
          data-testid="flashcard-flip"
        >
          {flipped ? "Hide answer" : "Show answer"}
        </Button>
      </div>
      {flipped && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => grade("again")}
            data-testid="flashcard-again"
          >
            Again
          </Button>
          <Button
            disabled={pending}
            onClick={() => grade("got_it")}
            data-testid="flashcard-got-it"
          >
            Got it
          </Button>
        </div>
      )}
    </section>
  );
}

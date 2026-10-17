"use client";

/**
 * "Quizzes & decks" library (PR-14).
 *
 * Lists a room's generated artifacts with honest status chips. Open is a
 * real link (the runner/deck pages re-prove membership server-side);
 * Regenerate creates a *new* artifact from the same settings — the old one
 * and its attempt history stay unless explicitly deleted, which is the
 * auditable choice the spec settled on. Delete is offered only to the
 * creator and confirms first; the RPC re-checks creator rights anyway.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ArtifactSummary } from "@/lib/ai/generate";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

function statusBadge(status: ArtifactSummary["status"], errorCode: string | null) {
  if (status === "ready") {
    return <Badge variant="secondary">Ready</Badge>;
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" title={errorCode ?? undefined}>
        Failed
      </Badge>
    );
  }
  return <Badge variant="outline">Generating…</Badge>;
}

function kindLabel(artifact: ArtifactSummary): string {
  return artifact.kind === "quiz" ? "Quiz" : "Flashcards";
}

function countLabel(artifact: ArtifactSummary): string {
  if (artifact.kind === "quiz" && artifact.question_count) {
    return `${artifact.question_count} questions`;
  }
  if (artifact.kind === "deck" && artifact.card_count) {
    return `${artifact.card_count} cards`;
  }
  return "";
}

export type ArtifactListProps = {
  roomId: string;
  artifacts: ArtifactSummary[];
  /** When true, regenerate opens the generator preselected — v1 just links. */
  headingLevel?: 2 | 3;
};

export function ArtifactList({ roomId, artifacts, headingLevel = 2 }: ArtifactListProps) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function remove(artifact: ArtifactSummary) {
    if (pendingId) {
      return;
    }
    const ok = window.confirm(
      "Delete this item? Its attempts and review history are removed with it.",
    );
    if (!ok) {
      return;
    }
    setPendingId(artifact.id);
    setFailure(null);
    try {
      const response = await fetch(
        `/api/rooms/${roomId}/artifacts/${artifact.id}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setFailure(body?.error?.message ?? "Could not delete that item.");
        return;
      }
      router.refresh();
    } catch {
      setFailure("The connection dropped. Try again.");
    } finally {
      setPendingId(null);
    }
  }

  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <section className="flex flex-col gap-3" data-testid="artifact-list">
      <div className="flex items-center justify-between gap-2">
        <Heading className="text-lg font-semibold">Quizzes &amp; decks</Heading>
        <Button asChild size="sm" variant="outline">
          <Link href={`/rooms/${roomId}/generate`}>Generate new</Link>
        </Button>
      </div>

      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}

      {artifacts.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="artifact-list-empty">
          Nothing generated yet. Quizzes and decks built from this room&apos;s
          documents show up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {artifacts.map((artifact) => (
            <li
              key={artifact.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              data-testid={`artifact-${artifact.kind}-${artifact.status}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{kindLabel(artifact)}</span>
                <span className="text-muted-foreground">{countLabel(artifact)}</span>
                <Badge variant="outline">{artifact.difficulty}</Badge>
                {statusBadge(artifact.status, artifact.error_code)}
                <span className="text-xs text-muted-foreground">
                  {new Date(artifact.created_at).toLocaleDateString()}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {artifact.status === "ready" && (
                  <Button asChild size="sm" variant="secondary">
                    <Link href={artifact.href}>Open</Link>
                  </Button>
                )}
                {artifact.is_creator && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pendingId === artifact.id}
                    onClick={() => remove(artifact)}
                    aria-label={`Delete this ${kindLabel(artifact).toLowerCase()}`}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

"use client";

/**
 * Generator form (PR-14).
 *
 * One generate request creates a `generating` artifact and the client then
 * drives the single bounded step — the same resumable pattern as PR 12's
 * ingest, so a dropped connection can be retried without an in-memory task.
 * Errors map to honest copy (409/403/429/502) with `role="alert"`; zero
 * ready documents disables the form with the reason spelled out, never
 * hidden.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { AskDocument } from "@/lib/ai/ask";
import { DECK_COUNTS, QUIZ_COUNTS } from "@/lib/validation/generate";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

const STATUS_LABELS: Record<string, string> = {
  ready: "Ready",
  pending: "Not indexed",
  extracting: "Indexing…",
  chunking: "Indexing…",
  embedding: "Indexing…",
  failed: "Failed",
};

function errorCopy(code: number | undefined, fallback: string): string {
  switch (code) {
    case 409:
      return "Index at least one document before generating.";
    case 403:
      return "You have reached your daily AI limit. Try again tomorrow.";
    case 429:
      return "You are generating too quickly — wait a moment and try again.";
    case 502:
      return "The AI provider returned unusable material. Try again.";
    default:
      return fallback;
  }
}

export type GenerateFormProps = {
  roomId: string;
  documents: AskDocument[];
  demoMode: boolean;
};

export function GenerateForm({ roomId, documents, demoMode }: GenerateFormProps) {
  const router = useRouter();
  const readyDocuments = useMemo(
    () => documents.filter((document) => document.status === "ready"),
    [documents],
  );

  const [mode, setMode] = useState<"quiz" | "flashcards">("quiz");
  const [count, setCount] = useState<number>(QUIZ_COUNTS[1]);
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const counts = mode === "quiz" ? QUIZ_COUNTS : DECK_COUNTS;

  function changeMode(next: "quiz" | "flashcards") {
    setMode(next);
    const nextCounts = next === "quiz" ? QUIZ_COUNTS : DECK_COUNTS;
    if (!(nextCounts as readonly number[]).includes(count)) {
      setCount(nextCounts[1]);
    }
  }

  function toggleDocument(resourceId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(resourceId);
      } else {
        next.delete(resourceId);
      }
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) {
      return;
    }
    const resourceIds = selected.size > 0 ? [...selected] : undefined;
    if (resourceIds && resourceIds.length === 0) {
      setFailure("Select at least one document.");
      return;
    }

    setPending(true);
    setFailure(null);
    try {
      const createResponse = await fetch(`/api/rooms/${roomId}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          count,
          difficulty,
          ...(resourceIds ? { resource_ids: resourceIds } : {}),
        }),
      });
      const createBody = await createResponse.json().catch(() => null);
      if (!createResponse.ok) {
        setFailure(
          errorCopy(
            createResponse.status,
            createBody?.error?.message ?? "Could not start generation.",
          ),
        );
        return;
      }

      const artifactId = createBody?.artifact?.id as string;
      const stepResponse = await fetch(
        `/api/rooms/${roomId}/generate/${artifactId}/step`,
        { method: "POST" },
      );
      const stepBody = await stepResponse.json().catch(() => null);
      if (!stepResponse.ok) {
        setFailure(
          errorCopy(
            stepResponse.status,
            stepBody?.error?.message ?? "Generation failed.",
          ),
        );
        return;
      }
      if (stepBody?.status !== "ready") {
        setFailure(
          stepBody?.error_code === "no_documents_indexed"
            ? "Those documents have no indexed text to generate from."
            : "Generation failed. Try again.",
        );
        return;
      }

      const href = createBody?.artifact?.href as string | undefined;
      router.push(href ?? `/rooms/${roomId}`);
      router.refresh();
    } catch {
      setFailure("The connection dropped before generation finished. Try again.");
    } finally {
      setPending(false);
    }
  }

  if (readyDocuments.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center"
        data-testid="generate-empty"
      >
        <h2 className="text-base font-semibold">Nothing to generate from yet</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Upload a document to Resources and wait until it is indexed — then
          quizzes and flashcards can be generated from it.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-lg border p-4"
      data-testid="generate-form"
    >
      {demoMode && (
        <div
          className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
          data-testid="generate-demo-banner"
        >
          <Badge variant="secondary">Demo mode</Badge>
          <span>Generated material is canned demo content — no provider key is configured.</span>
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="generate-mode">Type</Label>
          <Select
            id="generate-mode"
            value={mode}
            onChange={(event) =>
              changeMode(event.target.value as "quiz" | "flashcards")}
            className="w-44"
          >
            <option value="quiz">Quiz</option>
            <option value="flashcards">Flashcards</option>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="generate-count">Length</Label>
          <Select
            id="generate-count"
            value={String(count)}
            onChange={(event) => setCount(Number(event.target.value))}
            className="w-40"
          >
            {counts.map((option) => (
              <option key={option} value={option}>
                {option} {mode === "quiz" ? "questions" : "cards"}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="generate-difficulty">Difficulty</Label>
          <Select
            id="generate-difficulty"
            value={difficulty}
            onChange={(event) =>
              setDifficulty(event.target.value as "easy" | "medium" | "hard")}
            className="w-32"
          >
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </Select>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Documents</legend>
        <p className="text-xs text-muted-foreground">
          Leave all unselected to use every indexed document in this room.
        </p>
        {documents.map((document) => {
          const ready = document.status === "ready";
          return (
            <div key={document.resource_id} className="flex items-center gap-2">
              <Checkbox
                id={`generate-doc-${document.resource_id}`}
                checked={selected.has(document.resource_id)}
                disabled={!ready || pending}
                onCheckedChange={(checked) =>
                  toggleDocument(document.resource_id, checked === true)}
              />
              <Label
                htmlFor={`generate-doc-${document.resource_id}`}
                className={ready ? "" : "text-muted-foreground"}
              >
                {document.title}
                {!ready && (
                  <span className="ml-2 text-xs">
                    {STATUS_LABELS[document.status] ?? document.status}
                  </span>
                )}
              </Label>
            </div>
          );
        })}
      </fieldset>

      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}

      <div>
        <Button type="submit" disabled={pending} data-testid="generate-submit">
          {pending ? "Generating…" : "Generate"}
        </Button>
      </div>
    </form>
  );
}

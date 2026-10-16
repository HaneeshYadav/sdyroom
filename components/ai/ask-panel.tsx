"use client";

/**
 * "Ask my notes" panel (PR-13, spec §5/§6).
 *
 * Owns the composer, the scope selector and the streaming transcript. The
 * server has already decided membership and document visibility; everything
 * here is presentation over the three ask endpoints. Answers render as plain
 * text (no markdown library ships) with `[n]` markers, and the citation list
 * beneath each answer is the accessible, keyboard-reachable path to sources.
 *
 * The transcript is a polite live region so a screen reader announces a
 * finished answer without stealing focus mid-stream; the streaming answer
 * itself is announced once, on completion, not on every delta.
 */

import { AnswerMarkers } from "@/components/ai/answer-markdown";
import { CitationList } from "@/components/ai/citation-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  AskDocument,
  AskHistoryItem,
  AskStreamEvent,
  StoredCitation,
} from "@/lib/ai/ask";
import { useCallback, useMemo, useRef, useState } from "react";

type Turn = {
  key: string;
  question: string;
  answer: string;
  citations: StoredCitation[];
  status: "streaming" | "done" | "failed";
  /** Set when the stream failed; shown instead of the answer. */
  failure?: string;
};

const STATUS_LABELS: Record<string, string> = {
  ready: "Ready",
  pending: "Not indexed",
  extracting: "Indexing…",
  chunking: "Indexing…",
  embedding: "Indexing…",
  failed: "Failed",
};

function historyToTurn(item: AskHistoryItem): Turn {
  return {
    key: item.id,
    question: item.question,
    answer: item.answer,
    citations: item.citations,
    status: "done",
  };
}

export type AskPanelProps = {
  roomId: string;
  documents: AskDocument[];
  initialHistory: AskHistoryItem[];
  /** True when no AI provider is configured — drives the demo banner. */
  demoMode: boolean;
};

export function AskPanel({
  roomId,
  documents,
  initialHistory,
  demoMode,
}: AskPanelProps) {
  // Newest-first from the API; the transcript reads oldest-first like a
  // conversation, so the initial page is reversed once at the boundary.
  const [turns, setTurns] = useState<Turn[]>(() =>
    [...initialHistory].reverse().map(historyToTurn),
  );
  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const conversationId = useRef<string>(crypto.randomUUID());

  const readyDocuments = useMemo(
    () => documents.filter((document) => document.status === "ready"),
    [documents],
  );

  const updateTurn = useCallback((key: string, patch: Partial<Turn>) => {
    setTurns((current) =>
      current.map((turn) => (turn.key === key ? { ...turn, ...patch } : turn)),
    );
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = question.trim();
      if (trimmed === "" || pending) {
        return;
      }

      const key = crypto.randomUUID();
      setPending(true);
      setQuestion("");
      setTurns((current) => [
        ...current,
        {
          key,
          question: trimmed,
          answer: "",
          citations: [],
          status: "streaming",
        },
      ]);

      try {
        const response = await fetch(`/api/rooms/${roomId}/ask`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question: trimmed,
            ...(selected.size > 0 ? { resource_ids: [...selected] } : {}),
            conversation_id: conversationId.current,
          }),
        });

        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => null)) as {
            error?: { code?: string; message?: string };
          } | null;
          updateTurn(key, {
            status: "failed",
            failure:
              body?.error?.message ??
              "That question could not be answered. Try again.",
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sawDone = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let newlineAt = buffer.indexOf("\n");
          while (newlineAt !== -1) {
            const line = buffer.slice(0, newlineAt).trim();
            buffer = buffer.slice(newlineAt + 1);
            newlineAt = buffer.indexOf("\n");
            if (line === "") {
              continue;
            }
            let event: AskStreamEvent;
            try {
              event = JSON.parse(line) as AskStreamEvent;
            } catch {
              continue;
            }
            if (event.type === "citations") {
              updateTurn(key, { citations: event.citations });
            } else if (event.type === "delta") {
              setTurns((current) =>
                current.map((turn) =>
                  turn.key === key
                    ? { ...turn, answer: turn.answer + event.text }
                    : turn,
                ),
              );
            } else if (event.type === "done") {
              sawDone = true;
              updateTurn(key, { status: "done" });
            } else {
              // Terminal error event: the stream opened but failed midway.
              updateTurn(key, {
                status: "failed",
                failure: "The answer was interrupted. Try again.",
              });
              sawDone = true;
            }
          }
        }

        if (!sawDone) {
          updateTurn(key, {
            status: "failed",
            failure: "The connection dropped before the answer finished.",
          });
        }
      } catch {
        updateTurn(key, {
          status: "failed",
          failure: "The question could not be sent. Check your connection.",
        });
      } finally {
        setPending(false);
      }
    },
    [conversationId, pending, question, roomId, selected, updateTurn],
  );

  const newQuestion = useCallback(() => {
    conversationId.current = crypto.randomUUID();
    setQuestion("");
  }, []);

  const toggleDocument = useCallback((resourceId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(resourceId);
      } else {
        next.delete(resourceId);
      }
      return next;
    });
  }, []);

  return (
    <section className="flex flex-col gap-6" aria-label="Ask my notes">
      {demoMode && (
        <div
          data-testid="ask-demo-banner"
          className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-3"
        >
          <Badge variant="secondary">Demo mode</Badge>
          <p className="text-sm text-muted-foreground">
            No AI provider is configured, so answers are canned demo text.
            Citations still point at real retrieved documents.
          </p>
        </div>
      )}

      {readyDocuments.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <h2 className="text-base font-semibold">Nothing to ask yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Index at least one document in this room&apos;s Resources, then
            come back to ask questions about it.
          </p>
        </div>
      ) : (
        <>
          {documents.length > 0 && (
            <fieldset className="rounded-lg border p-4">
              <legend className="px-1 text-sm font-medium">
                Ask about
              </legend>
              <p className="px-1 text-xs text-muted-foreground">
                {selected.size === 0
                  ? "All indexed room documents (select some to narrow)."
                  : `Selected: ${selected.size} of ${readyDocuments.length} ready documents.`}
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {documents.map((document) => {
                  const ready = document.status === "ready";
                  return (
                    <div
                      key={document.resource_id}
                      className="flex items-center gap-2"
                    >
                      <Checkbox
                        id={`ask-doc-${document.resource_id}`}
                        checked={selected.has(document.resource_id)}
                        disabled={!ready || pending}
                        onCheckedChange={(checked) =>
                          toggleDocument(document.resource_id, checked === true)
                        }
                      />
                      <Label
                        htmlFor={`ask-doc-${document.resource_id}`}
                        className={
                          ready
                            ? "cursor-pointer text-sm"
                            : "text-sm text-muted-foreground"
                        }
                      >
                        {document.title}{" "}
                        <span className="text-xs text-muted-foreground">
                          ·{" "}
                          {ready
                            ? `${STATUS_LABELS[document.status] ?? document.status} (${document.chunks} chunks)`
                            : (STATUS_LABELS[document.status] ??
                              document.status)}
                        </span>
                      </Label>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          )}

          <form onSubmit={submit} className="flex flex-col gap-3">
            <Label htmlFor="ask-question" className="sr-only">
              Your question
            </Label>
            <Textarea
              id="ask-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask a question about this room's documents…"
              rows={3}
              maxLength={2000}
              disabled={pending}
              required
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={pending || question.trim() === ""}>
                {pending ? "Asking…" : "Ask"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={newQuestion}
                disabled={pending}
              >
                New question
              </Button>
            </div>
          </form>

          <div
            role="log"
            aria-live="polite"
            aria-label="Conversation"
            className="flex flex-col gap-4"
            data-testid="ask-transcript"
          >
            {turns.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Ask your first question — answers cite the documents they come
                from.
              </p>
            )}
            {turns.map((turn) => (
              <article key={turn.key} className="rounded-lg border p-4">
                <h3 className="text-sm font-semibold">{turn.question}</h3>
                {turn.status === "failed" ? (
                  <p role="alert" className="mt-2 text-sm text-destructive">
                    {turn.failure ?? "Something went wrong."}
                  </p>
                ) : (
                  <>
                    <div className="mt-2">
                      <AnswerMarkers
                        answer={turn.answer}
                        citationCount={turn.citations.length}
                      />
                    </div>
                    {turn.status === "done" && turn.citations.length === 0 && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No relevant passages were found in the selected
                        documents for this question.
                      </p>
                    )}
                    {turn.status === "done" && (
                      <CitationList citations={turn.citations} />
                    )}
                    {turn.status === "streaming" && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        Thinking…
                      </p>
                    )}
                  </>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

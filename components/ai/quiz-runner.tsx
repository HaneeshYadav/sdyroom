"use client";

/**
 * Quiz runner (PR-14).
 *
 * One question at a time with a real progressbar, a radiogroup of options
 * (keyboard-operable by construction), and an explicit submit. Options are
 * shuffled per attempt with a deterministic seed (artifact id + attempt
 * number), so a retake presents a fresh order while tests stay reproducible.
 * The answer key never reaches the DOM before submit: `correct_index` is
 * only used after the server has scored the attempt, and the completion
 * screen renders the server's results — explanations and citations included.
 *
 * Scoring itself is server-side (`record_attempt`); this component only
 * collects chosen indices and displays what comes back.
 */

import { AnswerMarkers } from "@/components/ai/answer-markdown";
import { CitationList } from "@/components/ai/citation-list";
import { Button } from "@/components/ui/button";
import type {
  Attempt,
  ArtifactDetail,
  QuizPayloadWithSources,
} from "@/lib/ai/generate";
import Link from "next/link";
import { useMemo, useState } from "react";

/** FNV-1a + mulberry32: stable per (artifact, attempt), tiny, dependency-free. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher–Yates over [0..n) — the display order of options. */
export function shuffledOptionOrder(
  optionCount: number,
  seedText: string,
): number[] {
  const order = Array.from({ length: optionCount }, (_, index) => index);
  const random = mulberry32(fnv1a(seedText));
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

export type QuizRunnerProps = {
  roomId: string;
  artifact: ArtifactDetail & { payload: QuizPayloadWithSources };
};

export function QuizRunner({ roomId, artifact }: QuizRunnerProps) {
  const questions = artifact.payload.questions;
  const sources = artifact.payload.sources;
  const total = questions.length;

  const [attemptNumber, setAttemptNumber] = useState(0);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>(
    () => Array.from({ length: total }, () => null),
  );
  const [result, setResult] = useState<Attempt | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [startedAt] = useState(() => Date.now());

  const order = useMemo(
    () =>
      shuffledOptionOrder(
        questions[index].options.length,
        `${artifact.id}:${attemptNumber}:${index}`,
      ),
    [artifact.id, attemptNumber, index, questions],
  );

  const answered = answers.filter((answer) => answer !== null).length;
  const current = questions[index];

  function choose(originalIndex: number) {
    setAnswers((currentAnswers) => {
      const next = [...currentAnswers];
      next[index] = originalIndex;
      return next;
    });
  }

  async function submit() {
    if (pending) {
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(
        `/api/rooms/${roomId}/quizzes/${artifact.id}/attempts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            answers: answers.map((answer) => answer ?? -1),
            duration_ms: Date.now() - startedAt,
          }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setFailure(body?.error?.message ?? "Could not submit that attempt.");
        return;
      }
      setResult(body.attempt as Attempt);
    } catch {
      setFailure("The connection dropped before the attempt was recorded.");
    } finally {
      setPending(false);
    }
  }

  function retake() {
    setAttemptNumber((number) => number + 1);
    setIndex(0);
    setAnswers(Array.from({ length: total }, () => null));
    setResult(null);
    setFailure(null);
  }

  if (result) {
    return (
      <section className="flex flex-col gap-6" data-testid="quiz-result">
        <div
          role="status"
          className="rounded-lg border p-4 text-lg font-semibold"
          data-testid="quiz-score"
        >
          Score: {result.score} / {result.total}
        </div>

        <ol className="flex flex-col gap-4">
          {result.results.map((item) => {
            const question = questions[item.ordinal];
            const correct = result.correct[item.ordinal];
            return (
              <li key={item.ordinal} className="rounded-lg border p-4">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <p className="font-medium">
                    {item.ordinal + 1}. {question.prompt}
                  </p>
                  <span
                    className={
                      correct
                        ? "text-sm font-medium text-emerald-600 dark:text-emerald-400"
                        : "text-sm font-medium text-destructive"
                    }
                  >
                    {correct ? "Correct" : "Incorrect"}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Your answer:{" "}
                  {item.chosen === null
                    ? "—"
                    : question.options[item.chosen] ?? "—"}
                </p>
                {!correct && (
                  <p className="text-sm">
                    Correct answer: {question.options[item.correct_index]}
                  </p>
                )}
                <div className="mt-2">
                  <AnswerMarkers
                    answer={item.explanation}
                    citationCount={item.citations.length}
                  />
                </div>
                {item.citations.length > 0 && (
                  <div className="mt-2">
                    <CitationList
                      citations={item.citations.map((citation) => {
                        const source = sources[citation.n - 1];
                        return {
                          n: citation.n,
                          resource_id: source?.resource_id ?? "",
                          title: source?.title ?? `Source ${citation.n}`,
                          href: source?.href ?? `/rooms/${roomId}`,
                          ...(source?.pages ? { pages: source.pages } : {}),
                        };
                      })}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap gap-2">
          <Button onClick={retake} data-testid="quiz-retake">
            Retake
          </Button>
          <Button asChild variant="outline">
            <Link href={`/rooms/${roomId}/generate`}>Back to quizzes</Link>
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4" data-testid="quiz-runner">
      <div className="flex items-center justify-between gap-3">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={answered}
          aria-label="Quiz progress"
          className="h-2 flex-1 overflow-hidden rounded-full bg-accent"
        >
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${(answered / total) * 100}%` }}
          />
        </div>
        <span className="text-sm text-muted-foreground" data-testid="quiz-progress">
          {answered} / {total} answered
        </span>
      </div>

      <fieldset
        key={`${artifact.id}:${attemptNumber}:${index}`}
        className="flex flex-col gap-3 rounded-lg border p-4"
      >
        <legend className="px-1 text-sm text-muted-foreground">
          Question {index + 1} of {total}
        </legend>
        <p className="font-medium" data-testid="quiz-question">
          {current.prompt}
        </p>
        <div role="radiogroup" aria-label={current.prompt} className="flex flex-col gap-2">
          {order.map((originalIndex) => {
            const option = current.options[originalIndex];
            const selected = answers[index] === originalIndex;
            return (
              <label
                key={originalIndex}
                className={
                  selected
                    ? "flex cursor-pointer items-center gap-2 rounded-md border border-primary bg-accent p-2 text-sm"
                    : "flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm"
                }
              >
                <input
                  type="radio"
                  name={`question-${index}`}
                  className="accent-primary"
                  checked={selected}
                  onChange={() => choose(originalIndex)}
                  data-testid={`quiz-option-${originalIndex}`}
                />
                <span>{option}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={index === 0}
          onClick={() => setIndex((current) => Math.max(0, current - 1))}
        >
          Previous
        </Button>
        {index < total - 1 ? (
          <Button
            onClick={() => setIndex((current) => Math.min(total - 1, current + 1))}
            data-testid="quiz-next"
          >
            Next
          </Button>
        ) : (
          <Button
            onClick={submit}
            disabled={pending || answered < total}
            data-testid="quiz-submit"
          >
            {pending ? "Submitting…" : "Submit answers"}
          </Button>
        )}
      </div>
    </section>
  );
}

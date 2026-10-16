/**
 * Plain-text answer renderer with citation markers (PR-13, spec §6).
 *
 * This repo ships no markdown library, so the answer is rendered as plain
 * text — every character is a React text node, which means document-derived
 * or model-derived content can never become DOM. The only markup the UI
 * interprets is an in-range `[n]` marker, drawn as a superscript that
 * corresponds to the n-th item of the citation list beneath it.
 */

import { Fragment } from "react";

const MARKER_PATTERN = /\[(\d{1,3})\]/g;

export type AnswerMarkersProps = {
  answer: string;
  /** How many citations the answer may point at; out-of-range is stripped. */
  citationCount: number;
};

export function AnswerMarkers({ answer, citationCount }: AnswerMarkersProps) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of answer.matchAll(MARKER_PATTERN)) {
    const n = Number.parseInt(match[1], 10);
    if (n < 1 || n > citationCount) {
      continue;
    }
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push(answer.slice(lastIndex, start));
    }
    parts.push(
      <sup
        key={`${start}-${n}`}
        className="mx-0.5 text-[0.7em] font-medium text-primary"
        aria-hidden="true"
      >
        [{n}]
      </sup>,
    );
    lastIndex = start + match[0].length;
  }
  if (lastIndex < answer.length) {
    parts.push(answer.slice(lastIndex));
  }

  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          <Fragment key={index}>{part}</Fragment>
        ) : (
          part
        ),
      )}
    </p>
  );
}

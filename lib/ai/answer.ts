/**
 * Answer post-processing for "Ask my notes" (PR-13, spec §3/§5).
 *
 * The model's completion is stored and displayed as plain text — this repo
 * ships no markdown renderer, so citation markers are the only markup the UI
 * interprets. Two rules keep the stored answer honest:
 *
 *   * every surviving `[n]` marker refers to a real citation the retrieval
 *     pipeline actually produced (out-of-range markers are stripped);
 *   * the "Sources:" footer is appended by the application from those same
 *     citations — it is never trusted from the model, so a completion that
 *     lists a page number we do not hold cannot leak it into the footer.
 */

import type { CitationRef } from "./retrieve";

const MARKER_PATTERN = /\[(\d{1,3})\]/g;

/**
 * The `[n]` markers present in `text`, in appearance order, deduplicated.
 * n is parsed as base-10 (`[007]` → 7); values above 999 are ignored (the
 * context budget caps sources far below that anyway).
 */
export function extractCitationMarkers(text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const match of text.matchAll(MARKER_PATTERN)) {
    const n = Number.parseInt(match[1], 10);
    if (!Number.isFinite(n) || n < 1 || n > 999 || seen.has(n)) {
      continue;
    }
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Strips every `[n]` marker that does not point at one of the first
 * `citationCount` citations. In-range markers — including repeated ones for
 * the same source — are kept verbatim, whitespace included.
 */
export function sanitizeAnswerMarkers(text: string, citationCount: number): string {
  return text.replace(MARKER_PATTERN, (marker, digits: string) => {
    const n = Number.parseInt(digits, 10);
    return n >= 1 && n <= citationCount ? marker : "";
  });
}

/**
 * One `Sources:` line built from the actual citations, in citation order:
 * `[1] Title (p. 12), [2] Title`. Returns the original answer untouched when
 * there are no citations — an honest empty list beats a fabricated footer.
 */
export function appendSourcesFooter(answer: string, citations: CitationRef[]): string {
  if (citations.length === 0) {
    return answer;
  }
  const parts = citations.map((citation, index) => {
    const pages = citation.pages;
    const page = pages && pages.length > 0 ? ` (p. ${pages.join(", ")})` : "";
    return `[${index + 1}] ${citation.title}${page}`;
  });
  return `${answer.trimEnd()}\n\nSources: ${parts.join(", ")}`;
}

/**
 * Full pipeline for a completed answer: strip orphans against the citations
 * that were actually used, then append the application-built footer.
 */
export function finalizeAnswer(answer: string, citations: CitationRef[]): string {
  const sanitized = sanitizeAnswerMarkers(answer, citations.length);
  return appendSourcesFooter(sanitized, citations);
}

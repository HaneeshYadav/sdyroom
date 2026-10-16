/**
 * Chunking — deterministic text → `ChunkDraft[]`.
 *
 * Invariants (spec + database CHECKs, asserted by unit tests):
 *
 *   * targets: ~800 tokens (3200 chars at 4 chars/token) with ~120 tokens
 *     (480 chars) of overlap, never a window larger than the target;
 *   * a chunk never spans a page boundary (`\f` from PDF extraction) — page
 *     references must stay true; `page_start` is 1-based for PDFs;
 *   * Markdown splits at ATX headings and carries the nearest heading, so a
 *     later citation can say "Chapter 3" rather than a bare resource;
 *   * ordinals are 0-based and assigned in reading order across the whole
 *     document, so re-runs over identical text produce identical rows and
 *     `sha256(resource_id || ordinal || text)` hashes match (idempotency);
 *   * every emitted chunk satisfies the table's `1..16000` char and
 *     `1..100000` token bounds.
 *
 * Same input, same output — no randomness, no time, no environment.
 */

import { estimateTokens } from "./tokens";
import type { ChunkDraft } from "./types";

export const CHUNK_TARGET_TOKENS = 800;
export const CHUNK_OVERLAP_TOKENS = 120;

export const CHUNK_TARGET_CHARS = CHUNK_TARGET_TOKENS * 4; // 3200
export const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * 4; // 480

const PAGE_SEPARATOR = "\f";
const MAX_HEADING_CHARS = 500;
const MAX_CHUNK_CHARS = 16_000;

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;

type Segment = {
  text: string;
  heading: string | null;
};

/**
 * Finds the cut point for a window starting at `start`: the last whitespace
 * at or before `limit` (so words are not split), or `limit` itself when the
 * text has no whitespace in range (a pathological unbroken run).
 */
function findCut(text: string, start: number, limit: number): number {
  const bounded = Math.min(limit, text.length);
  for (let index = bounded; index > start; index -= 1) {
    if (/\s/.test(text[index - 1])) {
      return index;
    }
  }
  return bounded;
}

/**
 * Splits one page/section into windows of at most `CHUNK_TARGET_CHARS` with
 * overlap. The cursor always moves forward (an overlap can never rewind past
 * the previous start), so termination is guaranteed even for dense text.
 */
function windowSegment(text: string): string[] {
  const windows: string[] = [];
  let start = 0;

  while (text.length - start > CHUNK_TARGET_CHARS) {
    const cut = findCut(text, start, start + CHUNK_TARGET_CHARS);
    if (cut <= start) {
      // Defensive: findCut always returns > start given the loop condition,
      // but a forward-only cursor is the invariant that matters.
      break;
    }
    windows.push(text.slice(start, cut));
    const overlapped = cut - CHUNK_OVERLAP_CHARS;
    start = overlapped > start ? overlapped : cut;
  }

  const tail = text.slice(start);
  if (tail.trim() !== "") {
    windows.push(tail);
  }

  return windows;
}

/**
 * Heading-aware segmentation for Markdown: an ATX heading opens a new
 * segment that carries it; everything else continues the current one.
 */
function splitMarkdownSegments(page: string): Segment[] {
  const segments: Segment[] = [];
  let currentHeading: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join("\n").replace(/\s+$/, "");
    if (body.trim() !== "") {
      segments.push({ text: body, heading: currentHeading });
    }
    buffer = [];
  };

  for (const line of page.split("\n")) {
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      flush();
      currentHeading = heading[2].slice(0, MAX_HEADING_CHARS);
      // The heading itself belongs to its segment so its words are indexable.
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();

  return segments;
}

function splitPlainSegments(page: string): Segment[] {
  if (page.trim() === "") {
    return [];
  }
  return [{ text: page.replace(/\s+$/, ""), heading: null }];
}

export type ChunkDocumentOptions = {
  /**
   * True for PDFs: every chunk then carries its 1-based page. Plain formats
   * have no pages, so `page_start` stays null (the column allows it).
   */
  pdf?: boolean;
  /** Markdown-aware heading segmentation; on for `text/markdown`. */
  markdown?: boolean;
};

/**
 * The whole pipeline: text (optionally `\f`-separated) → ordered drafts.
 *
 * Returns `[]` only for input with no indexable content; the caller turns
 * that into `no_text_layer`, the single place that failure is decided.
 */
export function chunkDocument(
  text: string,
  options: ChunkDocumentOptions = {},
): ChunkDraft[] {
  const pages = text.split(PAGE_SEPARATOR);
  const hasPages = options.pdf === true;
  const drafts: ChunkDraft[] = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (page.trim() === "") {
      continue;
    }
    const pageStart = hasPages ? pageIndex + 1 : null;
    const segments = options.markdown
      ? splitMarkdownSegments(page)
      : splitPlainSegments(page);

    for (const segment of segments) {
      for (const window of windowSegment(segment.text)) {
        const trimmed = window.trim();
        if (trimmed === "") {
          continue;
        }
        drafts.push({
          ordinal: drafts.length,
          text: trimmed.slice(0, MAX_CHUNK_CHARS),
          tokens: estimateTokens(trimmed),
          page_start: pageStart,
          heading: segment.heading,
        });
      }
    }
  }

  return drafts;
}

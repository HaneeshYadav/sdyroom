/**
 * The deterministic mock provider — demo mode and CI without secrets.
 *
 * Vectors are derived from the input text with a stable hash, so:
 *
 *   * the same text always embeds to the same vector (idempotent re-runs,
 *     reproducible tests);
 *   * different texts land in a positive-orthant subspace where pairwise
 *     cosine similarity sits well above the retrieval threshold (≈0.7), so
 *     `match_document_chunks` exercises its real code paths end to end;
 *   * nothing here pretends to be semantic understanding — the model name
 *     `mock-embedding-1536` says exactly what it is, and every response
 *     carries `provider: "mock"` for the UI's demo banner.
 */

import type { CompleteInput, CompleteResult, EmbedResult, AiProvider } from "../provider";
import { estimateTokens } from "../tokens";
import { AI_EMBEDDING_DIMENSIONS } from "../types";

export const MOCK_EMBED_MODEL = "mock-embedding-1536";
export const MOCK_CHAT_MODEL = "mock-chat-1";

export const MOCK_COMPLETION =
  "Demo mode: no AI provider is configured, so this is a canned response.";

/** FNV-1a — tiny, stable, and good enough to seed per-text vectors. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — a small, fully deterministic PRNG. */
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

/**
 * A stable unit-length-ish vector of positive values for one text.
 * Positive-only coordinates keep any two distinct vectors' cosine similarity
 * comfortably positive (~0.5–0.9), which is what lets mocked retrieval return
 * rows through the real threshold check.
 */
export function mockEmbedding(
  text: string,
  dimensions: number = AI_EMBEDDING_DIMENSIONS,
): number[] {
  const random = mulberry32(fnv1a(text));
  const vector: number[] = new Array<number>(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = 0.2 + random() * 0.8;
  }
  return vector;
}

export const mockProvider: AiProvider = {
  name: "mock",

  async embed(texts: string[]): Promise<EmbedResult> {
    return {
      vectors: texts.map((text) => mockEmbedding(text)),
      tokens: texts.reduce((total, text) => total + estimateTokens(text), 0),
      model: MOCK_EMBED_MODEL,
      provider: "mock",
    };
  },

  async complete(input: CompleteInput): Promise<CompleteResult> {
    // Estimated usage mirrors a real call (prompt + completion) so later
    // consumers of `tokens` see realistic numbers even in demo mode.
    const promptTokens = input.messages.reduce(
      (total, message) => total + estimateTokens(message.content),
      0,
    );
    const completionTokens = estimateTokens(MOCK_COMPLETION);
    return {
      text: MOCK_COMPLETION,
      tokens: promptTokens + completionTokens,
      model: MOCK_CHAT_MODEL,
      provider: "mock",
    };
  },
};

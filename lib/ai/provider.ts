/**
 * The provider seam (spec: `lib/ai/provider.ts`).
 *
 * One narrow interface, two implementations, chosen at runtime from
 * environment configuration — so ops can point the app at any
 * OpenAI-shaped endpoint without a code change:
 *
 *   * `mock`  — deterministic vectors and a canned completion; active only
 *               when no key is configured (or `AI_PROVIDER=mock`), so CI and
 *               demos run without secrets or spend;
 *   * `openai` — plain `fetch` against `{AI_BASE_URL}/embeddings` and
 *               `/chat/completions`. A configured-but-failing key throws
 *               `AiProviderError` and never falls back to mock: a production
 *               key problem has to be loud.
 *
 * Contract for callers: `embed` never returns a vector of the wrong width
 * (enforced here, not per call site), the API key never appears in a message,
 * a log line, or a returned value, and no document text is ever logged.
 */

import { aiConfig, type AiConfig, type ResolvedProviderName } from "./config";
import { mockProvider } from "./providers/mock";
import { createOpenAiProvider } from "./providers/openai";
import { AI_EMBEDDING_DIMENSIONS } from "./types";

export { AI_EMBEDDING_DIMENSIONS };

/**
 * Every provider failure reaches the route as `502 ai_provider_failed`.
 * `message` is safe to log: providers populate it with status codes and
 * transport errors only — never headers, never body contents.
 */
export class AiProviderError extends Error {
  readonly code = "ai_provider_failed" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiProviderError";
  }
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type EmbedResult = {
  /** One vector per input, in input order, each of length 1536. */
  vectors: number[][];
  /** Prompt tokens as reported by the provider (mock estimates). */
  tokens: number;
  model: string;
  provider: ResolvedProviderName;
};

export type CompleteInput = {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
};

export type CompleteResult = {
  text: string;
  tokens: number;
  model: string;
  provider: ResolvedProviderName;
};

export type AiProvider = {
  readonly name: ResolvedProviderName;
  embed(texts: string[]): Promise<EmbedResult>;
  complete(input: CompleteInput): Promise<CompleteResult>;
};

/** Provider-side batch size for one embeddings request (spec: "e.g. 64"). */
export const EMBED_BATCH_SIZE = 64;

/**
 * Defends the width invariant for every implementation: a provider returning
 * a malformed vector is a provider failure, not a database error waiting to
 * happen at insert time.
 */
export function assertEmbeddingShape(
  vectors: number[][],
  expected: number = AI_EMBEDDING_DIMENSIONS,
): void {
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== expected) {
      throw new AiProviderError(
        `embedding width mismatch: expected ${expected} dimensions`,
      );
    }
    for (const value of vector) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new AiProviderError("embedding contained a non-finite value");
      }
    }
  }
}

/**
 * Resolves the implementation for this process. `config` is injectable so
 * unit tests can drive every environment combination without mutating
 * `process.env`.
 */
export function getProvider(config: AiConfig = aiConfig()): AiProvider {
  if (config.provider === "mock") {
    return mockProvider;
  }
  return createOpenAiProvider(config);
}

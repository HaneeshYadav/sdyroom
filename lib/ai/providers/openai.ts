/**
 * OpenAI-compatible provider — plain `fetch`, no SDK.
 *
 * Any endpoint that speaks the OpenAI wire format works: the official API,
 * an Azure/OpenAI-shaped gateway, a local server. Configuration comes from
 * `lib/ai/config.ts`; the key travels only in the `Authorization` header of
 * an outbound server-to-server request and is never logged, never placed in
 * an error message, and never returned to a caller.
 *
 * Failure discipline (spec): a transport error, a non-2xx status, or an
 * unreadable body all raise `AiProviderError` — the route answers
 * `502 ai_provider_failed` and the row stays resumable. There is no path
 * back to the mock provider once a real one is configured.
 */

import type { AiConfig } from "../config";
import {
  AiProviderError,
  assertEmbeddingShape,
  EMBED_BATCH_SIZE,
  type AiProvider,
  type CompleteInput,
  type CompleteResult,
  type EmbedResult,
} from "../provider";
import { estimateTokens } from "../tokens";
import { AI_EMBEDDING_DIMENSIONS } from "../types";

/** Generous enough for a 64-text embed batch, short enough to bound a step. */
const REQUEST_TIMEOUT_MS = 30_000;

type EmbeddingEntry = { index?: number; embedding?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One POST to `{baseUrl}{path}`. Returns the parsed JSON body or throws
 * `AiProviderError` — the only error type this pipeline treats as a provider
 * outage. Response bodies are validated, never logged: an error payload from
 * a provider is untrusted data with no place in this app's logs.
 */
async function callProvider(
  config: AiConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (config.apiKey === null) {
    // `AI_PROVIDER=openai` without `AI_API_KEY`: a configuration mistake
    // that must fail loudly rather than silently degrade to demo mode.
    throw new AiProviderError("AI provider is configured without an API key");
  }

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AiProviderError("AI provider request failed", { cause: error });
  }

  if (!response.ok) {
    throw new AiProviderError(
      `AI provider responded with status ${response.status}`,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new AiProviderError("AI provider returned an unreadable response", {
      cause: error,
    });
  }
}

export function createOpenAiProvider(config: AiConfig): AiProvider {
  async function embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) {
      return {
        vectors: [],
        tokens: 0,
        model: config.embedModel,
        provider: "openai",
      };
    }

    const vectors: number[][] = [];
    let tokens = 0;

    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      const payload = await callProvider(config, "/embeddings", {
        model: config.embedModel,
        input: batch,
      });

      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new AiProviderError("embeddings response was malformed");
      }

      const entries = payload.data as EmbeddingEntry[];
      const ordered = entries
        .map((entry, position) => ({
          index: typeof entry.index === "number" ? entry.index : position,
          embedding: entry.embedding,
        }))
        .sort((a, b) => a.index - b.index);

      if (ordered.length !== batch.length) {
        throw new AiProviderError("embeddings response count mismatch");
      }

      for (const entry of ordered) {
        if (!Array.isArray(entry.embedding)) {
          throw new AiProviderError("embeddings response was missing a vector");
        }
        vectors.push(entry.embedding as number[]);
      }

      const usage = isRecord(payload.usage) ? payload.usage : null;
      const prompt = usage && typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : batch.reduce((total, text) => total + estimateTokens(text), 0);
      tokens += prompt;
    }

    assertEmbeddingShape(vectors, AI_EMBEDDING_DIMENSIONS);
    return { vectors, tokens, model: config.embedModel, provider: "openai" };
  }

  async function complete(input: CompleteInput): Promise<CompleteResult> {
    const payload = await callProvider(config, "/chat/completions", {
      model: config.chatModel,
      messages: input.messages,
      max_tokens: input.maxTokens ?? 1024,
      temperature: input.temperature ?? 0.2,
    });

    const choices = isRecord(payload) && Array.isArray(payload.choices)
      ? payload.choices
      : null;
    const first = choices && choices.length > 0 ? choices[0] : null;
    const message = first && isRecord(first) && isRecord(first.message)
      ? first.message
      : null;

    if (!message || typeof message.content !== "string") {
      throw new AiProviderError("chat completion response was malformed");
    }

    const usage = isRecord(payload) && isRecord(payload.usage)
      ? payload.usage
      : null;
    const tokens = usage && typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : estimateTokens(message.content);

    return {
      text: message.content,
      tokens,
      model: config.chatModel,
      provider: "openai",
    };
  }

  return { name: "openai", embed, complete };
}

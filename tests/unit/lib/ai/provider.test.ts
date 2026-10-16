import type { AiConfig } from "@/lib/ai/config";
import {
  AiProviderError,
  assertEmbeddingShape,
  EMBED_BATCH_SIZE,
  getProvider,
} from "@/lib/ai/provider";
import { mockProvider } from "@/lib/ai/providers/mock";
import { createOpenAiProvider } from "@/lib/ai/providers/openai";
import { AI_EMBEDDING_DIMENSIONS } from "@/lib/ai/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "sk-test-key-do-not-leak";

function openAiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    setting: "openai",
    provider: "openai",
    apiKey: KEY,
    baseUrl: "https://api.openai.com/v1",
    embedModel: "text-embedding-3-small",
    chatModel: "gpt-4o-mini",
    maxIngestBytes: 20 * 1024 * 1024,
    ...overrides,
  };
}

function mockConfig(): AiConfig {
  return { ...openAiConfig({ setting: "auto", provider: "mock", apiKey: null }) };
}

function vector1536(fill = 0.1): number[] {
  return Array.from({ length: AI_EMBEDDING_DIMENSIONS }, () => fill);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getProvider", () => {
  it("returns the mock provider only for the mock configuration", () => {
    expect(getProvider(mockConfig())).toBe(mockProvider);
    expect(getProvider(openAiConfig()).name).toBe("openai");
    expect(getProvider(openAiConfig({ apiKey: null })).name).toBe("openai");
  });
});

describe("mock provider contract", () => {
  it("embeds to 1536-dimensional positive vectors, deterministically", async () => {
    const first = await mockProvider.embed(["torque notes"]);
    const second = await mockProvider.embed(["torque notes"]);
    expect(first.vectors[0]).toHaveLength(AI_EMBEDDING_DIMENSIONS);
    expect(second.vectors[0]).toEqual(first.vectors[0]);
    expect(first.vectors[0].every((value) => value > 0 && value <= 1)).toBe(true);
    expect(first.provider).toBe("mock");
    expect(first.model).toBe("mock-embedding-1536");
    expect(first.tokens).toBeGreaterThan(0);
  });

  it("gives different texts different vectors", async () => {
    const { vectors } = await mockProvider.embed(["alpha", "beta"]);
    expect(vectors[0]).not.toEqual(vectors[1]);
  });

  it("answers with the canned completion and labels itself mock", async () => {
    const result = await mockProvider.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.provider).toBe("mock");
    expect(result.text).toContain("Demo mode");
    expect(result.tokens).toBeGreaterThan(0);
  });
});

describe("assertEmbeddingShape", () => {
  it("accepts well-formed 1536-wide vectors", () => {
    expect(() => assertEmbeddingShape([vector1536(), vector1536(0.5)])).not.toThrow();
  });

  it("rejects wrong widths before anything reaches the database", () => {
    expect(() => assertEmbeddingShape([[0.1, 0.2]])).toThrow(AiProviderError);
    expect(() => assertEmbeddingShape([[]])).toThrow("embedding width mismatch");
  });

  it("rejects non-finite coordinates", () => {
    const broken = vector1536();
    broken[7] = Number.NaN;
    expect(() => assertEmbeddingShape([broken])).toThrow("non-finite");
  });
});

describe("openai provider — embed", () => {
  it("fails loudly without a key and never calls the network", async () => {
    const provider = createOpenAiProvider(openAiConfig({ apiKey: null }));
    await expect(provider.embed(["x"])).rejects.toThrow(AiProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the key only in the Authorization header", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: vector1536() }] })),
    );
    const provider = createOpenAiProvider(openAiConfig());
    await provider.embed(["one"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(init.body)).not.toContain(KEY);
  });

  it("throws AiProviderError for a non-2xx status and keeps the key out of the message", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    const provider = createOpenAiProvider(openAiConfig());
    const error = await provider.embed(["x"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain(KEY);
  });

  it("throws AiProviderError for an unreadable body", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
    const provider = createOpenAiProvider(openAiConfig());
    await expect(provider.embed(["x"])).rejects.toThrow("unreadable response");
  });

  it("throws AiProviderError for a malformed payload", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ nope: true })));
    const provider = createOpenAiProvider(openAiConfig());
    await expect(provider.embed(["x"])).rejects.toThrow("malformed");
  });

  it("throws when the response count does not match the batch", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: vector1536() }] })),
    );
    const provider = createOpenAiProvider(openAiConfig());
    await expect(provider.embed(["a", "b"])).rejects.toThrow("count mismatch");
  });

  it("validates width before returning (never a bad vector for the DB)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] })),
    );
    const provider = createOpenAiProvider(openAiConfig());
    await expect(provider.embed(["x"])).rejects.toThrow("embedding width mismatch");
  });

  it("reads prompt_tokens from usage when the provider reports it", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: vector1536() }],
          usage: { prompt_tokens: 42 },
        }),
      ),
    );
    const provider = createOpenAiProvider(openAiConfig());
    const result = await provider.embed(["x"]);
    expect(result.tokens).toBe(42);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("text-embedding-3-small");
  });

  it("splits large inputs into 64-text batches", async () => {
    const texts = Array.from({ length: EMBED_BATCH_SIZE + 1 }, (_, i) => `t${i}`);
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const input = (JSON.parse(String(init.body)) as { input: string[] }).input;
      return new Response(
        JSON.stringify({
          data: input.map((_, index) => ({ index, embedding: vector1536() })),
        }),
      );
    });
    const provider = createOpenAiProvider(openAiConfig());
    const result = await provider.embed(texts);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.vectors).toHaveLength(EMBED_BATCH_SIZE + 1);
  });

  it("returns an empty result for an empty batch without calling the provider", async () => {
    const provider = createOpenAiProvider(openAiConfig());
    const result = await provider.embed([]);
    expect(result).toEqual({
      vectors: [],
      tokens: 0,
      model: "text-embedding-3-small",
      provider: "openai",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("openai provider — complete", () => {
  it("parses a chat completion and its usage", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Angular momentum is conserved." } }],
          usage: { total_tokens: 17 },
        }),
      ),
    );
    const provider = createOpenAiProvider(openAiConfig());
    const result = await provider.complete({
      messages: [{ role: "user", content: "explain" }],
    });
    expect(result.text).toBe("Angular momentum is conserved.");
    expect(result.tokens).toBe(17);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("rejects a malformed completion payload", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [] })));
    const provider = createOpenAiProvider(openAiConfig());
    await expect(
      provider.complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("malformed");
  });

  it("surfaces transport failures as AiProviderError", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    const provider = createOpenAiProvider(openAiConfig());
    await expect(
      provider.complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(AiProviderError);
  });
});

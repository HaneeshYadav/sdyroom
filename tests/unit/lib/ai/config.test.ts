import {
  aiConfig,
  AI_DEMO_BANNER,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_CHAT_MODEL,
  DEFAULT_AI_EMBED_MODEL,
  DEFAULT_MAX_INGEST_BYTES,
  isAiDemoMode,
} from "@/lib/ai/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "../../helpers/log-capture";

const AI_KEYS = [
  "AI_PROVIDER",
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_EMBED_MODEL",
  "AI_CHAT_MODEL",
  "AI_MAX_INGEST_BYTES",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of AI_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of AI_KEYS) {
    const value = saved.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.restoreAllMocks();
});

describe("aiConfig — provider resolution", () => {
  it("runs the honest demo path with nothing configured", () => {
    const config = aiConfig();
    expect(config.setting).toBe("auto");
    expect(config.provider).toBe("mock");
    expect(config.apiKey).toBeNull();
    expect(isAiDemoMode()).toBe(true);
  });

  it("picks openai under auto as soon as a key is set", () => {
    process.env.AI_API_KEY = "sk-test-key";
    const config = aiConfig();
    expect(config.setting).toBe("auto");
    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBe("sk-test-key");
    expect(isAiDemoMode()).toBe(false);
  });

  it("honours AI_PROVIDER=openai even without a key (fails loudly at call time, never mock)", () => {
    process.env.AI_PROVIDER = "openai";
    const config = aiConfig();
    expect(config.setting).toBe("openai");
    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBeNull();
  });

  it("honours an explicit AI_PROVIDER=mock even when a key exists", () => {
    process.env.AI_PROVIDER = "mock";
    process.env.AI_API_KEY = "sk-test-key";
    const config = aiConfig();
    expect(config.setting).toBe("mock");
    expect(config.provider).toBe("mock");
    expect(isAiDemoMode()).toBe(true);
  });

  it("treats a typo'd provider as auto and warns without echoing the value", () => {
    const { lines, restore } = captureLogs();
    process.env.AI_PROVIDER = "opeenai";
    const config = aiConfig();
    expect(config.setting).toBe("auto");
    expect(config.provider).toBe("mock"); // no key → still honest
    const warns = lines.filter((line) => line.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].event).toBe(
      "[ai/config] unknown AI_PROVIDER — treating as auto",
    );
    expect(JSON.stringify(lines)).not.toContain("opeenai");
    restore();
  });

  it("trims the key so whitespace-only is treated as absent", () => {
    process.env.AI_API_KEY = "   ";
    expect(aiConfig().provider).toBe("mock");
    expect(aiConfig().apiKey).toBeNull();
  });
});

describe("aiConfig — models, base URL, size", () => {
  it("applies the published defaults", () => {
    const config = aiConfig();
    expect(config.baseUrl).toBe(DEFAULT_AI_BASE_URL);
    expect(config.embedModel).toBe(DEFAULT_AI_EMBED_MODEL);
    expect(config.chatModel).toBe(DEFAULT_AI_CHAT_MODEL);
    expect(config.maxIngestBytes).toBe(DEFAULT_MAX_INGEST_BYTES);
    expect(config.maxIngestBytes).toBe(20 * 1024 * 1024);
  });

  it("reads overrides and strips trailing slashes from the base URL", () => {
    process.env.AI_BASE_URL = "https://gateway.internal/v1///";
    process.env.AI_EMBED_MODEL = "text-embedding-3-large";
    process.env.AI_CHAT_MODEL = "gpt-4.1-mini";
    const config = aiConfig();
    expect(config.baseUrl).toBe("https://gateway.internal/v1");
    expect(config.embedModel).toBe("text-embedding-3-large");
    expect(config.chatModel).toBe("gpt-4.1-mini");
  });

  it("clamps the ingest ceiling to the upload ceiling and ignores junk", () => {
    process.env.AI_MAX_INGEST_BYTES = String(512 * 1024 * 1024);
    expect(aiConfig().maxIngestBytes).toBe(DEFAULT_MAX_INGEST_BYTES);

    process.env.AI_MAX_INGEST_BYTES = "not-a-number";
    expect(aiConfig().maxIngestBytes).toBe(DEFAULT_MAX_INGEST_BYTES);

    process.env.AI_MAX_INGEST_BYTES = "-5";
    expect(aiConfig().maxIngestBytes).toBe(DEFAULT_MAX_INGEST_BYTES);

    process.env.AI_MAX_INGEST_BYTES = String(1024 * 1024);
    expect(aiConfig().maxIngestBytes).toBe(1024 * 1024);
  });
});

describe("AI_DEMO_BANNER", () => {
  it("says demo mode and explains the canned-answer consequence", () => {
    expect(AI_DEMO_BANNER).toContain("demo mode");
    expect(AI_DEMO_BANNER).toContain("no provider key");
  });
});

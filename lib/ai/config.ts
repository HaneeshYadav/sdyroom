/**
 * Server-side AI configuration — the single place `AI_*` environment variables
 * are read and interpreted.
 *
 * Rules (published in README and docs/SECURITY.md, asserted by unit tests):
 *
 *   * never `NEXT_PUBLIC_*` — the key must not reach the client bundle;
 *   * `AI_PROVIDER=auto` (the default) picks `openai` when `AI_API_KEY` is
 *     set and `mock` when it is not: no key means honest demo mode;
 *   * a *configured* provider that fails does NOT fall back to mock — a
 *     broken production key must surface as `502 ai_provider_failed`;
 *   * `AI_PROVIDER=mock` is an explicit, deliberate choice (tests, demos).
 *
 * Reading the environment on every call (no module-level memo) keeps unit
 * tests free to vary `process.env` between cases; the cost is a handful of
 * property reads per request.
 */
import { logWarn } from "@/lib/server/log";

export type ProviderSetting = "auto" | "openai" | "mock";
export type ResolvedProviderName = "openai" | "mock";

export type AiConfig = {
  /** What `AI_PROVIDER` asked for, after normalisation. */
  setting: ProviderSetting;
  /** What will actually run, after the key-presence rule. */
  provider: ResolvedProviderName;
  /** Present only when set; never logged, never serialised. */
  apiKey: string | null;
  baseUrl: string;
  embedModel: string;
  chatModel: string;
  /** Ingest size ceiling; clamped to the upload ceiling (20 MiB). */
  maxIngestBytes: number;
};

export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_AI_EMBED_MODEL = "text-embedding-3-small";
export const DEFAULT_AI_CHAT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_INGEST_BYTES = 20 * 1024 * 1024;

/** The banner copy shown wherever `provider === "mock"`. */
export const AI_DEMO_BANNER =
  "AI is running in demo mode — no provider key is configured, so answers are canned and indexing uses local test vectors.";

function readProviderSetting(): ProviderSetting {
  const raw = (process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "openai" || raw === "mock") {
    return raw;
  }
  if (raw !== "" && raw !== "auto") {
    // A typo must not silently become demo mode: it is logged (no value
    // echoed beyond the variable name) and treated as `auto`, where the
    // key-presence rule still decides honestly.
    logWarn("[ai/config] unknown AI_PROVIDER — treating as auto");
  }
  return "auto";
}

function readBaseUrl(): string {
  const raw = (process.env.AI_BASE_URL ?? "").trim();
  if (raw === "") {
    return DEFAULT_AI_BASE_URL;
  }
  return raw.replace(/\/+$/, "");
}

function readModel(name: string, fallback: string): string {
  const raw = (process.env[name] ?? "").trim();
  return raw === "" ? fallback : raw;
}

function readMaxIngestBytes(): number {
  const raw = Number(process.env.AI_MAX_INGEST_BYTES);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_MAX_INGEST_BYTES;
  }
  // Clamped: ingestion can never exceed the upload ceiling enforced by PR 10.
  return Math.min(Math.floor(raw), DEFAULT_MAX_INGEST_BYTES);
}

export function aiConfig(): AiConfig {
  const setting = readProviderSetting();
  const apiKey = (process.env.AI_API_KEY ?? "").trim() || null;

  let provider: ResolvedProviderName;
  if (setting === "mock") {
    provider = "mock";
  } else if (setting === "openai") {
    provider = "openai";
  } else {
    provider = apiKey !== null ? "openai" : "mock";
  }

  return {
    setting,
    provider,
    apiKey,
    baseUrl: readBaseUrl(),
    embedModel: readModel("AI_EMBED_MODEL", DEFAULT_AI_EMBED_MODEL),
    chatModel: readModel("AI_CHAT_MODEL", DEFAULT_AI_CHAT_MODEL),
    maxIngestBytes: readMaxIngestBytes(),
  };
}

/** True when the whole app runs on the mock provider — drives the banner. */
export function isAiDemoMode(): boolean {
  return aiConfig().provider === "mock";
}

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
import { addDaysIso } from "@/lib/planner/dates";

export const MOCK_EMBED_MODEL = "mock-embedding-1536";
export const MOCK_CHAT_MODEL = "mock-chat-1";

export const MOCK_COMPLETION =
  "Demo mode: no AI provider is configured, so this is a canned response.";

/**
 * Generation requests carry a `<generation mode="…" count="…">` marker in
 * the user message (see `lib/ai/prompts/generate.ts`). The mock answers
 * those with strict, schema-valid JSON — deterministic and shaped to pass
 * the parse-validate gate — so quizzes and decks can be built, taken and
 * graded in demo mode and CI without a provider key. Ask flows keep the
 * canned prose answer above.
 */
const GENERATION_MARKER = /<generation mode="(quiz|deck)" count="(\d+)"/;

function mockQuizJson(count: number): string {
  const questions = Array.from({ length: count }, (_, index) => {
    if (index % 5 === 0) {
      return {
        type: "tf",
        prompt: `Demo mode: statement ${index + 1} is true.`,
        options: ["True", "False"],
        correct_index: 0,
        explanation: `Demo mode: canned true/false item ${index + 1}, grounded in the retrieved sources.`,
        citations: [{ n: 1 }],
      };
    }
    return {
      type: "mcq",
      prompt: `Demo mode: which option answers question ${index + 1}?`,
      options: ["Option A", "Option B", "Option C", "Option D"],
      correct_index: index % 4,
      explanation: `Demo mode: canned explanation for question ${index + 1}, grounded in the retrieved sources.`,
      citations: [{ n: 1 }],
    };
  });
  return JSON.stringify({ questions });
}

function mockDeckJson(count: number): string {
  const cards = Array.from({ length: count }, (_, index) => ({
    front: `Demo mode: front of card ${index + 1}`,
    back: `Demo mode: back of card ${index + 1}, grounded in the retrieved sources.`,
    citations: [{ n: 1 }],
  }));
  return JSON.stringify({ cards });
}

export function mockGenerationCompletion(userMessage: string): string | null {
  const match = userMessage.match(GENERATION_MARKER);
  if (!match) {
    return null;
  }
  const mode = match[1];
  const count = Number.parseInt(match[2], 10);
  if (!Number.isInteger(count) || count < 1 || count > 40) {
    return null;
  }
  return mode === "quiz" ? mockQuizJson(count) : mockDeckJson(count);
}

/**
 * Study-plan requests carry the `<plan …>` marker plus `<doc id … />` rows
 * (see `lib/ai/prompts/plan.ts`). The mock answers with a strict,
 * schema-valid plan — deterministic and shaped to clear both the TS gate
 * (`lib/planner/validate.ts`) and `generate_plan`'s SQL checks: dates stay
 * inside the window, at most 90 distinct days / 180 items, and no day
 * exceeds the marker's `budget_minutes` (even a 1-hour plan's 75-minute
 * budget is honoured: the heaviest day is 70).
 */
const PLAN_MARKER =
  /<plan today="(\d{4}-\d{2}-\d{2})" exam_date="(\d{4}-\d{2}-\d{2})" hours_per_day="([\d.]+)" budget_minutes="(\d+)" days="(\d+)"/;
const DOC_ROW = /<doc id="([0-9a-fA-F-]{36})" title="([^"]*)"/g;

type MockPlanDayItem = {
  date: string;
  subject: string | null;
  task: string;
  estimated_minutes: number;
  kind: "read" | "practice" | "review" | "mock" | "rest";
  resource_id: string | null;
  citation: { title: string; href: string } | null;
};

export function mockPlanCompletion(userMessage: string): string | null {
  const match = userMessage.match(PLAN_MARKER);
  if (!match) {
    return null;
  }
  const today = match[1];
  const examDate = match[2];
  const budgetMinutes = Number.parseInt(match[4], 10);
  const windowDays = Number.parseInt(match[5], 10);
  if (!Number.isInteger(budgetMinutes) || budgetMinutes < 1) {
    return null;
  }
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    return null;
  }

  const docs: { id: string; title: string }[] = [];
  for (const row of userMessage.matchAll(DOC_ROW)) {
    docs.push({ id: row[1], title: row[2] || "Untitled document" });
  }

  const topicsLine = userMessage.match(/^Topics: (.+)$/m);
  const topics = topicsLine
    ? topicsLine[1].split(";").map((topic) => topic.trim()).filter((topic) => topic.length > 0)
    : [];

  const dayCount = Math.min(windowDays, 90);
  const items: MockPlanDayItem[] = [];
  const subjectFor = (index: number): string | null =>
    topics.length > 0 ? topics[index % topics.length] : null;

  for (let day = 0; day < dayCount; day += 1) {
    const date = addDaysIso(today, day);
    const lastDay = day === dayCount - 1;

    if (lastDay) {
      items.push({
        date,
        subject: subjectFor(day),
        task: "Demo mode: full-length mock exam under test conditions.",
        estimated_minutes: Math.min(60, budgetMinutes),
        kind: "mock",
        resource_id: null,
        citation: null,
      });
      continue;
    }
    if ((day + 1) % 7 === 0) {
      items.push({
        date,
        subject: null,
        task: "Demo mode: rest day — light recap only, protect the streak.",
        estimated_minutes: Math.min(15, budgetMinutes),
        kind: "rest",
        resource_id: null,
        citation: null,
      });
      continue;
    }
    if (day % 2 === 0 && docs.length > 0) {
      const doc = docs[day % docs.length];
      items.push({
        date,
        subject: subjectFor(day),
        task: "Demo mode: read the assigned document section and take notes.",
        estimated_minutes: Math.min(25, budgetMinutes),
        kind: "read",
        resource_id: doc.id,
        citation: { title: doc.title, href: "/resources" },
      });
      const remaining = budgetMinutes - Math.min(25, budgetMinutes);
      if (remaining >= 45) {
        items.push({
          date,
          subject: subjectFor(day),
          task: "Demo mode: worked practice problems on today's topic.",
          estimated_minutes: 45,
          kind: "practice",
          resource_id: null,
          citation: null,
        });
      }
      continue;
    }
    items.push({
      date,
      subject: subjectFor(day),
      task: "Demo mode: worked practice problems on today's topic.",
      estimated_minutes: Math.min(45, budgetMinutes),
      kind: "practice",
      resource_id: null,
      citation: null,
    });
    if (budgetMinutes - Math.min(45, budgetMinutes) >= 20) {
      items.push({
        date,
        subject: subjectFor(day),
        task: "Demo mode: spaced review of earlier notes and missed items.",
        estimated_minutes: 20,
        kind: "review",
        resource_id: null,
        citation: null,
      });
    }
  }

  if (items.length === 0) {
    return null;
  }

  const summary = topics.length > 0
    ? `Demo mode: ${dayCount}-day plan covering ${topics.slice(0, 5).join(", ")} before the ${examDate} exam.`
    : `Demo mode: ${dayCount}-day plan leading up to the ${examDate} exam.`;

  return JSON.stringify({ summary: summary.slice(0, 300), items });
}

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
    const userMessage = [...input.messages]
      .reverse()
      .find((message) => message.role === "user")
      ?.content
      ?? "";
    const plan = mockPlanCompletion(userMessage);
    const generation = plan ?? mockGenerationCompletion(userMessage);
    const text = plan ?? generation ?? MOCK_COMPLETION;

    // Estimated usage mirrors a real call (prompt + completion) so later
    // consumers of `tokens` see realistic numbers even in demo mode.
    const promptTokens = input.messages.reduce(
      (total, message) => total + estimateTokens(message.content),
      0,
    );
    const completionTokens = estimateTokens(text);
    return {
      text,
      tokens: promptTokens + completionTokens,
      model: MOCK_CHAT_MODEL,
      provider: "mock",
    };
  },
};

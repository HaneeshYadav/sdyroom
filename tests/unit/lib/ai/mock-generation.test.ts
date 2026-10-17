import {
  mockGenerationCompletion,
  mockProvider,
  MOCK_COMPLETION,
} from "@/lib/ai/providers/mock";
import { parseDeckPayload, parseQuizPayload } from "@/lib/ai/quiz/validate";
import { buildGenerationMessages } from "@/lib/ai/prompts/generate";
import { describe, expect, it } from "vitest";

const quizRequest = {
  mode: "quiz" as const,
  count: 5,
  difficulty: "medium" as const,
  titles: ["Notes"],
};

const deckRequest = {
  mode: "deck" as const,
  count: 10,
  difficulty: "easy" as const,
  titles: ["Notes"],
};

describe("mock generation output", () => {
  it("returns null for non-generation prompts (ask keeps the prose answer)", () => {
    expect(
      mockGenerationCompletion("What is the powerhouse of the cell?"),
    ).toBeNull();
  });

  it("emits quiz JSON that passes the real parse-validate gate", () => {
    const messages = buildGenerationMessages(quizRequest, [
      {
        text: "Mitochondria produce ATP.",
        citation: {
          n: 1,
          resourceId: "r-1",
          title: "Notes",
          href: "/rooms/room-1",
        },
      },
    ]);
    const userMessage = messages[1].content;
    const raw = mockGenerationCompletion(userMessage);
    expect(raw).not.toBeNull();
    const payload = parseQuizPayload(raw as string, {
      expectedCount: 5,
      sourceCount: 1,
    });
    expect(payload.questions).toHaveLength(5);
    expect(payload.questions[0].type).toBe("tf");
    expect(payload.questions[1].type).toBe("mcq");
  });

  it("emits deck JSON that passes the real parse-validate gate", () => {
    const messages = buildGenerationMessages(deckRequest, [
      {
        text: "ATP = energy currency.",
        citation: {
          n: 1,
          resourceId: "r-1",
          title: "Notes",
          href: "/rooms/room-1",
        },
      },
    ]);
    const raw = mockGenerationCompletion(messages[1].content);
    const payload = parseDeckPayload(raw as string, {
      expectedCount: 10,
      sourceCount: 1,
    });
    expect(payload.cards).toHaveLength(10);
  });

  it("is deterministic for the same request", () => {
    const messages = buildGenerationMessages(quizRequest, []);
    const first = mockGenerationCompletion(messages[1].content);
    const second = mockGenerationCompletion(messages[1].content);
    expect(first).toBe(second);
  });

  it("falls back to the canned prose when complete() sees an ask prompt", async () => {
    const result = await mockProvider.complete({
      messages: [
        { role: "system", content: "You are SdyRoom's study assistant." },
        { role: "user", content: "Question: what is DNA?" },
      ],
    });
    expect(result.text).toBe(MOCK_COMPLETION);
    expect(result.provider).toBe("mock");
  });

  it("returns generation JSON from complete() when the marker is present", async () => {
    const messages = buildGenerationMessages(quizRequest, []);
    const result = await mockProvider.complete({ messages });
    expect(result.text).toContain('"questions"');
    expect(result.provider).toBe("mock");
    expect(result.tokens).toBeGreaterThan(0);
  });
});

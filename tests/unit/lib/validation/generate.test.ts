import {
  artifactKindFor,
  attemptBodySchema,
  generateBodySchema,
  reviewBodySchema,
  artifactsQuerySchema,
  QUIZ_COUNTS,
  DECK_COUNTS,
} from "@/lib/validation/generate";
import { describe, expect, it } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";

describe("generateBodySchema", () => {
  it("accepts a valid quiz request", () => {
    const parsed = generateBodySchema.safeParse({
      mode: "quiz",
      count: 5,
      difficulty: "medium",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the flashcards alias and maps it to the deck kind", () => {
    const parsed = generateBodySchema.safeParse({
      mode: "flashcards",
      count: 10,
      difficulty: "easy",
      resource_ids: [ROOM],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(artifactKindFor(parsed.data.mode)).toBe("deck");
    }
  });

  it("maps quiz mode to the quiz kind", () => {
    expect(artifactKindFor("quiz")).toBe("quiz");
    expect(artifactKindFor("deck")).toBe("deck");
  });

  it("rejects unknown fields", () => {
    const parsed = generateBodySchema.safeParse({
      mode: "quiz",
      count: 5,
      difficulty: "medium",
      score: 100,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects counts outside the per-mode sets", () => {
    for (const count of [1, 3, 7, 25, 0, -5]) {
      const parsed = generateBodySchema.safeParse({
        mode: "quiz",
        count,
        difficulty: "medium",
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("accepts every declared quiz and deck count", () => {
    for (const count of QUIZ_COUNTS) {
      expect(
        generateBodySchema.safeParse({ mode: "quiz", count, difficulty: "hard" })
          .success,
      ).toBe(true);
    }
    for (const count of DECK_COUNTS) {
      expect(
        generateBodySchema.safeParse({ mode: "deck", count, difficulty: "hard" })
          .success,
      ).toBe(true);
    }
  });

  it("rejects invalid resource ids and empty selections", () => {
    expect(
      generateBodySchema.safeParse({
        mode: "quiz",
        count: 5,
        difficulty: "medium",
        resource_ids: ["not-a-uuid"],
      }).success,
    ).toBe(false);
    expect(
      generateBodySchema.safeParse({
        mode: "quiz",
        count: 5,
        difficulty: "medium",
        resource_ids: [],
      }).success,
    ).toBe(false);
  });

  it("rejects a bad difficulty and a bad mode", () => {
    expect(
      generateBodySchema.safeParse({ mode: "quiz", count: 5, difficulty: "insane" })
        .success,
    ).toBe(false);
    expect(
      generateBodySchema.safeParse({ mode: "essay", count: 5, difficulty: "easy" })
        .success,
    ).toBe(false);
  });

  it("accepts the optional question_types subset", () => {
    expect(
      generateBodySchema.safeParse({
        mode: "quiz",
        count: 5,
        difficulty: "medium",
        question_types: ["tf"],
      }).success,
    ).toBe(true);
    expect(
      generateBodySchema.safeParse({
        mode: "quiz",
        count: 5,
        difficulty: "medium",
        question_types: ["essay"],
      }).success,
    ).toBe(false);
  });
});

describe("attemptBodySchema", () => {
  it("accepts an answer array with optional duration", () => {
    expect(
      attemptBodySchema.safeParse({ answers: [0, 1, -1, 3, 2], duration_ms: 12_000 })
        .success,
    ).toBe(true);
    expect(attemptBodySchema.safeParse({ answers: [] }).success).toBe(true);
  });

  it("rejects non-integer and out-of-range indices", () => {
    expect(attemptBodySchema.safeParse({ answers: [0.5] }).success).toBe(false);
    expect(attemptBodySchema.safeParse({ answers: [4] }).success).toBe(false);
    expect(attemptBodySchema.safeParse({ answers: [-2] }).success).toBe(false);
    expect(attemptBodySchema.safeParse({ answers: ["0"] }).success).toBe(false);
  });

  it("rejects oversized durations and unknown fields", () => {
    expect(
      attemptBodySchema.safeParse({ answers: [0], duration_ms: 86_400_001 })
        .success,
    ).toBe(false);
    expect(
      attemptBodySchema.safeParse({ answers: [0], score: 10 }).success,
    ).toBe(false);
  });
});

describe("reviewBodySchema", () => {
  it("accepts valid grades", () => {
    expect(
      reviewBodySchema.safeParse({ card_ordinal: 0, grade: "again" }).success,
    ).toBe(true);
    expect(
      reviewBodySchema.safeParse({ card_ordinal: 3, grade: "got_it" }).success,
    ).toBe(true);
  });

  it("rejects bad grades and negative ordinals", () => {
    expect(
      reviewBodySchema.safeParse({ card_ordinal: 0, grade: "easy" }).success,
    ).toBe(false);
    expect(
      reviewBodySchema.safeParse({ card_ordinal: -1, grade: "again" }).success,
    ).toBe(false);
  });
});

describe("artifactsQuerySchema", () => {
  it("accepts an optional kind filter and rejects others", () => {
    expect(artifactsQuerySchema.safeParse({}).success).toBe(true);
    expect(artifactsQuerySchema.safeParse({ kind: "quiz" }).success).toBe(true);
    expect(artifactsQuerySchema.safeParse({ kind: "deck" }).success).toBe(true);
    expect(artifactsQuerySchema.safeParse({ kind: "essay" }).success).toBe(false);
  });
});

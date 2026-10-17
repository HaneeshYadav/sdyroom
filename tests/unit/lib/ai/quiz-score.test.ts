import { scoreQuiz } from "@/lib/ai/quiz/score";
import type { QuizPayload } from "@/lib/ai/quiz/validate";
import { describe, expect, it } from "vitest";

const payload: QuizPayload = {
  questions: [
    {
      type: "mcq",
      prompt: "Q1",
      options: ["A", "B", "C", "D"],
      correct_index: 0,
      explanation: "Because A.",
      citations: [{ n: 1 }],
    },
    {
      type: "tf",
      prompt: "Q2",
      options: ["True", "False"],
      correct_index: 1,
      explanation: "Because false.",
      citations: [],
    },
    {
      type: "mcq",
      prompt: "Q3",
      options: ["A", "B", "C", "D"],
      correct_index: 2,
      explanation: "Because C.",
      citations: [{ n: 2, page: 3 }],
    },
  ],
};

describe("scoreQuiz", () => {
  it("scores a perfect attempt", () => {
    const result = scoreQuiz(payload, [0, 1, 2]);
    expect(result.score).toBe(3);
    expect(result.total).toBe(3);
    expect(result.correct).toEqual([true, true, true]);
  });

  it("scores a partial attempt with per-question results", () => {
    const result = scoreQuiz(payload, [1, 1, 0]);
    expect(result.score).toBe(1);
    expect(result.correct).toEqual([false, true, false]);
    expect(result.results[0]).toEqual({
      ordinal: 0,
      chosen: 1,
      correct_index: 0,
      explanation: "Because A.",
      citations: [{ n: 1 }],
    });
    expect(result.results[2].citations).toEqual([{ n: 2, page: 3 }]);
  });

  it("treats missing, negative and out-of-range answers as wrong", () => {
    expect(scoreQuiz(payload, [-1, 2, 99]).score).toBe(0);
    expect(scoreQuiz(payload, [null as never, undefined as never, "0" as never]).score).toBe(0);
    expect(scoreQuiz(payload, []).score).toBe(0);
    expect(scoreQuiz(payload, []).correct).toEqual([false, false, false]);
  });

  it("is deterministic — same input, same output", () => {
    const first = scoreQuiz(payload, [0, 0, 0]);
    const second = scoreQuiz(payload, [0, 0, 0]);
    expect(first).toEqual(second);
  });
});

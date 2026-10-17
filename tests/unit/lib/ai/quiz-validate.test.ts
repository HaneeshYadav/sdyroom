import {
  GenerationValidationError,
  parseDeckPayload,
  parseJsonObject,
  parseQuizPayload,
  stripInvalidCitations,
} from "@/lib/ai/quiz/validate";
import { describe, expect, it } from "vitest";

function quizJson(questions: unknown[], override?: Record<string, unknown>): string {
  return JSON.stringify({ questions, ...override });
}

function mcq(index: number, correct = index % 4) {
  return {
    type: "mcq",
    prompt: `Question ${index}`,
    options: ["A", "B", "C", "D"].map((option, i) => `${option} ${index}.${i}`),
    correct_index: correct,
    explanation: `Explanation ${index}`,
    citations: [{ n: 1 }],
  };
}

function tf(index: number, correct = 0) {
  return {
    type: "tf",
    prompt: `True/false ${index}`,
    options: ["True", "False"],
    correct_index: correct,
    explanation: `TF explanation ${index}`,
    citations: [],
  };
}

describe("parseJsonObject", () => {
  it("parses plain JSON and one fenced block", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("rejects prose around the object", () => {
    expect(() => parseJsonObject('Sure! Here it is: {"a":1}')).toThrow(
      GenerationValidationError,
    );
    expect(() => parseJsonObject("not json at all")).toThrow(
      GenerationValidationError,
    );
  });
});

describe("parseQuizPayload", () => {
  it("accepts a well-formed payload and keeps valid citations", () => {
    const payload = parseQuizPayload(quizJson([mcq(0), tf(1)]), {
      expectedCount: 2,
      sourceCount: 3,
    });
    expect(payload.questions).toHaveLength(2);
    expect(payload.questions[0].citations).toEqual([{ n: 1 }]);
  });

  it("rejects the wrong question count", () => {
    expect(() =>
      parseQuizPayload(quizJson([mcq(0)]), { expectedCount: 5, sourceCount: 1 }),
    ).toThrow(GenerationValidationError);
  });

  it("rejects duplicate prompts", () => {
    const duplicate = { ...mcq(0), prompt: "Same prompt" };
    const other = { ...mcq(1), prompt: "Same prompt" };
    expect(() =>
      parseQuizPayload(quizJson([duplicate, other]), {
        expectedCount: 2,
        sourceCount: 1,
      }),
    ).toThrow(/Duplicate question/);
  });

  it("rejects an out-of-range correct_index", () => {
    expect(() =>
      parseQuizPayload(quizJson([mcq(0, 4)]), { expectedCount: 1, sourceCount: 1 }),
    ).toThrow(GenerationValidationError);
  });

  it("rejects mcq with duplicate or wrong-count options", () => {
    const dupOptions = {
      ...mcq(0),
      options: ["Same", "Same", "C", "D"],
    };
    expect(() =>
      parseQuizPayload(quizJson([dupOptions]), { expectedCount: 1, sourceCount: 1 }),
    ).toThrow(/unique/);

    const threeOptions = { ...mcq(0), options: ["A", "B", "C"] };
    expect(() =>
      parseQuizPayload(quizJson([threeOptions]), { expectedCount: 1, sourceCount: 1 }),
    ).toThrow(/exactly 4/);
  });

  it("rejects tf without exactly True and False", () => {
    const badTf = { ...tf(0), options: ["Yes", "No"] };
    expect(() =>
      parseQuizPayload(quizJson([badTf]), { expectedCount: 1, sourceCount: 1 }),
    ).toThrow(/True/);
  });

  it("strips citations that do not point at a retrieved source", () => {
    const withBadCitation = {
      ...mcq(0),
      citations: [{ n: 1 }, { n: 99 }, { n: 0 }],
    };
    const payload = parseQuizPayload(quizJson([withBadCitation]), {
      expectedCount: 1,
      sourceCount: 1,
    });
    expect(payload.questions[0].citations).toEqual([{ n: 1 }]);
  });

  it("rejects malformed JSON outright", () => {
    expect(() =>
      parseQuizPayload("{nope", { expectedCount: 1, sourceCount: 1 }),
    ).toThrow(GenerationValidationError);
  });

  it("rejects empty prompts and missing options", () => {
    const emptyPrompt = { ...mcq(0), prompt: "   " };
    expect(() =>
      parseQuizPayload(quizJson([emptyPrompt]), { expectedCount: 1, sourceCount: 1 }),
    ).toThrow(GenerationValidationError);
  });
});

describe("parseDeckPayload", () => {
  const card = (index: number) => ({
    front: `Front ${index}`,
    back: `Back ${index}`,
    citations: [{ n: 1 }],
  });

  it("accepts a well-formed deck", () => {
    const payload = parseDeckPayload(
      JSON.stringify({ cards: [card(0), card(1)] }),
      { expectedCount: 2, sourceCount: 2 },
    );
    expect(payload.cards).toHaveLength(2);
  });

  it("rejects the wrong card count and duplicate fronts", () => {
    expect(() =>
      parseDeckPayload(JSON.stringify({ cards: [card(0)] }), {
        expectedCount: 10,
        sourceCount: 1,
      }),
    ).toThrow(GenerationValidationError);

    const duplicates = JSON.stringify({
      cards: [{ ...card(0), front: "Same" }, { ...card(1), front: "Same" }],
    });
    expect(() =>
      parseDeckPayload(duplicates, { expectedCount: 2, sourceCount: 1 }),
    ).toThrow(/Duplicate card/);
  });

  it("strips out-of-range citations", () => {
    const payload = parseDeckPayload(
      JSON.stringify({ cards: [{ ...card(0), citations: [{ n: 5 }] }] }),
      { expectedCount: 1, sourceCount: 1 },
    );
    expect(payload.cards[0].citations).toEqual([]);
  });
});

describe("stripInvalidCitations", () => {
  it("filters to the in-range set and preserves other fields", () => {
    const [item] = stripInvalidCitations(
      [{ front: "a", citations: [{ n: 1 }, { n: 2 }] }],
      1,
    );
    expect(item.front).toBe("a");
    expect(item.citations).toEqual([{ n: 1 }]);
  });
});

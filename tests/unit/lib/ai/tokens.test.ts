import { CHARS_PER_TOKEN, estimateTokens } from "@/lib/ai/tokens";
import { describe, expect, it } from "vitest";

describe("estimateTokens", () => {
  it("returns 0 for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("counts at least one token for any non-empty text", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("hi")).toBe(1);
  });

  it("uses the published ~4 characters per token ratio", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });

  it("is deterministic", () => {
    const text = "Rotational dynamics lecture notes";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });
});

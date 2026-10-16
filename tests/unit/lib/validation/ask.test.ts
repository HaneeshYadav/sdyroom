import {
  askBodySchema,
  askHistoryQuerySchema,
  ASK_MAX_RESOURCE_IDS,
} from "@/lib/validation/ask";
import { describe, expect, it } from "vitest";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("askBodySchema", () => {
  it("accepts a plain question and trims it", () => {
    const parsed = askBodySchema.parse({ question: "  What is torque?  " });
    expect(parsed).toEqual({ question: "What is torque?" });
  });

  it("accepts optional resource ids and a conversation id", () => {
    const parsed = askBodySchema.parse({
      question: "q",
      resource_ids: [UUID],
      conversation_id: UUID,
    });
    expect(parsed.resource_ids).toEqual([UUID]);
    expect(parsed.conversation_id).toBe(UUID);
  });

  it("rejects an empty or whitespace-only question", () => {
    expect(askBodySchema.safeParse({ question: "   " }).success).toBe(false);
    expect(askBodySchema.safeParse({}).success).toBe(false);
  });

  it("rejects a question over 2000 characters", () => {
    const result = askBodySchema.safeParse({ question: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid resource ids and more than the cap", () => {
    expect(
      askBodySchema.safeParse({ question: "q", resource_ids: ["nope"] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: ASK_MAX_RESOURCE_IDS + 1 }, () => UUID);
    expect(askBodySchema.safeParse({ question: "q", resource_ids: many }).success).toBe(
      false,
    );
  });

  it("rejects unknown fields rather than ignoring them", () => {
    expect(askBodySchema.safeParse({ question: "q", user_id: UUID }).success).toBe(
      false,
    );
    expect(
      askBodySchema.safeParse({ question: "q", conversation_id: "not-a-uuid" })
        .success,
    ).toBe(false);
  });
});

describe("askHistoryQuerySchema", () => {
  it("defaults the limit and allows an optional cursor", () => {
    expect(askHistoryQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(askHistoryQuerySchema.parse({ cursor: "abc" })).toEqual({
      limit: 20,
      cursor: "abc",
    });
  });

  it("coerces and bounds the limit", () => {
    expect(askHistoryQuerySchema.parse({ limit: "5" }).limit).toBe(5);
    expect(askHistoryQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(askHistoryQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(askHistoryQuerySchema.safeParse({ room_id: UUID }).success).toBe(
      false,
    );
  });
});

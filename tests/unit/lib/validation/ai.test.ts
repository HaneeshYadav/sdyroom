import {
  aiUsageQuerySchema,
  ingestStepSchema,
  ingestSweepSchema,
  SWEEP_LIMIT_DEFAULT,
  SWEEP_LIMIT_MAX,
} from "@/lib/validation/ai";
import { describe, expect, it } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";

describe("ingestStepSchema", () => {
  it("defaults an empty body to the resumable auto step", () => {
    expect(ingestStepSchema.parse({})).toEqual({ step: "auto" });
  });

  it("accepts every published step", () => {
    for (const step of ["extract", "chunk", "embed", "auto"] as const) {
      expect(ingestStepSchema.parse({ step })).toEqual({ step });
    }
  });

  it("rejects an unknown step", () => {
    expect(ingestStepSchema.safeParse({ step: "reindex" }).success).toBe(false);
  });

  it("refuses unknown fields instead of half-honouring them", () => {
    const parsed = ingestStepSchema.safeParse({ step: "auto", force: true });
    expect(parsed.success).toBe(false);
    expect(ingestStepSchema.safeParse({ force: true }).success).toBe(false);
  });
});

describe("ingestSweepSchema", () => {
  it("defaults to the published limit with no room narrowing", () => {
    expect(ingestSweepSchema.parse({})).toEqual({ limit: SWEEP_LIMIT_DEFAULT });
    expect(SWEEP_LIMIT_DEFAULT).toBe(10);
  });

  it("accepts a room scope and an explicit limit", () => {
    expect(ingestSweepSchema.parse({ room_id: ROOM, limit: 25 })).toEqual({
      room_id: ROOM,
      limit: 25,
    });
  });

  it("coerces a numeric string limit (form/query inputs)", () => {
    expect(ingestSweepSchema.parse({ limit: "5" })).toEqual({ limit: 5 });
  });

  it("bounds the limit to 1..50", () => {
    expect(ingestSweepSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ingestSweepSchema.safeParse({ limit: SWEEP_LIMIT_MAX }).success).toBe(true);
    expect(ingestSweepSchema.safeParse({ limit: SWEEP_LIMIT_MAX + 1 }).success).toBe(false);
    expect(ingestSweepSchema.safeParse({ limit: 2.5 }).success).toBe(false);
  });

  it("rejects a room id that is not a uuid", () => {
    expect(ingestSweepSchema.safeParse({ room_id: "nope" }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(ingestSweepSchema.safeParse({ user_id: "someone-else" }).success).toBe(false);
  });
});

describe("aiUsageQuerySchema", () => {
  it("accepts an empty query and a uuid room scope", () => {
    expect(aiUsageQuerySchema.parse({})).toEqual({});
    expect(aiUsageQuerySchema.parse({ room_id: ROOM })).toEqual({ room_id: ROOM });
  });

  it("rejects a malformed room id or an unexpected parameter", () => {
    expect(aiUsageQuerySchema.safeParse({ room_id: "nope" }).success).toBe(false);
    expect(aiUsageQuerySchema.safeParse({ scope: "room" }).success).toBe(false);
  });
});

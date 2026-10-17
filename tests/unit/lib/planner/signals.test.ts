import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  assembleSignals,
  EMPTY_SIGNALS,
} from "@/lib/planner/signals";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type QueryResult = { data: unknown; error: null | { message: string } };

/** Minimal chainable stub for `client.from(...).select(...).eq(...)`. */
function fakeClient(goals: QueryResult, attempts: QueryResult): SupabaseClient {
  const from = (table: string) => ({
    select: () => ({
      eq: async () => (table === "study_goals" ? goals : attempts),
    }),
  });
  return { from } as unknown as SupabaseClient;
}

describe("assembleSignals", () => {
  it("aggregates goals: completion rate rounded to two decimals", async () => {
    const client = fakeClient(
      {
        data: [
          { status: "completed" },
          { status: "completed" },
          { status: "completed" },
          { status: "active" },
        ],
        error: null,
      },
      { data: [], error: null },
    );
    const signals = await assembleSignals(client, USER);
    expect(signals.goals_completed).toBe(3);
    expect(signals.goals_active).toBe(1);
    expect(signals.goal_completion_rate).toBe(0.75);
  });

  it("leaves a rate null when there is nothing to divide", async () => {
    const client = fakeClient({ data: [], error: null }, { data: [], error: null });
    const signals = await assembleSignals(client, USER);
    expect(signals.goal_completion_rate).toBeNull();
    expect(signals.goals_completed).toBe(0);
    expect(signals.goals_active).toBe(0);
    expect(signals.quiz_accuracy).toBeNull();
    expect(signals.quiz_attempts).toBe(0);
    expect(signals.weak_difficulty).toBeNull();
    expect(signals.focus_minutes).toBeNull();
  });

  it("computes quiz accuracy across attempts and the weakest difficulty", async () => {
    const client = fakeClient(
      { data: [], error: null },
      {
        data: [
          { score: 3, total: 10, study_artifacts: { difficulty: "hard" } },
          { score: 9, total: 10, study_artifacts: { difficulty: "easy" } },
          { score: 1, total: 10, study_artifacts: { difficulty: "hard" } },
          // embed as one-element array — PostgREST's alternate shape
          { score: 8, total: 10, study_artifacts: [{ difficulty: "easy" }] },
        ],
        error: null,
      },
    );
    const signals = await assembleSignals(client, USER);
    expect(signals.quiz_attempts).toBe(4);
    expect(signals.quiz_accuracy).toBe(0.53); // 21/40 rounds half-up
    expect(signals.weak_difficulty).toBe("hard"); // 0.2 vs 0.85
  });

  it("falls back to EMPTY_SIGNALS when a query fails — never fails the plan", async () => {
    const client = fakeClient(
      { data: null, error: { message: "boom" } },
      { data: null, error: { message: "boom" } },
    );
    expect(await assembleSignals(client, USER)).toEqual(EMPTY_SIGNALS);
  });

  it("ignores malformed attempt rows instead of inventing numbers", async () => {
    const client = fakeClient(
      { data: [], error: null },
      {
        data: [
          "not-a-row", // not a record → skipped entirely
          { score: "4", total: "10" }, // wrong types → counted as 0/0
          { score: 4, total: 10, study_artifacts: null },
        ],
        error: null,
      },
    );
    const signals = await assembleSignals(client, USER);
    expect(signals.quiz_attempts).toBe(2);
    // 0 + 4 out of 0 + 10
    expect(signals.quiz_accuracy).toBe(0.4);
    expect(signals.weak_difficulty).toBeNull(); // no difficulty labels
  });
});

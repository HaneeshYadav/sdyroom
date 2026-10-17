import {
  AnalyticsError,
  fetchPersonalAnalytics,
  fetchRoomAnalytics,
  mapAnalyticsRpcError,
} from "@/lib/analytics/queries";
import { utcTodayIso } from "@/lib/planner/dates";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM = "11111111-1111-4111-8111-111111111111";

function day(index: number) {
  return {
    date: `2026-10-${String(index).padStart(2, "0")}`,
    focus_minutes: index,
    goals_completed: 1,
    quizzes_taken: 0,
    cards_reviewed: 2,
    uploads: 0,
    quiz_correct: 0,
    quiz_total: 0,
  };
}

/** The raw `analytics_me` jsonb the fetcher maps — mutable for test setups. */
type RpcPayload = {
  days: ReturnType<typeof day>[];
  summary: {
    focus_minutes: number;
    goals_completed: number;
    goals_created: number;
    goals_active: number;
    quiz_correct: number;
    quiz_total: number;
    accuracy: number | null;
    quiz_by_difficulty: { difficulty: string; correct: number; total: number }[];
    cards_due: number;
    uploads: number;
    upload_bytes: number;
    sessions: number;
    avg_session_minutes: number;
    previous_focus_minutes: number;
  };
  study_days: string[];
  plan: {
    planned_minutes: number;
    items_total: number;
    items_done: number;
    items_overdue: number;
  } | null;
};

function personalPayload(days: number): RpcPayload {
  return {
    days: Array.from({ length: days }, (_, index) => day(index + 1)),
    summary: {
      focus_minutes: 100,
      goals_completed: 4,
      goals_created: 6,
      goals_active: 2,
      quiz_correct: 8,
      quiz_total: 10,
      accuracy: 0.8,
      quiz_by_difficulty: [{ difficulty: "hard", correct: 2, total: 5 }],
      cards_due: 3,
      uploads: 1,
      upload_bytes: 2048,
      sessions: 2,
      avg_session_minutes: 50,
      previous_focus_minutes: 60,
    },
    study_days: [] as string[],
    plan: null,
  };
}

function rpcClient(result: { data?: unknown; error?: { message: string } }): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  } as unknown as SupabaseClient;
}

describe("mapAnalyticsRpcError", () => {
  it("maps each SECURITY DEFINER message to its typed failure", () => {
    expect(mapAnalyticsRpcError({ message: "unauthenticated" })).toMatchObject({
      code: "unauthenticated",
      status: 401,
    });
    expect(mapAnalyticsRpcError({ message: "not_found" })).toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(mapAnalyticsRpcError({ message: "validation" })).toMatchObject({
      code: "validation",
      status: 400,
    });
    expect(mapAnalyticsRpcError({ message: "boom" })).toMatchObject({
      code: "analytics_failed",
      status: 500,
    });
  });
});

describe("fetchPersonalAnalytics", () => {
  it("calls analytics_me with the session subject and merges streaks", async () => {
    const today = utcTodayIso();
    const payload = personalPayload(7);
    payload.study_days = [today];
    const client = rpcClient({ data: payload });

    const result = await fetchPersonalAnalytics(client, { userId: USER, days: 7 });

    expect(client.rpc).toHaveBeenCalledWith("analytics_me", {
      p_user_id: USER,
      p_days: 7,
    });
    expect(result.days).toHaveLength(7);
    expect(result.summary.current_streak_days).toBe(1);
    expect(result.summary.longest_streak_days).toBe(1);
    expect(result.summary.study_days).toBe(1);
    expect(result.summary.focus_minutes).toBe(100);
    expect(result.plan).toBeNull();
  });

  it("keeps an honest null accuracy and the window-scoped plan", async () => {
    const payload = personalPayload(30);
    payload.summary.accuracy = null;
    payload.summary.quiz_by_difficulty = [];
    payload.plan = {
      planned_minutes: 60,
      items_total: 4,
      items_done: 1,
      items_overdue: 2,
    };
    const client = rpcClient({ data: payload });

    const result = await fetchPersonalAnalytics(client, { userId: USER, days: 30 });

    expect(result.summary.accuracy).toBeNull();
    expect(result.plan).toEqual({
      planned_minutes: 60,
      items_total: 4,
      items_done: 1,
      items_overdue: 2,
    });
  });

  it("turns RPC failures into typed errors", async () => {
    const client = rpcClient({ error: { message: "permission denied" } });
    await expect(
      fetchPersonalAnalytics(client, { userId: USER, days: 7 }),
    ).rejects.toMatchObject({ code: "analytics_failed", status: 500 });

    const denied = rpcClient({ error: { message: "unauthenticated" } });
    await expect(
      fetchPersonalAnalytics(denied, { userId: USER, days: 7 }),
    ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  });

  it("fails loudly instead of serving zeros on a malformed payload", async () => {
    const short = personalPayload(3);
    const client = rpcClient({ data: short });
    await expect(
      fetchPersonalAnalytics(client, { userId: USER, days: 7 }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AnalyticsError &&
        error.code === "analytics_failed" &&
        error.status === 500,
    );

    const notRows = rpcClient({ data: { days: "nope", summary: {}, study_days: [] } });
    await expect(
      fetchPersonalAnalytics(notRows, { userId: USER, days: 7 }),
    ).rejects.toBeInstanceOf(AnalyticsError);

    const badAccuracy = personalPayload(7);
    badAccuracy.summary.accuracy = "80%" as unknown as number;
    const client2 = rpcClient({ data: badAccuracy });
    await expect(
      fetchPersonalAnalytics(client2, { userId: USER, days: 7 }),
    ).rejects.toBeInstanceOf(AnalyticsError);
  });
});

describe("fetchRoomAnalytics", () => {
  it("maps the room payload and forwards the window", async () => {
    const client = rpcClient({
      data: {
        days: [
          { date: "2026-10-16", focus_minutes: 40, active_members: 2, quiz_attempts: 1 },
          { date: "2026-10-17", focus_minutes: 45, active_members: 1, quiz_attempts: 0 },
        ],
        summary: {
          focus_minutes_total: 85,
          active_members: 2,
          goals_created: 3,
          goals_completed: 2,
          quiz_attempts: 1,
          quiz_correct: 8,
          quiz_total: 10,
          uploads: 4,
        },
      },
    });

    const result = await fetchRoomAnalytics(client, { roomId: ROOM, days: 2 });

    expect(client.rpc).toHaveBeenCalledWith("analytics_room", {
      p_room_id: ROOM,
      p_days: 2,
    });
    expect(result.days).toHaveLength(2);
    expect(result.summary).toEqual({
      focus_minutes_total: 85,
      active_members: 2,
      goals_created: 3,
      goals_completed: 2,
      quiz_attempts: 1,
      quiz_correct: 8,
      quiz_total: 10,
      uploads: 4,
    });
  });

  it("propagates not_found for members, strangers and missing rooms alike", async () => {
    const client = rpcClient({ error: { message: "not_found" } });
    await expect(
      fetchRoomAnalytics(client, { roomId: ROOM, days: 7 }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

import { GET as meGET } from "@/app/api/analytics/me/route";
import { GET as meCsvGET } from "@/app/api/analytics/me.csv/route";
import { GET as roomGET } from "@/app/api/analytics/rooms/[id]/route";
import { analyticsDaysToCsv } from "@/lib/analytics/csv";
import { AnalyticsError } from "@/lib/analytics/queries";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, fetchPersonalAnalytics, fetchRoomAnalytics } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    fetchPersonalAnalytics: vi.fn(),
    fetchRoomAnalytics: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/analytics/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/queries")>()),
  fetchPersonalAnalytics,
  fetchRoomAnalytics,
}));

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM = "11111111-1111-4111-8111-111111111111";

const PERSONAL_DAY_KEYS = [
  "cards_reviewed",
  "date",
  "focus_minutes",
  "goals_completed",
  "quiz_correct",
  "quiz_total",
  "quizzes_taken",
  "uploads",
].sort();

const SUMMARY = {
  focus_minutes: 85,
  goals_completed: 2,
  goals_created: 3,
  goals_active: 1,
  quiz_correct: 8,
  quiz_total: 10,
  accuracy: 0.8,
  quiz_by_difficulty: [{ difficulty: "hard", correct: 3, total: 5 }],
  cards_due: 9,
  uploads: 4,
  upload_bytes: 4096,
  sessions: 2,
  avg_session_minutes: 43,
  previous_focus_minutes: 40,
  study_days: 5,
  current_streak_days: 2,
  longest_streak_days: 4,
};

function personalDays(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, "0")}`,
    focus_minutes: index * 10,
    goals_completed: 1,
    quizzes_taken: 2,
    cards_reviewed: 3,
    uploads: 1,
    quiz_correct: 4,
    quiz_total: 5,
  }));
}

const ROOM_SUMMARY = {
  focus_minutes_total: 85,
  active_members: 2,
  goals_created: 3,
  goals_completed: 2,
  quiz_attempts: 2,
  quiz_correct: 8,
  quiz_total: 10,
  uploads: 4,
};

const ROOM_DAY_KEYS = [
  "active_members",
  "date",
  "focus_minutes",
  "quiz_attempts",
].sort();

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

function roomContext(roomId = ROOM) {
  return { params: Promise.resolve({ id: roomId }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  createClient.mockResolvedValue({ auth: { getClaims } });
  fetchPersonalAnalytics.mockResolvedValue({
    days: personalDays(7),
    summary: SUMMARY,
    plan: null,
  });
  fetchRoomAnalytics.mockResolvedValue({
    days: [
      { date: "2026-10-16", focus_minutes: 40, active_members: 2, quiz_attempts: 1 },
      { date: "2026-10-17", focus_minutes: 45, active_members: 1, quiz_attempts: 1 },
    ],
    summary: ROOM_SUMMARY,
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/analytics/me", () => {
  it("requires a session", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await meGET(request("/api/analytics/me?range=7d"));
    expect(response.status).toBe(401);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("unauthenticated");
    expect(fetchPersonalAnalytics).not.toHaveBeenCalled();
  });

  it("rejects a missing range with 400 validation — no default here", async () => {
    const response = await meGET(request("/api/analytics/me"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation");
    expect(fetchPersonalAnalytics).not.toHaveBeenCalled();
  });

  it("rejects an unknown range with 400 validation", async () => {
    const response = await meGET(request("/api/analytics/me?range=1y"));
    expect(response.status).toBe(400);
    expect(fetchPersonalAnalytics).not.toHaveBeenCalled();
  });

  it("serves the range, days, summary and plan for the session subject only", async () => {
    const response = await meGET(request("/api/analytics/me?range=30d"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["days", "plan", "range", "summary"]);
    expect(body.range).toBe("30d");
    expect(fetchPersonalAnalytics).toHaveBeenCalledWith(expect.anything(), {
      userId: USER,
      days: 30,
    });
    const firstDay = (body.days as Record<string, unknown>[])[0];
    expect(Object.keys(firstDay ?? {}).sort()).toEqual(PERSONAL_DAY_KEYS);
  });

  it("ignores any identity parameter — the subject is always the session", async () => {
    const response = await meGET(
      request("/api/analytics/me?range=7d&user_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    );
    expect(response.status).toBe(200);
    expect(fetchPersonalAnalytics).toHaveBeenCalledWith(expect.anything(), {
      userId: USER,
      days: 7,
    });
  });

  it("serves the CSV variant row-for-row equal to the JSON days", async () => {
    const days = personalDays(7);
    const response = await meGET(request("/api/analytics/me?range=7d&format=csv"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(
      'filename="study-analytics-7d.csv"',
    );
    expect(await response.text()).toBe(analyticsDaysToCsv(days));
  });

  it("maps a typed analytics failure and an unknown failure", async () => {
    fetchPersonalAnalytics.mockRejectedValueOnce(
      new AnalyticsError("validation", "bad", 400),
    );
    const invalid = await meGET(request("/api/analytics/me?range=7d"));
    expect(invalid.status).toBe(400);

    fetchPersonalAnalytics.mockRejectedValueOnce(new Error("db down"));
    const failed = await meGET(request("/api/analytics/me?range=7d"));
    expect(failed.status).toBe(500);
    expect(
      ((await failed.json()) as { error: { code: string } }).error.code,
    ).toBe("analytics_failed");
  });
});

describe("GET /api/analytics/me.csv", () => {
  it("is the /me handler with format=csv forced (same auth and range rules)", async () => {
    const response = await meCsvGET(request("/api/analytics/me.csv?range=90d"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      'filename="study-analytics-90d.csv"',
    );
    expect(fetchPersonalAnalytics).toHaveBeenCalledWith(expect.anything(), {
      userId: USER,
      days: 90,
    });
    expect(await response.text()).toBe(analyticsDaysToCsv(personalDays(7)));
  });

  it("still demands a range", async () => {
    const response = await meCsvGET(request("/api/analytics/me.csv"));
    expect(response.status).toBe(400);
    expect(fetchPersonalAnalytics).not.toHaveBeenCalled();
  });
});

describe("GET /api/analytics/rooms/[id]", () => {
  it("requires a session", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await roomGET(request(`/api/analytics/rooms/${ROOM}?range=7d`), roomContext());
    expect(response.status).toBe(401);
    expect(fetchRoomAnalytics).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID room id", async () => {
    const response = await roomGET(
      request("/api/analytics/rooms/not-a-uuid?range=7d"),
      roomContext("not-a-uuid"),
    );
    expect(response.status).toBe(400);
    expect(fetchRoomAnalytics).not.toHaveBeenCalled();
  });

  it("rejects a missing or unknown range", async () => {
    const missing = await roomGET(
      request(`/api/analytics/rooms/${ROOM}`),
      roomContext(),
    );
    expect(missing.status).toBe(400);

    const unknown = await roomGET(
      request(`/api/analytics/rooms/${ROOM}?range=1y`),
      roomContext(),
    );
    expect(unknown.status).toBe(400);
    expect(fetchRoomAnalytics).not.toHaveBeenCalled();
  });

  it("serves counts-only payload keys for the window", async () => {
    const response = await roomGET(
      request(`/api/analytics/rooms/${ROOM}?range=30d`),
      roomContext(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["days", "range", "summary"]);
    expect(body.range).toBe("30d");
    expect(fetchRoomAnalytics).toHaveBeenCalledWith(expect.anything(), {
      roomId: ROOM,
      days: 30,
    });
    const summary = body.summary as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual([
      "active_members",
      "focus_minutes_total",
      "goals_completed",
      "goals_created",
      "quiz_attempts",
      "quiz_correct",
      "quiz_total",
      "uploads",
    ]);
    const firstDay = (body.days as Record<string, unknown>[])[0];
    expect(Object.keys(firstDay ?? {}).sort()).toEqual(ROOM_DAY_KEYS);
    // No member-identifying field may ever appear anywhere in the payload.
    const flat = JSON.stringify(body).toLowerCase();
    expect(flat).not.toContain("alias");
    expect(flat).not.toContain("user_id");
    expect(flat).not.toContain("email");
  });

  it("answers not_found with 404 for member, stranger and missing room alike", async () => {
    fetchRoomAnalytics.mockRejectedValueOnce(
      new AnalyticsError("not_found", "gone", 404),
    );
    const response = await roomGET(
      request(`/api/analytics/rooms/${ROOM}?range=7d`),
      roomContext(),
    );
    expect(response.status).toBe(404);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("not_found");
  });

  it("propagates an expired session as 401 and unknown failures as 500", async () => {
    fetchRoomAnalytics.mockRejectedValueOnce(
      new AnalyticsError("unauthenticated", "Sign in.", 401),
    );
    const expired = await roomGET(
      request(`/api/analytics/rooms/${ROOM}?range=7d`),
      roomContext(),
    );
    expect(expired.status).toBe(401);

    fetchRoomAnalytics.mockRejectedValueOnce(new Error("db down"));
    const failed = await roomGET(
      request(`/api/analytics/rooms/${ROOM}?range=7d`),
      roomContext(),
    );
    expect(failed.status).toBe(500);
    expect(
      ((await failed.json()) as { error: { code: string } }).error.code,
    ).toBe("analytics_failed");
  });
});

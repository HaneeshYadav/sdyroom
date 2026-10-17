import type { SupabaseClient } from "@supabase/supabase-js";

import { computeStreaks } from "@/lib/analytics/streaks";
import { utcTodayIso } from "@/lib/planner/dates";

/**
 * Analytics data access (PR 16): two RPC calls, one round trip per panel.
 *
 * The database does the aggregation and holds the privilege checks
 * (`analytics_me` is pinned to `auth.uid()`, `analytics_room` asserts
 * owner/moderator inside the function); this module only maps the returned
 * jsonb into the shapes the routes and pages serve, turns SECURITY DEFINER
 * failures into typed HTTP errors, and computes the streak numbers from the
 * RPC's `study_days` (TS, so the boundary rules are unit-testable).
 *
 * Every mapper is strict: a payload that does not match the contract fails
 * as `analytics_failed` instead of silently serving zeros.
 */

export type AnalyticsErrorCode =
  | "unauthenticated"
  | "not_found"
  | "validation"
  | "analytics_failed";

export class AnalyticsError extends Error {
  readonly code: AnalyticsErrorCode;
  readonly status: number;

  constructor(code: AnalyticsErrorCode, message: string, status: number) {
    super(message);
    this.name = "AnalyticsError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Maps SECURITY DEFINER error messages (0021 raises bare strings) to typed
 * HTTP failures. `not_found` is what both a plain member and a stranger get
 * from `analytics_room` — the route answers 404 for either, so the URL never
 * reveals which rooms exist or who moderates them.
 */
export function mapAnalyticsRpcError(error: { message: string }): AnalyticsError {
  const message = error.message;
  if (message.includes("unauthenticated")) {
    return new AnalyticsError(
      "unauthenticated",
      "Sign in to view your study analytics.",
      401,
    );
  }
  if (message.includes("not_found")) {
    return new AnalyticsError(
      "not_found",
      "That room does not exist or is not available to you.",
      404,
    );
  }
  if (message.includes("validation")) {
    return new AnalyticsError(
      "validation",
      "That request was not valid.",
      400,
    );
  }
  return new AnalyticsError(
    "analytics_failed",
    "Could not load study analytics.",
    500,
  );
}

// ---------------------------------------------------------------------------
// Shapes (the API contract; mirrored in docs/API_CONTRACTS.md)
// ---------------------------------------------------------------------------

export type PersonalDay = {
  date: string;
  focus_minutes: number;
  goals_completed: number;
  quizzes_taken: number;
  cards_reviewed: number;
  uploads: number;
  /** Chart inputs for the accuracy panel; not part of the CSV export. */
  quiz_correct: number;
  quiz_total: number;
};

export type QuizDifficultyBreakdown = {
  difficulty: string;
  correct: number;
  total: number;
};

/** The caller's active plan inside the same window; null when none. */
export type PlanWindow = {
  planned_minutes: number;
  items_total: number;
  items_done: number;
  items_overdue: number;
} | null;

export type PersonalSummary = {
  focus_minutes: number;
  goals_completed: number;
  goals_created: number;
  goals_active: number;
  quiz_correct: number;
  quiz_total: number;
  /** null when no question was answered in the range — never a fake 0. */
  accuracy: number | null;
  quiz_by_difficulty: QuizDifficultyBreakdown[];
  cards_due: number;
  uploads: number;
  upload_bytes: number;
  sessions: number;
  avg_session_minutes: number;
  previous_focus_minutes: number;
  study_days: number;
  current_streak_days: number;
  longest_streak_days: number;
};

export type PersonalAnalytics = {
  days: PersonalDay[];
  summary: PersonalSummary;
  plan: PlanWindow;
};

export type RoomDay = {
  date: string;
  focus_minutes: number;
  active_members: number;
  quiz_attempts: number;
};

export type RoomSummary = {
  focus_minutes_total: number;
  active_members: number;
  goals_created: number;
  goals_completed: number;
  quiz_attempts: number;
  quiz_correct: number;
  quiz_total: number;
  uploads: number;
};

export type RoomAnalytics = {
  days: RoomDay[];
  summary: RoomSummary;
};

// ---------------------------------------------------------------------------
// Payload mapping (strict)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badPayload(detail: string): AnalyticsError {
  return new AnalyticsError(
    "analytics_failed",
    `Study analytics returned an unexpected payload (${detail}).`,
    500,
  );
}

function requireRecord(value: unknown, detail: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw badPayload(detail);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badPayload(`expected a number for "${key}"`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw badPayload(`expected a string for "${key}"`);
  }
  return value;
}

function requireArray(value: unknown, detail: string): unknown[] {
  if (!Array.isArray(value)) {
    throw badPayload(detail);
  }
  return value;
}

function mapDay(value: unknown): PersonalDay {
  const row = requireRecord(value, "day row");
  return {
    date: requireString(row, "date"),
    focus_minutes: requireNumber(row, "focus_minutes"),
    goals_completed: requireNumber(row, "goals_completed"),
    quizzes_taken: requireNumber(row, "quizzes_taken"),
    cards_reviewed: requireNumber(row, "cards_reviewed"),
    uploads: requireNumber(row, "uploads"),
    quiz_correct: requireNumber(row, "quiz_correct"),
    quiz_total: requireNumber(row, "quiz_total"),
  };
}

function mapRoomDay(value: unknown): RoomDay {
  const row = requireRecord(value, "room day row");
  return {
    date: requireString(row, "date"),
    focus_minutes: requireNumber(row, "focus_minutes"),
    active_members: requireNumber(row, "active_members"),
    quiz_attempts: requireNumber(row, "quiz_attempts"),
  };
}

function mapDifficulty(value: unknown): QuizDifficultyBreakdown {
  const row = requireRecord(value, "difficulty row");
  return {
    difficulty: requireString(row, "difficulty"),
    correct: requireNumber(row, "correct"),
    total: requireNumber(row, "total"),
  };
}

function mapPlan(value: unknown): PlanWindow {
  if (value === null) {
    return null;
  }
  const row = requireRecord(value, "plan");
  return {
    planned_minutes: requireNumber(row, "planned_minutes"),
    items_total: requireNumber(row, "items_total"),
    items_done: requireNumber(row, "items_done"),
    items_overdue: requireNumber(row, "items_overdue"),
  };
}

function mapPersonalPayload(
  data: unknown,
  expectedDays: number,
): { days: PersonalDay[]; summary: Omit<PersonalSummary, "study_days" | "current_streak_days" | "longest_streak_days">; plan: PlanWindow; studyDays: string[] } {
  const payload = requireRecord(data, "analytics_me result");
  const days = requireArray(payload.days, "expected a days array").map(mapDay);
  if (days.length !== expectedDays) {
    throw badPayload(`expected ${expectedDays} day rows, got ${days.length}`);
  }
  const summaryRow = requireRecord(payload.summary, "summary");
  const difficulty = requireArray(
    summaryRow.quiz_by_difficulty,
    "expected a quiz_by_difficulty array",
  ).map(mapDifficulty);
  const rawAccuracy = summaryRow.accuracy;
  if (
    rawAccuracy !== null &&
    (typeof rawAccuracy !== "number" || !Number.isFinite(rawAccuracy))
  ) {
    throw badPayload('expected a number or null for "accuracy"');
  }
  const accuracy = rawAccuracy;
  const studyDays = requireArray(payload.study_days, "expected a study_days array").map(
    (value) => {
      if (typeof value !== "string") {
        throw badPayload("expected study_days to hold strings");
      }
      return value;
    },
  );

  return {
    days,
    plan: mapPlan(payload.plan),
    studyDays,
    summary: {
      focus_minutes: requireNumber(summaryRow, "focus_minutes"),
      goals_completed: requireNumber(summaryRow, "goals_completed"),
      goals_created: requireNumber(summaryRow, "goals_created"),
      goals_active: requireNumber(summaryRow, "goals_active"),
      quiz_correct: requireNumber(summaryRow, "quiz_correct"),
      quiz_total: requireNumber(summaryRow, "quiz_total"),
      accuracy,
      quiz_by_difficulty: difficulty,
      cards_due: requireNumber(summaryRow, "cards_due"),
      uploads: requireNumber(summaryRow, "uploads"),
      upload_bytes: requireNumber(summaryRow, "upload_bytes"),
      sessions: requireNumber(summaryRow, "sessions"),
      avg_session_minutes: requireNumber(summaryRow, "avg_session_minutes"),
      previous_focus_minutes: requireNumber(summaryRow, "previous_focus_minutes"),
    },
  };
}

function mapRoomPayload(
  data: unknown,
  expectedDays: number,
): RoomAnalytics {
  const payload = requireRecord(data, "analytics_room result");
  const days = requireArray(payload.days, "expected a days array").map(mapRoomDay);
  if (days.length !== expectedDays) {
    throw badPayload(`expected ${expectedDays} day rows, got ${days.length}`);
  }
  const summaryRow = requireRecord(payload.summary, "summary");
  return {
    days,
    summary: {
      focus_minutes_total: requireNumber(summaryRow, "focus_minutes_total"),
      active_members: requireNumber(summaryRow, "active_members"),
      goals_created: requireNumber(summaryRow, "goals_created"),
      goals_completed: requireNumber(summaryRow, "goals_completed"),
      quiz_attempts: requireNumber(summaryRow, "quiz_attempts"),
      quiz_correct: requireNumber(summaryRow, "quiz_correct"),
      quiz_total: requireNumber(summaryRow, "quiz_total"),
      uploads: requireNumber(summaryRow, "uploads"),
    },
  };
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export type PersonalAnalyticsInput = {
  /** The session's user id. The RPC aggregates `auth.uid()` regardless. */
  userId: string;
  /** Inclusive day count: 7, 30 or 90 (validated again inside the RPC). */
  days: number;
};

/**
 * The caller's own panel: one `analytics_me` round trip, streaks computed
 * over the returned `study_days` against today's UTC date.
 */
export async function fetchPersonalAnalytics(
  client: SupabaseClient,
  input: PersonalAnalyticsInput,
): Promise<PersonalAnalytics> {
  const { data, error } = await client.rpc("analytics_me", {
    p_user_id: input.userId,
    p_days: input.days,
  });
  if (error) {
    throw mapAnalyticsRpcError(error);
  }

  const mapped = mapPersonalPayload(data, input.days);
  const streaks = computeStreaks(mapped.studyDays, utcTodayIso());
  return {
    days: mapped.days,
    plan: mapped.plan,
    summary: {
      ...mapped.summary,
      study_days: streaks.studyDays,
      current_streak_days: streaks.currentStreakDays,
      longest_streak_days: streaks.longestStreakDays,
    },
  };
}

export type RoomAnalyticsInput = {
  roomId: string;
  days: number;
};

/**
 * The room's aggregate panel: one `analytics_room` round trip. Authorization
 * is inside the RPC — this only maps the payload; a plain member or a
 * stranger arrives here as `AnalyticsError` `not_found` either way.
 */
export async function fetchRoomAnalytics(
  client: SupabaseClient,
  input: RoomAnalyticsInput,
): Promise<RoomAnalytics> {
  const { data, error } = await client.rpc("analytics_room", {
    p_room_id: input.roomId,
    p_days: input.days,
  });
  if (error) {
    throw mapAnalyticsRpcError(error);
  }
  return mapRoomPayload(data, input.days);
}

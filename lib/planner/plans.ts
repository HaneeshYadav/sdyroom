/**
 * Study-plan orchestration (PR-15, spec: docs/prs/PR-15-ai-study-planner.md).
 *
 * The routes own request concerns (session, Zod bodies, rate limits, CSV
 * headers) and this module owns the application pipeline:
 *
 *   POST /api/plans       createPlan — room/document probes, quota
 *                         pre-check, `create_plan` (the table's only insert)
 *   POST …/step           runPlanStep — signals → retrieve → prompt →
 *                         complete → parse-validate → `generate_plan`
 *                         → self-notification, exactly one provider call
 *   reads                 getPlan / listPlans (RLS own rows + `plan_stats`
 *                         for the progress authority)
 *   actions               markItemDone / completeDay / shiftPlan /
 *                         archivePlan — thin wrappers over the RPCs with
 *                         the same 404/409 posture the database enforces
 *
 * Invariants (unit- and integration-tested):
 *   * identity comes from the verified session everywhere — no body field
 *     carries a user id, and `create_plan` re-asserts `p_user_id =
 *     auth.uid()` inside the database;
 *   * a visible room the caller is not a member of is 403
 *     `room_not_member`; an invisible or missing room is 404 — the probe
 *     never becomes an existence oracle (RLS decides what is visible);
 *   * documents must be files of the linked room or the caller's own
 *     personal files; a bad id is a 400 before any RPC, re-checked in SQL;
 *   * a foreign plan or item id is 404 in every path (the RPCs raise
 *     `not_found`, indistinguishable from missing);
 *   * malformed model output fails the plan (`ai_provider_failed`) and is
 *     never persisted as `active`;
 *   * chat spend joins PR-12's ledger through `generate_plan`, which
 *     re-enforces the per-user daily cap in the database.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { chatTokensUsedToday, CHAT_DAILY_TOKEN_LIMIT } from "@/lib/ai/ask";
import { notifySelf } from "@/lib/notifications/write";
import { getProvider } from "@/lib/ai/provider";
import { applyContextBudget } from "@/lib/ai/prompts/ask";
import {
  buildPlanMessages,
  PLAN_MAX_OUTPUT_TOKENS,
} from "@/lib/ai/prompts/plan";
import { hrefForResource, retrieve } from "@/lib/ai/retrieve";
import { estimateTokens } from "@/lib/ai/tokens";
import type { ApiIssue } from "@/lib/api/responses";
import { diffDays, utcTodayIso } from "@/lib/planner/dates";
import type { PlanProgress } from "@/lib/planner/progress";
import { computeShift } from "@/lib/planner/shift";
import { assembleSignals } from "@/lib/planner/signals";
import { parsePlanPayload, PlanValidationError, type PlanKind } from "@/lib/planner/validate";
import type { CreatePlanBody } from "@/lib/validation/planner";
import { logError } from "@/lib/server/log";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PlanErrorCode =
  | "unauthenticated"
  | "not_found"
  | "validation"
  | "room_not_member"
  | "plan_already_active"
  | "plan_not_active"
  | "ai_quota_exceeded"
  | "ai_provider_failed"
  | "plans_failed";

export class PlanError extends Error {
  readonly code: PlanErrorCode;
  readonly status: number;
  readonly issues: ApiIssue[] | undefined;

  constructor(
    code: PlanErrorCode,
    message: string,
    status: number,
    issues?: ApiIssue[],
  ) {
    super(message);
    this.name = "PlanError";
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Maps SECURITY DEFINER error messages (0020 raises bare strings) to typed
 * HTTP failures. `fallback` is the 500 code for the calling route.
 *
 * Deliberate mapping decisions (documented in docs/API_CONTRACTS.md):
 * `not_owner` can only arrive from a caller passing a foreign `p_user_id`
 * (the routes never do) and is answered 404 — same non-oracle posture as a
 * foreign plan id, so probing ownership paths reveals nothing.
 */
export function mapPlanRpcError(
  error: { message: string },
  fallback: PlanErrorCode,
  fallbackMessage: string,
): PlanError {
  const message = error.message;
  if (message.includes("unauthenticated")) {
    return new PlanError("unauthenticated", "Sign in to continue.", 401);
  }
  if (message.includes("room_not_member")) {
    return new PlanError(
      "room_not_member",
      "You are not a member of that room.",
      403,
    );
  }
  if (message.includes("ai_quota_exceeded")) {
    return new PlanError(
      "ai_quota_exceeded",
      "You have reached your daily AI limit. Try again tomorrow.",
      403,
    );
  }
  if (message.includes("plan_already_active")) {
    return new PlanError(
      "plan_already_active",
      "You already have an active plan. Regenerate or archive it first.",
      409,
    );
  }
  if (message.includes("plan_not_active")) {
    return new PlanError(
      "plan_not_active",
      "That plan is read-only right now. Regenerate it to make changes.",
      409,
    );
  }
  if (message.includes("plan_invalid")) {
    return new PlanError(
      "ai_provider_failed",
      "The provider returned an invalid study plan.",
      502,
    );
  }
  if (message.includes("plan_failed")) {
    return new PlanError(
      "plans_failed",
      "Could not start generation. Try again.",
      500,
    );
  }
  if (message.includes("not_owner") || message.includes("not_found")) {
    return new PlanError(
      "not_found",
      "That plan does not exist or is not available.",
      404,
    );
  }
  if (message.includes("validation")) {
    return new PlanError("validation", "That request was not valid.", 400);
  }
  return new PlanError(fallback, fallbackMessage, 500);
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * Explicit column lists everywhere: `prompt_tokens`/`completion_tokens` are
 * deliberately ungranted to app roles (0020's grant section), and naming
 * the readable columns documents the contract the UI may rely on.
 */
const PLAN_COLUMNS =
  "id, user_id, room_id, status, exam_date, hours_per_day, topics, document_ids, summary, error_code, model, created_at, updated_at, generated_at, archived_at";

const ITEM_COLUMNS =
  "id, plan_id, ordinal, item_date, subject, task, kind, estimated_minutes, resource_id, citation, created_at, done_at";

export type PlanStatus = "generating" | "active" | "failed" | "archived";

export type PlanRow = {
  id: string;
  user_id: string;
  room_id: string | null;
  status: PlanStatus;
  exam_date: string;
  hours_per_day: number;
  topics: string[];
  document_ids: string[];
  summary: string | null;
  error_code: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  generated_at: string | null;
  archived_at: string | null;
};

export type PlanView = {
  id: string;
  room_id: string | null;
  status: PlanStatus;
  exam_date: string;
  hours_per_day: number;
  topics: string[];
  document_ids: string[];
  summary: string | null;
  error_code: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  generated_at: string | null;
  href: string;
};

export type PlanItemRow = {
  id: string;
  plan_id: string;
  ordinal: number;
  item_date: string;
  subject: string | null;
  task: string;
  kind: PlanKind;
  estimated_minutes: number;
  resource_id: string | null;
  citation: { title: string; href: string } | null;
  created_at: string;
  done_at: string | null;
};

export type PlanItemView = {
  id: string;
  ordinal: number;
  date: string;
  subject: string | null;
  task: string;
  estimated_minutes: number;
  kind: PlanKind;
  resource_id: string | null;
  citation: { title: string; href: string } | null;
  done: boolean;
  done_at: string | null;
};

export type PlanDetail = {
  plan: PlanView;
  items: PlanItemView[];
  progress: PlanProgress;
  item_count: number;
  days: number;
};

export function planHref(planId: string): string {
  return `/planner?plan=${planId}`;
}

function mapPlanRow(row: PlanRow): PlanView {
  return {
    id: row.id,
    room_id: row.room_id,
    status: row.status,
    exam_date: row.exam_date,
    hours_per_day: row.hours_per_day,
    topics: row.topics ?? [],
    document_ids: row.document_ids ?? [],
    summary: row.summary,
    error_code: row.error_code,
    model: row.model,
    created_at: row.created_at,
    updated_at: row.updated_at,
    generated_at: row.generated_at,
    href: planHref(row.id),
  };
}

function mapItemRow(row: PlanItemRow): PlanItemView {
  return {
    id: row.id,
    ordinal: row.ordinal,
    date: row.item_date,
    subject: row.subject,
    task: row.task,
    estimated_minutes: row.estimated_minutes,
    kind: row.kind,
    resource_id: row.resource_id,
    citation: row.resource_id === null ? null : row.citation,
    done: row.done_at !== null,
    done_at: row.done_at,
  };
}

type StatsResult = {
  id: string;
  status: PlanStatus;
  exam_date: string;
  hours_per_day: number;
  summary: string | null;
  error_code: string | null;
  item_count: number;
  days: number;
  progress: PlanProgress;
};

function parseStats(data: unknown): StatsResult {
  if (!isRecord(data) || typeof data.id !== "string" || !isRecord(data.progress)) {
    throw new PlanError(
      "plans_failed",
      "Could not read plan stats: malformed plan_stats response",
      500,
    );
  }
  return {
    id: String(data.id),
    status: data.status as PlanStatus,
    exam_date: String(data.exam_date),
    hours_per_day: Number(data.hours_per_day),
    summary: typeof data.summary === "string" ? data.summary : null,
    error_code: typeof data.error_code === "string" ? data.error_code : null,
    item_count: Number(data.item_count ?? 0),
    days: Number(data.days ?? 0),
    progress: data.progress as PlanProgress,
  };
}

async function planStats(client: SupabaseClient, planId: string): Promise<StatsResult> {
  const { data, error } = await client.rpc("plan_stats", { p_plan_id: planId });
  if (error) {
    throw mapPlanRpcError(error, "plans_failed", "Could not read that plan.");
  }
  return parseStats(data);
}

// ---------------------------------------------------------------------------
// Create (POST /api/plans)
// ---------------------------------------------------------------------------

export type CreatedPlan = {
  id: string;
  status: PlanStatus;
  exam_date: string;
  deduped: boolean;
  href: string;
};

/**
 * Room probe (service, so a bypassed route keeps the same answers): RLS
 * decides what is *visible* — a public room the caller is not a member of
 * is visible and becomes 403 `room_not_member` after the membership probe;
 * a private room (or a missing id) is invisible and becomes 404
 * `not_found`, so the response never distinguishes the two.
 */
async function assertRoomAccess(
  client: SupabaseClient,
  userId: string,
  roomId: string,
): Promise<void> {
  const room = await client
    .from("rooms")
    .select("id")
    .eq("id", roomId)
    .maybeSingle();
  if (room.error) {
    throw new PlanError(
      "plans_failed",
      `Room check failed: ${room.error.message}`,
      500,
    );
  }
  if (!room.data) {
    throw new PlanError(
      "not_found",
      "That room does not exist or is not available.",
      404,
    );
  }

  const member = await client
    .from("room_members")
    .select("room_id")
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .maybeSingle();
  if (member.error) {
    throw new PlanError(
      "plans_failed",
      `Room membership check failed: ${member.error.message}`,
      500,
    );
  }
  if (!member.data) {
    throw new PlanError(
      "room_not_member",
      "You are not a member of that room.",
      403,
    );
  }
}

/**
 * Document pre-check (400 before any RPC): every id must come back through
 * RLS *and* satisfy the accessibility rule — a file of the linked room, or
 * the caller's own personal file (personal files stay usable with a room
 * linked; a room file never is). `create_plan` re-checks the same rule.
 */
async function assertDocumentsAccessible(
  client: SupabaseClient,
  documentIds: string[],
  roomId: string | null,
): Promise<void> {
  if (documentIds.length === 0) {
    return;
  }
  const { data, error } = await client
    .from("study_resources")
    .select("id, room_id")
    .in("id", documentIds);
  if (error) {
    throw new PlanError(
      "plans_failed",
      `Document check failed: ${error.message}`,
      500,
    );
  }
  const readable = new Map<string, string | null>();
  for (const row of Array.isArray(data) ? data : []) {
    if (isRecord(row) && typeof row.id === "string") {
      readable.set(row.id, typeof row.room_id === "string" ? row.room_id : null);
    }
  }
  const bad = documentIds.filter((id) => {
    if (!readable.has(id)) {
      return true;
    }
    const ownerRoom = readable.get(id) ?? null;
    return roomId === null ? ownerRoom !== null : ownerRoom !== roomId;
  });
  if (bad.length > 0) {
    throw new PlanError(
      "validation",
      "One or more documents are not available for this plan.",
      400,
      bad.map((id) => ({ path: "document_ids", message: `Not available: ${id}` })),
    );
  }
}

/**
 * Creates (or resumes) the caller's pending plan. Probes: room access →
 * document accessibility → daily chat quota, then `create_plan`, which
 * re-validates everything inside the database (input domain, membership,
 * accessibility, the one-active invariant) and either inserts the
 * `generating` stub or reuses the pending one with refreshed inputs.
 */
export async function createPlan(
  client: SupabaseClient,
  userId: string,
  body: CreatePlanBody,
): Promise<CreatedPlan> {
  if (body.room_id) {
    await assertRoomAccess(client, userId, body.room_id);
  }
  await assertDocumentsAccessible(client, body.document_ids, body.room_id ?? null);

  const usedToday = await chatTokensUsedToday(client);
  if (usedToday >= CHAT_DAILY_TOKEN_LIMIT) {
    throw new PlanError(
      "ai_quota_exceeded",
      "You have reached your daily AI limit. Try again tomorrow.",
      403,
    );
  }

  const { data, error } = await client.rpc("create_plan", {
    p_user_id: userId,
    p_room_id: body.room_id ?? null,
    p_exam_date: body.exam_date,
    p_hours_per_day: body.hours_per_day,
    p_topics: body.topics,
    p_document_ids: body.document_ids,
    p_regenerate: body.regenerate,
  });
  if (error) {
    throw mapPlanRpcError(error, "plans_failed", "Could not start the plan.");
  }
  if (!isRecord(data) || typeof data.id !== "string") {
    throw new PlanError(
      "plans_failed",
      "Could not start the plan: malformed create_plan response",
      500,
    );
  }
  return {
    id: String(data.id),
    status: (typeof data.status === "string" ? data.status : "generating") as PlanStatus,
    exam_date: String(data.exam_date),
    deduped: data.deduped === true,
    href: typeof data.href === "string" ? data.href : planHref(String(data.id)),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Own-row read (RLS + explicit `user_id` match); null when not the caller's. */
export async function getPlanRow(
  client: SupabaseClient,
  userId: string,
  planId: string,
): Promise<PlanRow | null> {
  const { data, error } = await client
    .from("study_plans")
    .select(PLAN_COLUMNS)
    .eq("id", planId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new PlanError(
      "plans_failed",
      `Could not read the plan: ${error.message}`,
      500,
    );
  }
  return (data as PlanRow | null) ?? null;
}

async function requirePlanRow(
  client: SupabaseClient,
  userId: string,
  planId: string,
): Promise<PlanRow> {
  const row = await getPlanRow(client, userId, planId);
  if (!row) {
    throw new PlanError(
      "not_found",
      "That plan does not exist or is not available.",
      404,
    );
  }
  return row;
}

/** Full detail: plan + items (mapped `date` key) + `plan_stats` progress. */
export async function getPlan(
  client: SupabaseClient,
  userId: string,
  planId: string,
): Promise<PlanDetail> {
  const row = await requirePlanRow(client, userId, planId);

  const [items, stats] = await Promise.all([
    client
      .from("plan_items")
      .select(ITEM_COLUMNS)
      .eq("plan_id", planId)
      .order("ordinal", { ascending: true }),
    planStats(client, planId),
  ]);
  if (items.error) {
    throw new PlanError(
      "plans_failed",
      `Could not read plan items: ${items.error.message}`,
      500,
    );
  }
  const itemRows = (Array.isArray(items.data) ? items.data : []) as PlanItemRow[];

  return {
    plan: mapPlanRow(row),
    items: itemRows.map(mapItemRow),
    progress: stats.progress,
    item_count: stats.item_count,
    days: stats.days,
  };
}

export type PlanListItem = {
  id: string;
  room_id: string | null;
  status: PlanStatus;
  exam_date: string;
  hours_per_day: number;
  summary: string | null;
  error_code: string | null;
  created_at: string;
  generated_at: string | null;
  href: string;
};

/** Newest-first own plans (RLS), optionally narrowed to one status. */
export async function listPlans(
  client: SupabaseClient,
  userId: string,
  status?: PlanStatus,
): Promise<PlanListItem[]> {
  let query = client
    .from("study_plans")
    .select(
      "id, room_id, status, exam_date, hours_per_day, summary, error_code, created_at, generated_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (status) {
    query = query.eq("status", status);
  }
  const { data, error } = await query;
  if (error) {
    throw new PlanError(
      "plans_failed",
      `Could not list plans: ${error.message}`,
      500,
    );
  }
  const rows = (Array.isArray(data) ? data : []) as Omit<
    PlanListItem,
    "href"
  >[];
  return rows.map((row) => ({ ...row, href: planHref(row.id) }));
}

// ---------------------------------------------------------------------------
// Generation step (POST …/step)
// ---------------------------------------------------------------------------

export type PlanStepResult = {
  status: PlanStatus;
  id: string;
  item_count: number | null;
  days: number | null;
  summary: string | null;
  model: string | null;
  provider: string;
  error_code: string | null;
  deduped: boolean;
  chat_used_today: number | null;
  chat_limit: number | null;
};

export async function failPlan(
  client: SupabaseClient,
  planId: string,
  errorCode: "ai_provider_failed" | "ai_quota_exceeded",
): Promise<void> {
  const { error } = await client.rpc("fail_plan", {
    p_plan_id: planId,
    p_error_code: errorCode,
  });
  if (error) {
    // Best-effort: the caller is already failing the request; a failed
    // fail-plan leaves the row `generating` for a retry or the UI.
    logError("[planner] fail_plan failed:", { error_message: error.message });
  }
}

/** The retrieval query for a plan: the topics and real document titles. */
export function buildPlanQuery(topics: string[], titles: string[]): string {
  const focus = topics.length > 0
    ? topics.slice(0, 8).join("; ")
    : titles.length > 0
      ? titles.slice(0, 8).join("; ")
      : "the student's subjects";
  return `Key concepts, formulas, definitions and processes for: ${focus}. Study plan material.`;
}

async function pinnedDocuments(
  client: SupabaseClient,
  documentIds: string[],
): Promise<{ id: string; title: string }[]> {
  if (documentIds.length === 0) {
    return [];
  }
  const { data, error } = await client
    .from("study_resources")
    .select("id, title")
    .in("id", documentIds);
  if (error) {
    throw new PlanError(
      "plans_failed",
      `Could not read the plan documents: ${error.message}`,
      500,
    );
  }
  return (Array.isArray(data) ? data : [])
    .filter((row): row is { id: string; title: string } => isRecord(row) && typeof row.id === "string")
    .map((row) => ({ id: row.id, title: typeof row.title === "string" ? row.title : "Untitled document" }));
}

/**
 * Advances one plan with a single provider call. Idempotent when the plan
 * is already `active` or `failed` (returns its state, no second spend);
 * an `archived` plan is 409 `plan_not_active` (read-only). Quota failure
 * fails the plan and answers 403. Malformed output — at the TS gate or
 * inside `generate_plan` — fails the plan with `ai_provider_failed` and
 * answers 502: never an `active` row built from junk.
 */
export async function runPlanStep(
  client: SupabaseClient,
  input: { userId: string; planId: string },
): Promise<PlanStepResult> {
  const plan = await requirePlanRow(client, input.userId, input.planId);
  const provider = getProvider();

  if (plan.status === "active" || plan.status === "failed") {
    const stats = await planStats(client, plan.id);
    return {
      status: plan.status,
      id: plan.id,
      item_count: stats.item_count,
      days: stats.days,
      summary: stats.summary,
      model: plan.model,
      provider: provider.name,
      error_code: stats.error_code,
      deduped: true,
      chat_used_today: null,
      chat_limit: null,
    };
  }
  if (plan.status !== "generating") {
    throw new PlanError(
      "plan_not_active",
      "That plan is read-only right now. Regenerate it to make changes.",
      409,
    );
  }

  const usedToday = await chatTokensUsedToday(client);
  if (usedToday >= CHAT_DAILY_TOKEN_LIMIT) {
    await failPlan(client, plan.id, "ai_quota_exceeded");
    throw new PlanError(
      "ai_quota_exceeded",
      "You have reached your daily AI limit. Try again tomorrow.",
      403,
    );
  }

  // Context: signals from merged tables, pinned documents, retrieval.
  const signals = await assembleSignals(client, input.userId);
  const docs = await pinnedDocuments(client, plan.document_ids);
  const docIds = docs.map((doc) => doc.id);

  let budget = applyContextBudget([]);
  let retrievalTokens = 0;
  let retrievedIds = new Set<string>();
  if (docIds.length > 0) {
    const retrieved = await retrieve(client, {
      roomId: plan.room_id,
      query: buildPlanQuery(plan.topics, docs.map((doc) => doc.title)),
      topK: 24,
      threshold: 0,
      resourceIds: docIds,
    });
    budget = applyContextBudget(retrieved.chunks);
    retrievalTokens = retrieved.usage.embedTokens;
    retrievedIds = new Set(retrieved.chunks.map((chunk) => chunk.resourceId));
  }

  const today = utcTodayIso();
  const windowDays = Math.max(1, Math.min(diffDays(today, plan.exam_date) + 1, 90));
  const resources = new Map(
    docs.map((doc) => [
      doc.id,
      { title: doc.title, href: hrefForResource(plan.room_id) },
    ]),
  );

  const messages = buildPlanMessages(
    {
      today,
      examDate: plan.exam_date,
      hoursPerDay: plan.hours_per_day,
      budgetMinutes: Math.floor(plan.hours_per_day * 60) + 15,
      days: windowDays,
      topics: plan.topics,
      signals,
      docs,
    },
    budget,
  );

  let text: string;
  let model: string;
  let completionTokens: number;
  const promptTokens = estimateTokens(
    messages.map((message) => message.content).join("\n"),
  );
  try {
    const completion = await provider.complete({
      messages,
      maxTokens: PLAN_MAX_OUTPUT_TOKENS,
    });
    text = completion.text;
    model = completion.model;
    completionTokens = Math.max(0, completion.tokens - promptTokens);
  } catch (error) {
    await failPlan(client, plan.id, "ai_provider_failed");
    throw error;
  }

  let payload: ReturnType<typeof parsePlanPayload>;
  try {
    payload = parsePlanPayload(text, {
      pinnedIds: new Set(plan.document_ids),
      resources,
      retrievedIds,
    });
  } catch (error) {
    await failPlan(client, plan.id, "ai_provider_failed");
    if (error instanceof PlanValidationError) {
      throw new PlanError(
        "ai_provider_failed",
        `The provider returned an invalid study plan: ${error.message}`,
        502,
      );
    }
    throw error;
  }

  const { data, error } = await client.rpc("generate_plan", {
    p_plan_id: plan.id,
    p_items: payload.items,
    p_summary: payload.summary,
    p_model: model,
    p_prompt_tokens: promptTokens,
    p_completion_tokens: completionTokens,
    p_retrieval_tokens: retrievalTokens,
  });
  if (error) {
    if (error.message.includes("plan_invalid")) {
      await failPlan(client, plan.id, "ai_provider_failed");
    }
    throw mapPlanRpcError(error, "plans_failed", "Could not save the generated plan.");
  }
  if (!isRecord(data) || typeof data.id !== "string") {
    throw new PlanError(
      "plans_failed",
      "Could not save the generated plan: malformed generate_plan response",
      500,
    );
  }

  const itemCount = typeof data.item_count === "number" ? data.item_count : null;
  const days = typeof data.days === "number" ? data.days : null;
  const deduped = data.deduped === true;

  if (!deduped) {
    // PR-11 retrofit: the plan owner learns the build finished. Best-effort
    // by contract — a notification failure never fails the generation.
    await notifySelf(client, {
      type: "ai_task_complete",
      userId: input.userId,
      roomId: plan.room_id,
      payload: {
        title: "Study plan ready",
        body: itemCount !== null
          ? `Your ${itemCount}-item plan across ${days ?? "?"} days is ready.`
          : "Your study plan is ready.",
      },
      dedupeKey: `ai_task_complete:${plan.id}`,
    });
  }

  return {
    status: "active",
    id: plan.id,
    item_count: itemCount,
    days,
    summary: payload.summary,
    model,
    provider: provider.name,
    error_code: null,
    deduped,
    chat_used_today:
      typeof data.chat_used_today === "number" ? data.chat_used_today : null,
    chat_limit: typeof data.chat_limit === "number" ? data.chat_limit : null,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type MarkItemResult = {
  item: { id: string; done_at: string | null };
  plan: { id: string; status: PlanStatus; progress: PlanProgress };
};

/** Checkbox toggle — idempotent; first completion timestamp is never rewritten. */
export async function markItemDone(
  client: SupabaseClient,
  itemId: string,
  done: boolean,
): Promise<MarkItemResult> {
  const { data, error } = await client.rpc("mark_plan_item", {
    p_item_id: itemId,
    p_done: done,
  });
  if (error) {
    throw mapPlanRpcError(error, "plans_failed", "Could not update that item.");
  }
  if (!isRecord(data) || !isRecord(data.item) || !isRecord(data.plan)) {
    throw new PlanError(
      "plans_failed",
      "Could not update that item: malformed mark_plan_item response",
      500,
    );
  }
  const item = data.item;
  const planRow = data.plan;
  return {
    item: {
      id: String(item.id),
      done_at: typeof item.done_at === "string" ? item.done_at : null,
    },
    plan: {
      id: String(planRow.id),
      status: String(planRow.status) as PlanStatus,
      progress: planRow.progress as PlanProgress,
    },
  };
}

export type CompleteDayResult = {
  completed: number;
  progress: PlanProgress;
};

/** "Mark all of a day done" — idempotent; only untouched items count. */
export async function completeDay(
  client: SupabaseClient,
  planId: string,
  date: string,
): Promise<CompleteDayResult> {
  const { data, error } = await client.rpc("complete_plan_day", {
    p_plan_id: planId,
    p_date: date,
  });
  if (error) {
    throw mapPlanRpcError(error, "plans_failed", "Could not complete that day.");
  }
  if (!isRecord(data) || !isRecord(data.progress)) {
    throw new PlanError(
      "plans_failed",
      "Could not complete that day: malformed complete_plan_day response",
      500,
    );
  }
  return {
    completed: Number(data.completed ?? 0),
    progress: data.progress as PlanProgress,
  };
}

export type ShiftResultResponse = {
  plan: { id: string; status: PlanStatus; exam_date: string; summary: string | null; error_code: string | null };
  moved: number;
  past_exam_date: number;
  skipped_done: number;
};

/**
 * "I missed today": computes the deterministic forward shift — every undone
 * item from `from_date` onward advances by the days `from_date` lags behind
 * today (`lib/planner/shift.ts` — the single source of truth for the
 * arithmetic) — then applies it atomically through `shift_plan`, which
 * re-validates ownership, the window, forward-only motion, and the exam cap
 * while skipping items completed concurrently.
 */
export async function shiftPlan(
  client: SupabaseClient,
  userId: string,
  planId: string,
  fromDate: string,
): Promise<ShiftResultResponse> {
  const row = await requirePlanRow(client, userId, planId);
  if (row.status !== "active") {
    throw new PlanError(
      "plan_not_active",
      "That plan is read-only right now. Regenerate it to make changes.",
      409,
    );
  }

  const items = await client
    .from("plan_items")
    .select("id, item_date, done_at")
    .eq("plan_id", planId)
    .order("ordinal", { ascending: true });
  if (items.error) {
    throw new PlanError(
      "plans_failed",
      `Could not read plan items: ${items.error.message}`,
      500,
    );
  }
  const itemRows = (Array.isArray(items.data) ? items.data : []) as {
    id: string;
    item_date: string;
    done_at: string | null;
  }[];

  const result = computeShift(itemRows, fromDate, utcTodayIso(), row.exam_date);

  let moved = 0;
  let skippedDone = 0;
  if (result.updates.length > 0) {
    const { data, error } = await client.rpc("shift_plan", {
      p_plan_id: planId,
      p_from_date: fromDate,
      p_updates: result.updates,
    });
    if (error) {
      throw mapPlanRpcError(error, "plans_failed", "Could not shift that plan.");
    }
    if (!isRecord(data)) {
      throw new PlanError(
        "plans_failed",
        "Could not shift that plan: malformed shift_plan response",
        500,
      );
    }
    moved = Number(data.moved ?? 0);
    skippedDone = Number(data.skipped_done ?? 0);
  }

  const stats = await planStats(client, planId);
  return {
    plan: {
      id: stats.id,
      status: stats.status,
      exam_date: stats.exam_date,
      summary: stats.summary,
      error_code: stats.error_code,
    },
    moved,
    past_exam_date: result.past_exam_date,
    skipped_done: skippedDone,
  };
}

export type ArchiveResult = {
  id: string;
  archived: boolean;
  deduped: boolean;
};

/** Archives any non-archived plan (also cancels a pending generation). */
export async function archivePlan(
  client: SupabaseClient,
  userId: string,
  planId: string,
): Promise<ArchiveResult> {
  // Ownership/404 first so a foreign id never reaches the RPC (same 404
  // either way, but the row check keeps the error surface in one place).
  await requirePlanRow(client, userId, planId);
  const { data, error } = await client.rpc("archive_plan", {
    p_plan_id: planId,
  });
  if (error) {
    throw mapPlanRpcError(error, "plans_failed", "Could not archive that plan.");
  }
  if (!isRecord(data)) {
    throw new PlanError(
      "plans_failed",
      "Could not archive that plan: malformed archive_plan response",
      500,
    );
  }
  return {
    id: String(data.id ?? planId),
    archived: data.archived === true,
    deduped: data.deduped === true,
  };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Download columns: `date,kind,subject,task,est_minutes,done` — the spec's
 * set, in schedule order (items arrive sorted by ordinal). Values are
 * plain: booleans as `true`/`false`, empty subject as empty cell.
 */
export function itemsToCsv(items: readonly PlanItemView[]): string {
  const header = "date,kind,subject,task,est_minutes,done";
  const rows = items.map(
    (item) =>
      [
        item.date,
        item.kind,
        item.subject ?? "",
        item.task,
        String(item.estimated_minutes),
        item.done ? "true" : "false",
      ]
        .map(csvCell)
        .join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

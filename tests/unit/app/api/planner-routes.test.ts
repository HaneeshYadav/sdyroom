import { POST as plansPOST, GET as plansGET } from "@/app/api/plans/route";
import { GET as detailGET } from "@/app/api/plans/[planId]/route";
import { POST as stepPOST } from "@/app/api/plans/[planId]/step/route";
import { POST as donePOST } from "@/app/api/plans/[planId]/items/[itemId]/done/route";
import { POST as shiftPOST } from "@/app/api/plans/[planId]/shift/route";
import { POST as completeDayPOST } from "@/app/api/plans/[planId]/complete-day/route";
import { POST as archivePOST } from "@/app/api/plans/[planId]/archive/route";
import { AiProviderError } from "@/lib/ai/provider";
import { RetrieveError } from "@/lib/ai/retrieve";
import { PlanError, type PlanDetail } from "@/lib/planner/plans";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  rateLimitedResponse,
  planSpec,
  createPlan,
  listPlans,
  getPlan,
  getPlanRow,
  runPlanStep,
  markItemDone,
  shiftPlan,
  completeDay,
  archivePlan,
  itemsToCsv,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  rateLimitedResponse: vi.fn(),
  planSpec: vi.fn(),
  createPlan: vi.fn(),
  listPlans: vi.fn(),
  getPlan: vi.fn(),
  getPlanRow: vi.fn(),
  runPlanStep: vi.fn(),
  markItemDone: vi.fn(),
  shiftPlan: vi.fn(),
  completeDay: vi.fn(),
  archivePlan: vi.fn(),
  itemsToCsv: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/check")>()),
  rateLimitedResponse,
}));
vi.mock("@/lib/rate-limit/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/keys")>()),
  planSpec,
}));
vi.mock("@/lib/planner/plans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/planner/plans")>()),
  createPlan,
  listPlans,
  getPlan,
  getPlanRow,
  runPlanStep,
  markItemDone,
  shiftPlan,
  completeDay,
  archivePlan,
  itemsToCsv,
}));

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAN = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

function request(
  path: string,
  options: { method?: string; body?: string; query?: string } = {},
): NextRequest {
  return new NextRequest(
    `http://localhost:3000${path}${options.query ?? ""}`,
    {
      method: options.method ?? "GET",
      ...(options.body === undefined ? {} : { body: options.body }),
    },
  );
}

function planContext(planId = PLAN, itemId = ITEM) {
  return { params: Promise.resolve({ planId, itemId }) };
}

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

function planError(
  code: PlanError["code"],
  status: number,
  message = "boom",
): PlanError {
  return new PlanError(code, message, status);
}

beforeEach(() => {
  // resetAllMocks (not clearAll) so a pending mockResolvedValueOnce queue can
  // never leak a 429 into the next test.
  vi.resetAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  createClient.mockResolvedValue({ auth: { getClaims } });
  rateLimitedResponse.mockResolvedValue(null);
  planSpec.mockImplementation(() => ({
    key: "plan:test",
    max: 10,
    windowSeconds: 60,
  }));
  itemsToCsv.mockImplementation(
    () => "date,kind,subject,task,est_minutes,done\n",
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/plans", () => {
  it("requires a session", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await plansPOST(
      request("/api/plans", { method: "POST", body: jsonBody({}) }),
    );
    expect(response.status).toBe(401);
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body and a body failing the schema", async () => {
    const badJson = await plansPOST(
      request("/api/plans", { method: "POST", body: "{" }),
    );
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_json",
    );

    const badSchema = await plansPOST(
      request("/api/plans", {
        method: "POST",
        body: jsonBody({ exam_date: "yesterday", hours_per_day: 99 }),
      }),
    );
    expect(badSchema.status).toBe(400);
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("answers 429 from the per-scope rate limit before any probe", async () => {
    const limited = new Response(
      jsonBody({ error: { code: "rate_limited" } }),
      { status: 429 },
    );
    rateLimitedResponse.mockResolvedValue(limited);
    const response = await plansPOST(
      request("/api/plans", {
        method: "POST",
        body: jsonBody({ exam_date: "2026-11-01", hours_per_day: 2 }),
      }),
    );
    expect(response.status).toBe(429);
    expect(planSpec).toHaveBeenCalledWith(null, USER);
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("maps service errors and returns the created plan at 201", async () => {
    createPlan.mockRejectedValueOnce(planError("room_not_member", 403));
    const denied = await plansPOST(
      request("/api/plans", {
        method: "POST",
        body: jsonBody({ exam_date: "2026-11-01", hours_per_day: 2 }),
      }),
    );
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      "room_not_member",
    );

    const created = {
      id: PLAN,
      status: "generating",
      exam_date: "2026-11-01",
      deduped: false,
      href: `/planner?plan=${PLAN}`,
    };
    createPlan.mockResolvedValueOnce(created);
    const ok = await plansPOST(
      request("/api/plans", {
        method: "POST",
        body: jsonBody({
          exam_date: "2026-11-01",
          hours_per_day: 2,
          topics: ["Vectors"],
          regenerate: true,
        }),
      }),
    );
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { plan: typeof created }).plan).toEqual(created);
    expect(createPlan).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      expect.objectContaining({ regenerate: true, topics: ["Vectors"] }),
    );
  });

  it("surfaces 409 plan_already_active", async () => {
    createPlan.mockRejectedValue(planError("plan_already_active", 409));
    const response = await plansPOST(
      request("/api/plans", {
        method: "POST",
        body: jsonBody({ exam_date: "2026-11-01", hours_per_day: 2 }),
      }),
    );
    expect(response.status).toBe(409);
  });
});

describe("GET /api/plans", () => {
  it("passes the status filter through and 400s an unknown one", async () => {
    listPlans.mockResolvedValue([]);
    const filtered = await plansGET(
      request("/api/plans", { query: "?status=active" }),
    );
    expect(filtered.status).toBe(200);
    expect(listPlans).toHaveBeenCalledWith(expect.anything(), USER, "active");

    const bad = await plansGET(
      request("/api/plans", { query: "?status=nope" }),
    );
    expect(bad.status).toBe(400);
  });

  it("requires a session", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await plansGET(request("/api/plans"));
    expect(response.status).toBe(401);
  });
});

describe("GET /api/plans/[planId]", () => {
  const detail: PlanDetail = {
    plan: {
      id: PLAN,
      room_id: null,
      status: "active",
      exam_date: "2026-11-01",
      hours_per_day: 2,
      topics: [],
      document_ids: [],
      summary: null,
      error_code: null,
      model: "mock",
      created_at: "2026-10-17T00:00:00Z",
      updated_at: "2026-10-17T00:00:00Z",
      generated_at: "2026-10-17T00:00:00Z",
      href: `/planner?plan=${PLAN}`,
    },
    items: [],
    progress: {
      done: 0,
      total: 0,
      minutes_planned_today: 0,
      minutes_done_today: 0,
      minutes_planned: 0,
      minutes_done: 0,
    },
    item_count: 0,
    days: 0,
  };

  it("404s a foreign plan and 400s a malformed id", async () => {
    getPlan.mockRejectedValue(planError("not_found", 404));
    const foreign = await detailGET(request(`/api/plans/${PLAN}`), planContext());
    expect(foreign.status).toBe(404);

    const malformed = await detailGET(
      request("/api/plans/not-a-uuid"),
      planContext("not-a-uuid"),
    );
    expect(malformed.status).toBe(400);
  });

  it("serves JSON detail and CSV via ?format=csv and the .csv suffix", async () => {
    getPlan.mockResolvedValue(detail);
    const json = await detailGET(request(`/api/plans/${PLAN}`), planContext());
    expect(json.status).toBe(200);
    expect(((await json.json()) as { plan: { id: string } }).plan.id).toBe(PLAN);

    const csv = await detailGET(
      request(`/api/plans/${PLAN}`, { query: "?format=csv" }),
      planContext(),
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get("Content-Type")).toContain("text/csv");
    expect(csv.headers.get("Content-Disposition")).toContain(
      `study-plan-${PLAN}.csv`,
    );
    expect(itemsToCsv).toHaveBeenCalled();
    expect(await csv.text()).toContain("date,kind,subject,task,est_minutes,done");

    const suffix = await detailGET(
      request(`/api/plans/${PLAN}.csv`),
      planContext(`${PLAN}.csv`),
    );
    expect(suffix.status).toBe(200);
    expect(suffix.headers.get("Content-Disposition")).toContain(".csv");
  });
});

describe("POST /api/plans/[planId]/step", () => {
  it("404s an unknown plan, 429s past the rate limit, maps provider failures", async () => {
    getPlanRow.mockResolvedValueOnce(null);
    const missing = await stepPOST(
      request(`/api/plans/${PLAN}/step`, { method: "POST" }),
      planContext(),
    );
    expect(missing.status).toBe(404);

    // The step route proves the plan exists before taking a rate-limit token.
    getPlanRow.mockResolvedValueOnce({ id: PLAN, status: "generating" });
    const limited = new Response(jsonBody({ error: { code: "rate_limited" } }), {
      status: 429,
    });
    rateLimitedResponse.mockResolvedValueOnce(limited);
    const throttled = await stepPOST(
      request(`/api/plans/${PLAN}/step`, { method: "POST" }),
      planContext(),
    );
    expect(throttled.status).toBe(429);
    expect(planSpec).toHaveBeenCalled();

    getPlanRow.mockResolvedValueOnce({ id: PLAN, status: "generating" });
    runPlanStep.mockRejectedValueOnce(new AiProviderError("provider down"));
    const provider = await stepPOST(
      request(`/api/plans/${PLAN}/step`, { method: "POST" }),
      planContext(),
    );
    expect(provider.status).toBe(502);

    getPlanRow.mockResolvedValueOnce({ id: PLAN, status: "generating" });
    runPlanStep.mockRejectedValueOnce(new RetrieveError("retrieval down"));
    const retrieve = await stepPOST(
      request(`/api/plans/${PLAN}/step`, { method: "POST" }),
      planContext(),
    );
    expect(retrieve.status).toBe(502);
  });

  it("returns the step result on success", async () => {
    getPlanRow.mockResolvedValue({ id: PLAN, status: "generating" });
    runPlanStep.mockResolvedValue({ status: "active", item_count: 27, deduped: false });
    const response = await stepPOST(
      request(`/api/plans/${PLAN}/step`, { method: "POST" }),
      planContext(),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("active");
  });
});

describe("POST /api/plans/[planId]/items/[itemId]/done", () => {
  it("validates ids and the body, then returns the service result", async () => {
    const badId = await donePOST(
      request(`/api/plans/${PLAN}/items/${ITEM}/done`, {
        method: "POST",
        body: jsonBody({ done: true }),
      }),
      planContext("not-a-uuid"),
    );
    expect(badId.status).toBe(400);

    const badBody = await donePOST(
      request(`/api/plans/${PLAN}/items/${ITEM}/done`, {
        method: "POST",
        body: jsonBody({ done: "yes" }),
      }),
      planContext(),
    );
    expect(badBody.status).toBe(400);

    markItemDone.mockResolvedValue({
      item: { id: ITEM, done_at: "2026-10-17T09:00:00Z" },
      plan: { progress: {} },
    });
    const ok = await donePOST(
      request(`/api/plans/${PLAN}/items/${ITEM}/done`, {
        method: "POST",
        body: jsonBody({ done: true }),
      }),
      planContext(),
    );
    expect(ok.status).toBe(200);
    expect(markItemDone).toHaveBeenCalledWith(expect.anything(), ITEM, true);
  });

  it("maps plan_not_active to 409", async () => {
    markItemDone.mockRejectedValue(planError("plan_not_active", 409));
    const response = await donePOST(
      request(`/api/plans/${PLAN}/items/${ITEM}/done`, {
        method: "POST",
        body: jsonBody({}),
      }),
      planContext(),
    );
    expect(response.status).toBe(409);
  });
});

describe("POST /api/plans/[planId]/shift", () => {
  it("applies the deterministic shift without any rate-limit hop", async () => {
    getPlanRow.mockResolvedValue({ id: PLAN, status: "active" });
    shiftPlan.mockResolvedValue({
      plan: { id: PLAN, status: "active", exam_date: "2026-11-01" },
      moved: 3,
      past_exam_date: 0,
      skipped_done: 0,
    });
    const response = await shiftPOST(
      request(`/api/plans/${PLAN}/shift`, {
        method: "POST",
        body: jsonBody({ from_date: "2026-10-16", mode: "shift_remaining" }),
      }),
      planContext(),
    );
    expect(response.status).toBe(200);
    expect(rateLimitedResponse).not.toHaveBeenCalled();
    expect(shiftPlan).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      PLAN,
      "2026-10-16",
    );
  });

  it("maps plan_not_active to 409", async () => {
    getPlanRow.mockResolvedValue({ id: PLAN, status: "active" });
    shiftPlan.mockRejectedValue(planError("plan_not_active", 409));
    const response = await shiftPOST(
      request(`/api/plans/${PLAN}/shift`, {
        method: "POST",
        body: jsonBody({ from_date: "2026-10-16" }),
      }),
      planContext(),
    );
    expect(response.status).toBe(409);
  });
});

describe("POST /api/plans/[planId]/complete-day", () => {
  it("marks the day done through the service", async () => {
    completeDay.mockResolvedValue({ plan: { id: PLAN }, completed: 2 });
    const response = await completeDayPOST(
      request(`/api/plans/${PLAN}/complete-day`, {
        method: "POST",
        body: jsonBody({ date: "2026-10-17" }),
      }),
      planContext(),
    );
    expect(response.status).toBe(200);
    expect(completeDay).toHaveBeenCalledWith(expect.anything(), PLAN, "2026-10-17");
  });
});

describe("POST /api/plans/[planId]/archive", () => {
  it("archives, ignoring any body, and is idempotent", async () => {
    archivePlan.mockResolvedValue({ archived: true, deduped: false });
    const response = await archivePOST(
      request(`/api/plans/${PLAN}/archive`, { method: "POST" }),
      planContext(),
    );
    expect(response.status).toBe(200);
    expect(archivePlan).toHaveBeenCalledWith(expect.anything(), USER, PLAN);
  });
});

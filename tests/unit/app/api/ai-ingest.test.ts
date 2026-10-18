import { POST } from "@/app/api/ai/ingest/[resourceId]/route";
import { AiProviderError } from "@/lib/ai/provider";
import { IngestError } from "@/lib/ai/ingest";
import { INGEST_LIMIT } from "@/lib/rate-limit/keys";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs, errorLines } from "../../helpers/log-capture";

const { createClient, getClaims, rateLimitedResponse, advance } = vi.hoisted(
  () => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    rateLimitedResponse: vi.fn(),
    advance: vi.fn(),
  }),
);

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/check")>()),
  rateLimitedResponse,
}));
vi.mock("@/lib/ai/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ingest")>()),
  advanceIngest: advance,
}));

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESOURCE = "44444444-4444-4444-8444-444444444444";

function request(body?: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/ai/ingest/" + RESOURCE, {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });
}

function context() {
  return { params: Promise.resolve({ resourceId: RESOURCE }) };
}

beforeEach(() => {
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  rateLimitedResponse.mockResolvedValue(null);
  advance.mockReset();
  createClient.mockResolvedValue({ auth: { getClaims } });
});

describe("POST /api/ai/ingest/[resourceId]", () => {
  it("rejects unauthenticated requests with 401 before anything else", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await POST(request("{}"), context());

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(rateLimitedResponse).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid resource id with 400 validation", async () => {
    const response = await POST(
      request("{}"),
      { params: Promise.resolve({ resourceId: "not-a-uuid" }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.issues).toEqual([
      { path: "resourceId", message: expect.any(String) },
    ]);
    expect(rateLimitedResponse).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it("answers an over-ceiling caller with 429 under the ingest key", async () => {
    rateLimitedResponse.mockResolvedValue(
      NextResponse.json(
        { error: { code: "rate_limited", message: "slow down" } },
        { status: 429, headers: { "Retry-After": "60" } },
      ),
    );

    const response = await POST(request("{nope"), context());

    expect(response.status).toBe(429);
    expect(rateLimitedResponse).toHaveBeenCalledWith(
      expect.anything(),
      { key: `ingest:user:${USER}`, ...INGEST_LIMIT },
      expect.any(String),
    );
    expect(INGEST_LIMIT).toEqual({ max: 30, windowSeconds: 60 });
    // The body is never read when the caller is already over the ceiling.
    expect(advance).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400 invalid_json", async () => {
    const response = await POST(request("{nope"), context());

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
    expect(advance).not.toHaveBeenCalled();
  });

  it("rejects unknown fields and unknown steps with 400 validation", async () => {
    for (const body of [
      JSON.stringify({ step: "reindex" }),
      JSON.stringify({ force: true }),
      JSON.stringify({ step: "auto", resource_id: RESOURCE }),
    ]) {
      const response = await POST(request(body), context());
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("validation");
    }
    expect(advance).not.toHaveBeenCalled();
  });

  it("treats an absent body as auto and returns the step payload untouched", async () => {
    advance.mockResolvedValue({ status: "chunking", step_done: "extract" });

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "chunking",
      step_done: "extract",
    });
    expect(advance).toHaveBeenCalledWith(expect.anything(), {
      resourceId: RESOURCE,
      step: "auto",
      userId: USER,
    });
  });

  it("passes an explicit step through", async () => {
    advance.mockResolvedValue({ status: "ready", step_done: "embed", chunks: 2 });

    const response = await POST(request(JSON.stringify({ step: "embed" })), context());

    expect(response.status).toBe(200);
    expect(advance).toHaveBeenCalledWith(expect.anything(), {
      resourceId: RESOURCE,
      step: "embed",
      userId: USER,
    });
  });

  const errorCases: Array<
    [error: unknown, status: number, code: string]
  > = [
    [new IngestError("not_member", 403), 403, "not_member"],
    [new IngestError("not_resource_owner", 403), 403, "not_resource_owner"],
    [new IngestError("not_found", 404), 404, "not_found"],
    [new IngestError("too_large", 413), 413, "too_large"],
    [new IngestError("unsupported_media_type", 415), 415, "unsupported_media_type"],
    [new IngestError("ai_quota_exceeded", 403), 403, "ai_quota_exceeded"],
    [new IngestError("ingest_failed", 500), 500, "ingest_failed"],
    [new AiProviderError("AI provider responded with status 503"), 502, "ai_provider_failed"],
  ];

  for (const [error, status, code] of errorCases) {
    it(`maps to ${status} ${code}`, async () => {
      advance.mockRejectedValue(error);

      const response = await POST(request("{}"), context());

      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBeTruthy();
    });
  }

  it("answers an unexpected failure with ingest_failed and logs it without the key material", async () => {
    advance.mockRejectedValue(new Error("something else entirely"));
    const { lines, restore } = captureLogs();

    const response = await POST(request("{}"), context());

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("ingest_failed");
    expect(errorLines(lines, "[api/ai/ingest] step failed:")).toHaveLength(1);
    restore();
  });
});

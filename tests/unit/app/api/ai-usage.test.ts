import { GET } from "@/app/api/ai/usage/route";
import { UsageError } from "@/lib/ai/usage";
import { RoomAccessError } from "@/lib/rooms/access";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, requireRoomMembership, fetchUsage } = vi.hoisted(
  () => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    requireRoomMembership: vi.fn(),
    fetchUsage: vi.fn(),
  }),
);

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomMembership,
}));
vi.mock("@/lib/ai/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/usage")>()),
  fetchAiUsageDaily: fetchUsage,
}));

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM = "11111111-1111-4111-8111-111111111111";

const SUMMARY = {
  scope: "user" as const,
  used_bytes: 2048,
  used_tokens: 96,
  limit_bytes: 52_428_800,
  day_start: "2026-10-16T00:00:00+00:00",
};

function request(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/ai/usage${query}`,
    { method: "GET" },
  );
}

const AI_ENV_KEYS = ["AI_PROVIDER", "AI_API_KEY", "AI_BASE_URL"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of AI_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  // The test asserts the demo-provider field; pin it so a developer's local
  // key cannot flip the expectation.
  process.env.AI_PROVIDER = "mock";

  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  requireRoomMembership.mockResolvedValue(undefined);
  fetchUsage.mockReset().mockResolvedValue(SUMMARY);
  createClient.mockResolvedValue({ auth: { getClaims } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of AI_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GET /api/ai/usage", () => {
  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("rejects a malformed room scope with 400 validation", async () => {
    const response = await GET(request("?room_id=nope"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(requireRoomMembership).not.toHaveBeenCalled();
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("reports personal spend for the caller with the active provider", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      used_bytes: 2048,
      used_tokens: 96,
      limit_bytes: 52_428_800,
      provider: "mock",
    });
    expect(fetchUsage).toHaveBeenCalledWith(expect.anything(), USER, null);
    expect(requireRoomMembership).not.toHaveBeenCalled();
  });

  it("proves membership before reporting a room scope", async () => {
    const response = await GET(request(`?room_id=${ROOM}`));

    expect(response.status).toBe(200);
    expect(requireRoomMembership).toHaveBeenCalledWith(expect.anything(), ROOM);
    expect(fetchUsage).toHaveBeenCalledWith(expect.anything(), USER, ROOM);
  });

  it("answers a non-member with the workspace's 404", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );

    const response = await GET(request(`?room_id=${ROOM}`));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("maps the RPC's not_found to 404", async () => {
    fetchUsage.mockRejectedValue(new UsageError("not_found", "no such room"));

    const response = await GET(request(`?room_id=${ROOM}`));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("maps an RPC auth refusal to 401", async () => {
    fetchUsage.mockRejectedValue(
      new UsageError("unauthenticated", "not authorized"),
    );

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
  });

  it("answers any other usage failure with usage_unavailable", async () => {
    fetchUsage.mockRejectedValue(new UsageError("unexpected", "malformed row"));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("usage_unavailable");
    expect(console.error).toHaveBeenCalled();
  });

  it("answers an unexpected failure with usage_unavailable", async () => {
    fetchUsage.mockRejectedValue(new Error("socket hang up"));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("usage_unavailable");
  });
});

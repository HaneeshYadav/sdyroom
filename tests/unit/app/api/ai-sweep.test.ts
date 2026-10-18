import { POST } from "@/app/api/ai/ingest/sweep/route";
import { IngestError } from "@/lib/ai/ingest";
import { SWEEP_LIMIT } from "@/lib/rate-limit/keys";
import { RoomAccessError } from "@/lib/rooms/access";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs, errorLines } from "../../helpers/log-capture";

const { createClient, getClaims, rateLimitedResponse, requireRoomMembership, sweep } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    rateLimitedResponse: vi.fn(),
    requireRoomMembership: vi.fn(),
    sweep: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/check")>()),
  rateLimitedResponse,
}));
vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomMembership,
}));
vi.mock("@/lib/ai/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ingest")>()),
  sweepIngests: sweep,
}));

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM = "11111111-1111-4111-8111-111111111111";

function request(body?: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/ai/ingest/sweep", {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });
}

beforeEach(() => {
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  rateLimitedResponse.mockResolvedValue(null);
  requireRoomMembership.mockResolvedValue(undefined);
  sweep.mockReset();
  createClient.mockResolvedValue({ auth: { getClaims } });
});

describe("POST /api/ai/ingest/sweep", () => {
  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await POST(request("{}"));

    expect(response.status).toBe(401);
    expect(rateLimitedResponse).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });

  it("answers an over-ceiling caller with 429 under the sweep key", async () => {
    rateLimitedResponse.mockResolvedValue(
      NextResponse.json(
        { error: { code: "rate_limited", message: "slow down" } },
        { status: 429 },
      ),
    );

    const response = await POST(request("{}"));

    expect(response.status).toBe(429);
    expect(rateLimitedResponse).toHaveBeenCalledWith(
      expect.anything(),
      { key: `sweep:user:${USER}`, ...SWEEP_LIMIT },
      expect.any(String),
    );
    expect(SWEEP_LIMIT).toEqual({ max: 6, windowSeconds: 60 });
    expect(sweep).not.toHaveBeenCalled();
  });

  it("rejects malformed and surprising bodies with 400", async () => {
    const malformed = await POST(request("{nope"));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("invalid_json");

    const tooMany = await POST(request(JSON.stringify({ limit: 51 })));
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error.code).toBe("validation");

    const unknownField = await POST(request(JSON.stringify({ dry_run: true })));
    expect(unknownField.status).toBe(400);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("sweeps everything the caller can see when no room is given", async () => {
    sweep.mockResolvedValue({ picked: 0, statuses: [] });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ picked: 0, statuses: [] });
    expect(requireRoomMembership).not.toHaveBeenCalled();
    expect(sweep).toHaveBeenCalledWith(expect.anything(), {
      userId: USER,
      roomId: null,
      limit: 10,
    });
  });

  it("proves membership before touching a room scope", async () => {
    sweep.mockResolvedValue({
      picked: 1,
      statuses: [{ resource_id: "44444444-4444-4444-8444-444444444444", status: "chunking" }],
    });

    const response = await POST(
      request(JSON.stringify({ room_id: ROOM, limit: 3 })),
    );

    expect(response.status).toBe(200);
    expect(requireRoomMembership).toHaveBeenCalledWith(expect.anything(), ROOM);
    expect(sweep).toHaveBeenCalledWith(expect.anything(), {
      userId: USER,
      roomId: ROOM,
      limit: 3,
    });
  });

  it("answers a non-member with the workspace's 404 and sweeps nothing", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );

    const response = await POST(request(JSON.stringify({ room_id: ROOM })));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(sweep).not.toHaveBeenCalled();
  });

  it("maps a database failure to ingest_failed", async () => {
    sweep.mockRejectedValue(new IngestError("ingest_failed", 500));

    const response = await POST(request("{}"));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("ingest_failed");
  });

  it("answers an unexpected failure with ingest_failed and logs it", async () => {
    sweep.mockRejectedValue(new Error("connection reset"));
    const { lines, restore } = captureLogs();

    const response = await POST(request("{}"));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("ingest_failed");
    expect(errorLines(lines, "[api/ai/ingest/sweep] failed:")).toHaveLength(1);
    restore();
  });
});

import { GET } from "@/app/api/metrics/route";
import { recordRequest, resetMetrics } from "@/lib/server/metrics";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => resetMetrics());

describe("GET /api/metrics", () => {
  it("serves the aggregate window with the documented envelope", async () => {
    recordRequest("/api/rooms", 200, 12);

    const response = await GET(new NextRequest("http://localhost/api/metrics"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.window_s).toBe(300);
    expect(body.instance).toBe("single");
    // The body was built inside the handler, before withLogging recorded the
    // metrics request itself — so it must contain the seeded route, not this one.
    expect(body.requests["/api/rooms"]?.count).toBe(1);
    expect(body.requests["/api/metrics"]).toBeUndefined();
  });
});

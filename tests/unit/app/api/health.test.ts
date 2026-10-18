import { GET } from "@/app/api/health/route";
import packageJson from "../../../../package.json";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("answers liveness without touching any dependency", async () => {
    // If the handler ever grew a network call, this test would hang or fail
    // in an environment with no Supabase — which is exactly the regression
    // the endpoint's contract forbids.
    const response = await GET(new NextRequest("http://localhost/api/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      version: packageJson.version,
    });
    expect(typeof body.uptime_s).toBe("number");
  });
});

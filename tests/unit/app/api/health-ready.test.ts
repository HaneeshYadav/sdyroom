import {
  GET,
  readinessDocument,
  readinessStatus,
} from "@/app/api/health/ready/route";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "pk-test";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

function request(): NextRequest {
  return new NextRequest("http://localhost/api/health/ready");
}

/** A `fetch` that answers 200 for the listed path prefixes, rejects otherwise. */
function stubFetch(downPrefixes: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (downPrefixes.some((prefix) => url.includes(prefix))) {
        throw new TypeError("fetch failed");
      }
      return new Response("{}", { status: 200 });
    }),
  );
}

describe("readiness mapping (pure)", () => {
  it("is ok only when both dependencies answered", () => {
    expect(readinessStatus({ db: true, storage: true })).toBe(200);
    expect(readinessStatus({ db: true, storage: false })).toBe(503);
    expect(readinessStatus({ db: false, storage: true })).toBe(503);
    expect(readinessStatus({ db: false, storage: false })).toBe(503);
  });

  it("names each dependency's state and stamps the check time", () => {
    expect(
      readinessDocument({ db: true, storage: false }, "2026-01-01T00:00:00.000Z"),
    ).toEqual({
      status: "degraded",
      checks: { db: "ok", storage: "down" },
      checked_at: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("GET /api/health/ready", () => {
  it("answers 200 ok when both probes respond", async () => {
    stubFetch();

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual({ db: "ok", storage: "ok" });
    expect(typeof body.checked_at).toBe("string");
  });

  it("answers 503 degraded with the failing dependency named when storage is down", async () => {
    stubFetch(["/storage/v1/"]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks).toEqual({ db: "ok", storage: "down" });
  });

  it("answers 503 degraded when configuration is missing, naming the gap in the log", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks).toEqual({ db: "down", storage: "down" });
    // Probes are skipped entirely — a missing key is already the answer.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

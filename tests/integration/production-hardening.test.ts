import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as readyGet } from "@/app/api/health/ready/route";
import { GET as roomsGet } from "@/app/api/rooms/route";
import { setLogStream, type LogLine } from "@/lib/server/log";
import packageJson from "../../package.json";
import { callApi, errorOf, readJson } from "./helpers/api";

/**
 * PR 18's production-hardening guarantees, exercised against the real local
 * stack: liveness never touches a dependency, readiness degrades loudly when
 * storage is down, every error envelope correlates with a log line through a
 * shared request id, and no credential header ever reaches the logs.
 */

const SILENT = { write() {} };
let captured: LogLine[] = [];

beforeAll(() => {
  setLogStream({
    write(chunk: string) {
      captured.push(JSON.parse(chunk) as LogLine);
    },
  });
});

afterEach(() => {
  captured = [];
  vi.unstubAllGlobals();
});

afterAll(() => setLogStream(SILENT));

describe("GET /api/health (liveness)", () => {
  it("answers 200 with the release version and never probes a dependency", async () => {
    // If this handler ever gained a network call, the test would still pass
    // locally (the stack is up) — the unit suite pins the no-dependency
    // property; here we pin the contract shape against the real handler.
    const response = await callApi(healthGet, { path: "/api/health" });
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ status: "ok", version: packageJson.version });
    expect(typeof body.uptime_s).toBe("number");
  });
});

describe("GET /api/health/ready (readiness)", () => {
  it("answers 200 ok with both dependencies up on the local stack", async () => {
    const response = await callApi(readyGet, { path: "/api/health/ready" });
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual({ db: "ok", storage: "ok" });
  });

  it("answers 503 degraded naming storage when storage is unreachable, db still ok", async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("/storage/v1/")) {
          throw new TypeError("connect ECONNREFUSED 127.0.0.1:54321");
        }
        return realFetch(input, init);
      }),
    );

    const response = await callApi(readyGet, { path: "/api/health/ready" });
    const body = await readJson(response);

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks).toEqual({ db: "ok", storage: "down" });
  });
});

describe("error envelopes correlate with server logs via request_id", () => {
  it("preserves a caller-supplied id across header, envelope and access log", async () => {
    const requestId = "integration-caller-0001";

    const response = await callApi(roomsGet, {
      path: "/api/rooms",
      headers: { "x-request-id": requestId },
    });
    const body = await readJson(response);

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(errorOf(body).request_id).toBe(requestId);

    const access = captured.find(
      (line) => line.event === "request" && line.status === 401,
    );
    expect(access?.request_id).toBe(requestId);
    expect(access?.route).toBe("/api/rooms");
  });

  it("replaces a malformed id with one minted id used consistently everywhere", async () => {
    const response = await callApi(roomsGet, {
      path: "/api/rooms",
      headers: { "x-request-id": "not a valid id!" },
    });
    const body = await readJson(response);

    const id = response.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id).not.toBe("not a valid id!");
    expect(errorOf(body).request_id).toBe(id);

    const access = captured.find(
      (line) => line.event === "request" && line.status === 401,
    );
    expect(access?.request_id).toBe(id);
  });

  it("mints an id when the caller sends none", async () => {
    const response = await callApi(roomsGet, { path: "/api/rooms" });
    const body = await readJson(response);

    const id = response.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(errorOf(body).request_id).toBe(id);
  });
});

describe("credential redaction at the log boundary", () => {
  it("never writes an authorization header value into any log line", async () => {
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.forged-payload.signature-part";

    const response = await callApi(roomsGet, {
      path: "/api/rooms",
      headers: { authorization: `Bearer ${fakeJwt}` },
    });

    // The request still behaves normally (the forged token is rejected by
    // Supabase — here we only care that it never reaches stdout).
    expect(response.status).toBe(401);
    for (const line of captured) {
      expect(JSON.stringify(line)).not.toContain(fakeJwt);
      expect(JSON.stringify(line)).not.toContain("forged-payload");
    }
  });
});

import {
  createFailureGuard,
  fetchJson,
  UpstreamError,
  withTimeout,
} from "@/lib/server/http";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("withTimeout", () => {
  it("passes a fast promise through", async () => {
    await expect(withTimeout(Promise.resolve(42), 1_000, "op")).resolves.toBe(42);
  });

  it("rejects with a timeout-kind UpstreamError when the promise is slow", async () => {
    const slow = new Promise(() => undefined);
    await expect(withTimeout(slow, 5, "storage_upload")).rejects.toMatchObject({
      name: "UpstreamError",
      kind: "timeout",
      message: "storage_upload timed out after 5ms",
    });
  });

  it("propagates the original rejection when it wins the race", async () => {
    const boom = Promise.reject(new Error("inner"));
    await expect(withTimeout(boom, 1_000, "op")).rejects.toThrow("inner");
  });
});

describe("fetchJson", () => {
  const noSleep = () => Promise.resolve();

  it("parses a 2xx body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { n: 1 })));

    await expect(
      fetchJson("https://upstream.test/x", { method: "GET" }, { timeoutMs: 1_000 }),
    ).resolves.toEqual({ n: 1 });
  });

  it("throws a status-kind error carrying the status code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(502)));

    await expect(
      fetchJson("https://upstream.test/x", { method: "GET" }, { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ name: "UpstreamError", kind: "status", status: 502 });
  });

  it("throws a transport-kind error when fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(
      fetchJson("https://upstream.test/x", { method: "GET" }, { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ name: "UpstreamError", kind: "transport" });
  });

  it("throws a body-kind error when the 2xx body is unreadable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    await expect(
      fetchJson("https://upstream.test/x", { method: "GET" }, { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ name: "UpstreamError", kind: "body" });
  });

  it("retries a transient status for an idempotent request, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchJson(
        "https://upstream.test/x",
        { method: "GET" },
        { timeoutMs: 1_000, attempts: 2, sleep: noSleep },
      ),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-idempotent POST without the explicit flag", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchJson(
        "https://upstream.test/x",
        { method: "POST", body: "{}" },
        { timeoutMs: 1_000, attempts: 2, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ kind: "status", status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a POST marked idempotent (embeddings)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchJson(
        "https://upstream.test/embeddings",
        { method: "POST", body: "{}" },
        { timeoutMs: 1_000, attempts: 2, idempotent: true, sleep: noSleep },
      ),
    ).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a status outside the transient set", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchJson(
        "https://upstream.test/x",
        { method: "GET" },
        { timeoutMs: 1_000, attempts: 2, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createFailureGuard", () => {
  function guardWithClock() {
    let nowMs = 1_000;
    const guard = createFailureGuard({
      threshold: 3,
      cooldownMs: 30_000,
      now: () => nowMs,
    });
    return { guard, advance: (ms: number) => (nowMs += ms) };
  }

  it("starts closed and admits every call", () => {
    const { guard } = guardWithClock();
    expect(guard.state).toBe("closed");
    expect(guard.allow()).toBe(true);
  });

  it("trips open after `threshold` consecutive failures", () => {
    const { guard } = guardWithClock();
    guard.recordFailure();
    guard.recordFailure();
    expect(guard.allow()).toBe(true); // still under threshold
    guard.recordFailure();
    expect(guard.state).toBe("open");
    expect(guard.allow()).toBe(false);
  });

  it("half-opens after the cooldown and admits exactly one probe", () => {
    const { guard, advance } = guardWithClock();
    for (let i = 0; i < 3; i++) guard.recordFailure();
    advance(29_999);
    expect(guard.allow()).toBe(false);
    advance(2);
    expect(guard.state).toBe("half_open");
    expect(guard.allow()).toBe(true); // the single probe
    expect(guard.allow()).toBe(false); // concurrent callers wait
  });

  it("closes again on a successful probe", () => {
    const { guard, advance } = guardWithClock();
    for (let i = 0; i < 3; i++) guard.recordFailure();
    advance(30_001);
    expect(guard.allow()).toBe(true);
    guard.recordSuccess();
    expect(guard.state).toBe("closed");
    expect(guard.allow()).toBe(true);
  });

  it("re-opens on a failed probe for another cooldown window", () => {
    const { guard, advance } = guardWithClock();
    for (let i = 0; i < 3; i++) guard.recordFailure();
    advance(30_001);
    expect(guard.allow()).toBe(true);
    guard.recordFailure();
    expect(guard.state).toBe("open");
    expect(guard.allow()).toBe(false);
  });

  it("resets the failure streak on success", () => {
    const { guard } = guardWithClock();
    guard.recordFailure();
    guard.recordFailure();
    guard.recordSuccess();
    guard.recordFailure();
    guard.recordFailure();
    expect(guard.state).toBe("closed");
  });
});

describe("UpstreamError", () => {
  it("carries kind, status and cause", () => {
    const cause = new Error("root");
    const error = new UpstreamError("boom", "status", 503, { cause });
    expect(error.name).toBe("UpstreamError");
    expect(error.kind).toBe("status");
    expect(error.status).toBe(503);
    expect(error.cause).toBe(cause);
  });
});

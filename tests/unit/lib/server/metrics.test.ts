import {
  metricsSnapshot,
  normalizeRoute,
  recordRequest,
  resetMetrics,
} from "@/lib/server/metrics";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => resetMetrics());

describe("normalizeRoute", () => {
  it("collapses uuids and bare numbers to :id", () => {
    expect(normalizeRoute("/api/rooms/11111111-1111-4111-8111-111111111111/join")).toBe(
      "/api/rooms/:id/join",
    );
    expect(normalizeRoute("/api/plans/42/step")).toBe("/api/plans/:id/step");
    expect(normalizeRoute("/api/health")).toBe("/api/health");
  });

  it("normalizes uuids case-insensitively and leaves slugs alone", () => {
    expect(normalizeRoute("/api/rooms/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")).toBe(
      "/api/rooms/:id",
    );
    expect(normalizeRoute("/api/rooms/not-a-uuid/preview")).toBe(
      "/api/rooms/not-a-uuid/preview",
    );
  });
});

describe("metrics window", () => {
  it("counts requests, groups errors by status and computes percentiles", () => {
    recordRequest("/api/rooms", 200, 10);
    recordRequest("/api/rooms", 200, 20);
    recordRequest("/api/rooms", 200, 30);
    recordRequest("/api/rooms", 404, 5);
    recordRequest("/api/rooms/11111111-1111-4111-8111-111111111111", 500, 100);

    const snapshot = metricsSnapshot();
    expect(snapshot.window_s).toBe(300);
    expect(snapshot.instance).toBe("single");

    const rooms = snapshot.requests["/api/rooms"];
    expect(rooms?.count).toBe(4);
    expect(rooms?.p50_ms).toBeGreaterThanOrEqual(10);
    expect(rooms?.p95_ms).toBeGreaterThanOrEqual(30);
    expect(rooms?.errors).toEqual({ "404": 1 });

    // The uuid-bearing path landed under the normalized key, not its own.
    expect(snapshot.requests["/api/rooms/11111111-1111-4111-8111-111111111111"]).toBeUndefined();
    expect(snapshot.requests["/api/rooms/:id"]?.errors).toEqual({ "500": 1 });
  });

  it("drops samples older than the window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      recordRequest("/api/health", 200, 1);
      vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z")); // 6 min later
      expect(metricsSnapshot().requests["/api/health"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets identifiers appear as route keys", () => {
    recordRequest("/api/rooms/11111111-1111-4111-8111-111111111111/members", 200, 3);
    const keys = Object.keys(metricsSnapshot().requests);
    expect(keys).toEqual(["/api/rooms/:id/members"]);
  });
});

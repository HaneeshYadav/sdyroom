import { describe, expect, it } from "vitest";

import {
  parsePlanJsonObject,
  parsePlanPayload,
  PlanValidationError,
  type PlanParseOptions,
} from "@/lib/planner/validate";

const DOC_A = "33333333-3333-4333-8333-333333333333";
const INVENTED = "99999999-9999-4999-8999-999999999999";

function options(overrides: Partial<PlanParseOptions> = {}): PlanParseOptions {
  return {
    pinnedIds: new Set([DOC_A]),
    resources: new Map([[DOC_A, { title: "Physics notes", href: "/resources" }]]),
    retrievedIds: new Set([DOC_A]),
    ...overrides,
  };
}

function payload(items: unknown[], summary: unknown = "A focused sprint"): string {
  return JSON.stringify({ summary, items });
}

const validItem = {
  date: "2026-10-18",
  subject: "Physics",
  task: "Read chapter 3 and take notes",
  estimated_minutes: 45,
  kind: "read",
  resource_id: DOC_A,
};

describe("parsePlanJsonObject", () => {
  it("parses plain JSON and one ```json fence", () => {
    expect(parsePlanJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parsePlanJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parsePlanJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("rejects prose around the object and outright garbage", () => {
    expect(() => parsePlanJsonObject('Here you go: {"a":1}')).toThrow(
      PlanValidationError,
    );
    expect(() => parsePlanJsonObject("not json")).toThrow(PlanValidationError);
  });
});

describe("parsePlanPayload", () => {
  it("sorts by date with stable ties and sets ordinal = index", () => {
    const parsed = parsePlanPayload(
      payload([
        { ...validItem, date: "2026-10-19", task: "Second day", resource_id: null },
        { ...validItem, date: "2026-10-18", task: "First day A", resource_id: null },
        { ...validItem, date: "2026-10-18", task: "First day B", resource_id: null },
      ]),
      options(),
    );
    expect(parsed.items.map((item) => [item.ordinal, item.item_date, item.task])).toEqual([
      [0, "2026-10-18", "First day A"],
      [1, "2026-10-18", "First day B"],
      [2, "2026-10-19", "Second day"],
    ]);
  });

  it("rebuilds citations from the server's resource map, never the model's", () => {
    const parsed = parsePlanPayload(payload([validItem]), options());
    expect(parsed.items[0].citation).toEqual({
      title: "Physics notes",
      href: "/resources",
    });
    expect(parsed.items[0].resource_id).toBe(DOC_A);
  });

  it("fails the whole plan when the model invents a resource id", () => {
    expect(() =>
      parsePlanPayload(payload([{ ...validItem, resource_id: INVENTED }]), options()),
    ).toThrow(/not built from/i);
  });

  it("strips a citation when the pinned document was deleted", () => {
    const parsed = parsePlanPayload(
      payload([validItem]),
      options({ resources: new Map(), retrievedIds: new Set([DOC_A]) }),
    );
    expect(parsed.items[0].resource_id).toBeNull();
    expect(parsed.items[0].citation).toBeNull();
  });

  it("strips a citation when the document made no retrieval window", () => {
    const parsed = parsePlanPayload(
      payload([validItem]),
      options({ retrievedIds: new Set() }),
    );
    expect(parsed.items[0].resource_id).toBeNull();
    expect(parsed.items[0].citation).toBeNull();
  });

  it("keeps citations when retrieval did not run (null)", () => {
    const parsed = parsePlanPayload(
      payload([validItem]),
      options({ retrievedIds: null }),
    );
    expect(parsed.items[0].resource_id).toBe(DOC_A);
  });

  it("normalizes empty subject and summary strings to null", () => {
    const parsed = parsePlanPayload(
      payload([{ ...validItem, subject: "  ", resource_id: null }], ""),
      options(),
    );
    expect(parsed.items[0].subject).toBeNull();
    expect(parsed.summary).toBeNull();
  });

  it("rejects schema violations: bad kind, empty task, out-of-range minutes", () => {
    for (const bad of [
      { ...validItem, kind: "nap" },
      { ...validItem, task: "   " },
      { ...validItem, estimated_minutes: 0 },
      { ...validItem, estimated_minutes: 481 },
      { ...validItem, date: "2026-10-99" },
    ]) {
      expect(() => parsePlanPayload(payload([bad]), options())).toThrow(
        PlanValidationError,
      );
    }
  });

  it("rejects an empty items array and unknown top-level fields are ignored", () => {
    expect(() => parsePlanPayload(payload([]), options())).toThrow(
      PlanValidationError,
    );
    const parsed = parsePlanPayload(
      JSON.stringify({ summary: "s", evil: true, items: [{ ...validItem, evil: true }] }),
      options(),
    );
    expect(parsed.items[0]).not.toHaveProperty("evil");
  });

  it("caps the item count at 180", () => {
    const items = Array.from({ length: 181 }, (_, index) => ({
      ...validItem,
      date: `2026-10-18`,
      task: `Task ${index}`,
      resource_id: null,
    }));
    expect(() => parsePlanPayload(payload(items), options())).toThrow(
      PlanValidationError,
    );
  });
});

import { describe, expect, it } from "vitest";

import { mockPlanCompletion } from "@/lib/ai/providers/mock";
import { buildPlanUserMessage, type PlanRequestContext } from "@/lib/ai/prompts/plan";
import { EMPTY_SIGNALS } from "@/lib/planner/signals";
import { parsePlanPayload } from "@/lib/planner/validate";

const DOC = "33333333-3333-4333-8333-333333333333";

function message(overrides: Partial<PlanRequestContext> = {}): string {
  const ctx: PlanRequestContext = {
    today: "2026-10-17",
    examDate: "2026-10-30", // 14 days → 15 with today
    hoursPerDay: 1,
    budgetMinutes: 75, // floor(60)+15
    days: 14,
    topics: ["Integration", "Vectors"],
    signals: EMPTY_SIGNALS,
    docs: [{ id: DOC, title: "Physics notes" }],
    ...overrides,
  };
  return buildPlanUserMessage(ctx, []);
}

function complete(ctx: Parameters<typeof message>[0] = {}): string {
  const output = mockPlanCompletion(message(ctx));
  if (output === null) {
    throw new Error("mock provider did not recognise the plan prompt");
  }
  return output;
}

describe("mockPlanCompletion", () => {
  it("returns null for a prompt without the plan marker", () => {
    expect(mockPlanCompletion("Generate a quiz about vectors")).toBeNull();
  });

  it("emits JSON the real validator accepts, including citation grounding", () => {
    const parsed = parsePlanPayload(complete(), {
      pinnedIds: new Set([DOC]),
      resources: new Map([[DOC, { title: "Physics notes", href: "/resources" }]]),
      retrievedIds: new Set([DOC]),
    });
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.summary).toContain("Demo mode");
    for (const item of parsed.items) {
      expect(item.item_date >= "2026-10-17").toBe(true);
      expect(item.item_date <= "2026-10-30").toBe(true);
      if (item.kind === "read") {
        expect(item.resource_id).toBe(DOC);
        expect(item.citation).toEqual({ title: "Physics notes", href: "/resources" });
      }
    }
  });

  it("spans the whole window with a weekly rest day and a mock on the last day", () => {
    const parsed = parsePlanPayload(complete(), {
      pinnedIds: new Set([DOC]),
      resources: new Map([[DOC, { title: "Physics notes", href: "/resources" }]]),
      retrievedIds: new Set([DOC]),
    });
    const dates = new Set(parsed.items.map((item) => item.item_date));
    // days=14 in the marker → 14 dated days: today .. today+13 (the exam).
    expect(dates.size).toBe(14);
    const restDays = parsed.items.filter((item) => item.kind === "rest");
    expect(restDays.length).toBe(1); // day 6; day 13 is the exam-day mock
    const lastDate = parsed.items.at(-1)!.item_date;
    expect(lastDate).toBe("2026-10-30");
    expect(
      parsed.items.filter((item) => item.item_date === lastDate && item.kind === "mock"),
    ).toHaveLength(1);
  });

  it("never exceeds the per-day budget (75 min at 1 h/day)", () => {
    const parsed = parsePlanPayload(complete(), {
      pinnedIds: new Set([DOC]),
      resources: new Map([[DOC, { title: "Physics notes", href: "/resources" }]]),
      retrievedIds: new Set([DOC]),
    });
    const perDay = new Map<string, number>();
    for (const item of parsed.items) {
      perDay.set(
        item.item_date,
        (perDay.get(item.item_date) ?? 0) + item.estimated_minutes,
      );
    }
    for (const minutes of perDay.values()) {
      expect(minutes).toBeLessThanOrEqual(75);
    }
  });

  it("cycles the named topics as subjects and sanitizes separators upstream", () => {
    const parsed = parsePlanPayload(complete({ topics: ["Integration; Vectors", "Mechanics"] }), {
      pinnedIds: new Set([DOC]),
      resources: new Map([[DOC, { title: "Physics notes", href: "/resources" }]]),
      retrievedIds: new Set([DOC]),
    });
    const subjects = new Set(
      parsed.items.map((item) => item.subject).filter((s): s is string => s !== null),
    );
    expect(subjects.has("Integration Vectors")).toBe(true);
    expect(subjects.has("Mechanics")).toBe(true);
    for (const subject of subjects) {
      expect(subject).not.toContain(";");
    }
  });
});

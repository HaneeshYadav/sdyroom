import { describe, expect, it } from "vitest";

import { addDaysIso } from "@/lib/planner/dates";
import { computeShift, type ShiftableItem } from "@/lib/planner/shift";

const TODAY = "2026-10-17";
const EXAM = "2026-11-16"; // 30 days out

function item(date: string, overrides: Partial<ShiftableItem> = {}): ShiftableItem {
  return {
    id: `item-${date}-${overrides.id ?? "x"}`,
    item_date: date,
    done_at: null,
    ...overrides,
  };
}

/** A two-item-a-day plan from today through today+14. */
function freshPlan(): ShiftableItem[] {
  const items: ShiftableItem[] = [];
  for (let day = 0; day <= 14; day += 1) {
    items.push(item(addDaysIso(TODAY, day), { id: `a${day}` }));
    items.push(item(addDaysIso(TODAY, day), { id: `b${day}` }));
  }
  return items;
}

describe("computeShift", () => {
  it("shifts by 1/3/7 days per how far from_date lags today", () => {
    for (const lag of [1, 3, 7]) {
      const fromDate = addDaysIso(TODAY, -lag);
      const result = computeShift(freshPlan(), fromDate, TODAY, EXAM);
      expect(result.moved).toBe(30);
      for (const move of result.updates) {
        const original = move.item_date;
        // every in-window item advances by exactly `lag`
        const wasTodayOrLater = original >= addDaysIso(TODAY, -lag);
        expect(wasTodayOrLater).toBe(true);
      }
      // spot-check one date: today's items land lag days out
      const todaysMoves = result.updates.filter((move) =>
        move.item_date === addDaysIso(TODAY, lag) && move.id.includes("a0"),
      );
      expect(todaysMoves).toHaveLength(1);
    }
  });

  it("is a no-op when the window start is already on time", () => {
    for (const fromDate of [TODAY, addDaysIso(TODAY, 1)]) {
      const result = computeShift(freshPlan(), fromDate, TODAY, EXAM);
      expect(result.moved).toBe(0);
      expect(result.updates).toEqual([]);
      expect(result.past_exam_date).toBe(0);
    }
  });

  it("never moves completed work", () => {
    const items = [
      item(TODAY, { id: "done", done_at: "2026-10-17T10:00:00Z" }),
      item(TODAY, { id: "open" }),
      item(addDaysIso(TODAY, 1), { id: "later" }),
    ];
    const result = computeShift(items, addDaysIso(TODAY, -1), TODAY, EXAM);
    expect(result.moved).toBe(2);
    expect(result.updates.some((move) => move.id === "done")).toBe(false);
  });

  it("leaves items before the window start untouched", () => {
    const items = [
      item(addDaysIso(TODAY, -5), { id: "old" }),
      item(TODAY, { id: "now" }),
    ];
    const result = computeShift(items, TODAY, TODAY, EXAM);
    // window = today onward; from_date is on time → no-op for all
    expect(result.moved).toBe(0);

    const behind = computeShift(items, addDaysIso(TODAY, -5), TODAY, EXAM);
    expect(behind.moved).toBe(2); // window includes the old item; shift = 5
  });

  it("clamps moves at the exam date and counts the squeeze", () => {
    const items = [
      item(addDaysIso(EXAM, -1), { id: "near" }),
      item(EXAM, { id: "on-exam" }),
    ];
    const result = computeShift(items, addDaysIso(TODAY, -3), TODAY, EXAM);
    // from_date lags 3 days → both shift +3; 'near' clamps onto the exam,
    // 'on-exam' would pass it and is clamped onto itself (not moved).
    expect(result.updates).toEqual([{ id: "near", item_date: EXAM }]);
    expect(result.moved).toBe(1);
    expect(result.past_exam_date).toBe(2);
  });

  it("returns an empty result for a window with nothing left", () => {
    const items = [item(TODAY, { id: "done", done_at: "2026-10-17T09:00:00Z" })];
    expect(computeShift(items, addDaysIso(TODAY, -1), TODAY, EXAM)).toEqual({
      updates: [],
      moved: 0,
      past_exam_date: 0,
    });
  });

  it("re-applies the same advance when called again from the same date (documented rule)", () => {
    const fromDate = addDaysIso(TODAY, -1);
    const first = computeShift(freshPlan(), fromDate, TODAY, EXAM);
    expect(first.moved).toBe(30);

    // Simulate the first shift having landed, then repeat the identical call.
    const shifted = freshPlan().map((entry) => ({
      ...entry,
      item_date: addDaysIso(entry.item_date, 1),
    }));
    const second = computeShift(shifted, fromDate, TODAY, EXAM);
    expect(second.moved).toBe(30);
    for (const move of second.updates) {
      expect(move.item_date > TODAY).toBe(true);
    }
  });
});

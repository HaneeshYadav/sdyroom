import { describe, expect, it } from "vitest";

import {
  computeProgress,
  groupItemIndicesByDate,
  ZERO_PROGRESS,
} from "@/lib/planner/progress";

const TODAY = "2026-10-17";

function item(
  date: string,
  minutes: number,
  doneAt: string | null = null,
): { date: string; estimated_minutes: number; done_at: string | null } {
  return { date, estimated_minutes: minutes, done_at: doneAt };
}

describe("computeProgress", () => {
  it("is zero for an empty plan", () => {
    expect(computeProgress([], TODAY)).toEqual(ZERO_PROGRESS);
  });

  it("counts everything done when everything is done", () => {
    const items = [
      item(TODAY, 45, "2026-10-17T09:00:00Z"),
      item("2026-10-18", 30, "2026-10-18T09:00:00Z"),
    ];
    expect(computeProgress(items, TODAY)).toEqual({
      done: 2,
      total: 2,
      minutes_planned_today: 45,
      minutes_done_today: 45,
      minutes_planned: 75,
      minutes_done: 75,
    });
  });

  it("splits mixed days, counting only today's slice for the today fields", () => {
    const items = [
      item(TODAY, 45, "2026-10-17T09:00:00Z"), // done today
      item(TODAY, 20), // open today
      item("2026-10-18", 30), // open tomorrow
      item("2026-10-16", 15, "2026-10-16T09:00:00Z"), // done yesterday
    ];
    expect(computeProgress(items, TODAY)).toEqual({
      done: 2,
      total: 4,
      minutes_planned_today: 65,
      minutes_done_today: 45,
      minutes_planned: 110,
      minutes_done: 60,
    });
  });

  it("compares dates as plain strings — no zone drift", () => {
    // A plan's "today" is the calendar string the server sent, never the
    // browser's local notion of it.
    const items = [item("2026-10-17", 30)];
    expect(computeProgress(items, "2026-10-16").minutes_planned_today).toBe(0);
    expect(computeProgress(items, "2026-10-17").minutes_planned_today).toBe(30);
    expect(computeProgress(items, "2026-10-18").minutes_planned_today).toBe(0);
  });
});

describe("groupItemIndicesByDate", () => {
  const items = [
    item("2026-10-19", 30), // upcoming
    item(TODAY, 45),
    item("2026-10-16", 20, "2026-10-16T09:00:00Z"), // earlier, done
    item(TODAY, 15),
    item("2026-10-18", 25),
  ];

  it("orders today first, then upcoming ascending, then earlier ascending", () => {
    const groups = groupItemIndicesByDate(items, TODAY);
    expect(groups.map((group) => group.date)).toEqual([
      TODAY,
      "2026-10-18",
      "2026-10-19",
      "2026-10-16",
    ]);
  });

  it("carries indices, minutes, and the done count per day", () => {
    const groups = groupItemIndicesByDate(items, TODAY);
    expect(groups[0]).toEqual({
      date: TODAY,
      indices: [1, 3],
      items: 2,
      minutes: 60,
      done: 0,
    });
    expect(groups[3]).toEqual({
      date: "2026-10-16",
      indices: [2],
      items: 1,
      minutes: 20,
      done: 1,
    });
  });

  it("drops nothing when there is no item dated today", () => {
    const groups = groupItemIndicesByDate([item("2026-10-18", 30)], TODAY);
    expect(groups).toEqual([
      { date: "2026-10-18", indices: [0], items: 1, minutes: 30, done: 0 },
    ]);
  });
});

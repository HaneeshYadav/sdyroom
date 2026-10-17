import {
  ANALYTICS_CSV_HEADER,
  analyticsDaysToCsv,
} from "@/lib/analytics/csv";
import type { PersonalDay } from "@/lib/analytics/queries";
import { describe, expect, it } from "vitest";

function day(overrides: Partial<PersonalDay> = {}): PersonalDay {
  return {
    date: "2026-10-17",
    focus_minutes: 45,
    goals_completed: 1,
    quizzes_taken: 2,
    cards_reviewed: 3,
    uploads: 1,
    quiz_correct: 4,
    quiz_total: 5,
    ...overrides,
  };
}

describe("ANALYTICS_CSV_HEADER", () => {
  it("is the spec's six export columns, in order", () => {
    expect(ANALYTICS_CSV_HEADER).toBe(
      "date,focus_minutes,goals_completed,quizzes_taken,cards_reviewed,uploads",
    );
  });
});

describe("analyticsDaysToCsv", () => {
  it("exports rows in order with exactly the six columns", () => {
    const csv = analyticsDaysToCsv([
      day({ date: "2026-10-16", focus_minutes: 0, uploads: 2 }),
      day({ date: "2026-10-17", focus_minutes: 85 }),
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(ANALYTICS_CSV_HEADER);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("2026-10-16,0,1,2,3,2");
    expect(lines[2]).toBe("2026-10-17,85,1,2,3,1");
  });

  it("never exports the chart-only quiz_correct/quiz_total fields", () => {
    const csv = analyticsDaysToCsv([day({ quiz_correct: 9, quiz_total: 9 })]);
    expect(csv).not.toContain("9,9");
    expect(csv.split("\n")[1]?.split(",")).toHaveLength(6);
  });

  it("ends every file with a trailing newline", () => {
    const csv = analyticsDaysToCsv([day()]);
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv.endsWith("\n\n")).toBe(false);
  });

  it("is header-only (still a valid download) for an empty range", () => {
    expect(analyticsDaysToCsv([])).toBe(`${ANALYTICS_CSV_HEADER}\n`);
  });

  it("keeps rows row-for-row equal to the JSON days it was given", () => {
    const days = [day({ date: "2026-10-15" }), day({ date: "2026-10-16" }), day()];
    const csv = analyticsDaysToCsv(days);
    const lines = csv.trim().split("\n").slice(1);
    expect(lines).toHaveLength(days.length);
    lines.forEach((line, index) => {
      expect(line.startsWith(`${days[index]?.date},`)).toBe(true);
    });
  });
});

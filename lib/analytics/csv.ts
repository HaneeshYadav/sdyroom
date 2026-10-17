import type { PersonalDay } from "@/lib/analytics/queries";

/**
 * CSV export for `GET /api/analytics/me.csv` (PR 16).
 *
 * Columns are the spec's set, row-for-row equal to the JSON `/me` response's
 * `days` (the extra fields the JSON days carry — `quiz_correct`/`quiz_total`,
 * for the accuracy chart — are chart inputs, not export columns; the export
 * contract is the six documented ones). Header-only is a valid file: a range
 * with no activity still downloads.
 */

export const ANALYTICS_CSV_HEADER =
  "date,focus_minutes,goals_completed,quizzes_taken,cards_reviewed,uploads";

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function analyticsDaysToCsv(days: readonly PersonalDay[]): string {
  const rows = days.map((day) =>
    [
      day.date,
      day.focus_minutes,
      day.goals_completed,
      day.quizzes_taken,
      day.cards_reviewed,
      day.uploads,
    ]
      .map(csvCell)
      .join(","),
  );
  return [ANALYTICS_CSV_HEADER, ...rows].join("\n") + "\n";
}

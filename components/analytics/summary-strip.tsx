import type { PersonalSummary } from "@/lib/analytics/queries";
import { RANGE_DAYS } from "@/lib/analytics/range";
import type { AnalyticsRange } from "@/lib/validation/analytics";

type SummaryStripProps = {
  summary: PersonalSummary;
  range: AnalyticsRange;
};

/**
 * The four summary cards (spec component list): focus time vs the previous
 * equal-length window, goals, quiz accuracy, cards due. Accuracy renders an
 * honest em dash when no question was answered in the range — never a fake
 * 0% — and cards due uses the DB's "not yet reviewed or due by end of
 * today (UTC)" definition.
 */
export function SummaryStrip({ summary, range }: SummaryStripProps) {
  const accuracyLabel =
    summary.accuracy === null
      ? "—"
      : `${Math.round(summary.accuracy * 100)}%`;
  const accuracyDetail =
    summary.accuracy === null
      ? "No quiz attempts in this range"
      : `${summary.quiz_correct} of ${summary.quiz_total} correct`;
  const weakest = [...summary.quiz_by_difficulty]
    .filter((row) => row.total > 0)
    .sort(
      (a, b) =>
        a.correct / a.total - b.correct / b.total ||
        a.difficulty.localeCompare(b.difficulty),
    )[0];
  const goalsDetail =
    summary.goals_created === 0
      ? "No goals created in this range"
      : `${summary.goals_completed} of ${summary.goals_created} created · ${summary.goals_active} active`;

  const cards: { label: string; value: string; detail: string }[] = [
    {
      label: "Focus time",
      value: `${summary.focus_minutes} min`,
      detail: `previous ${RANGE_DAYS[range]} days: ${summary.previous_focus_minutes} min`,
    },
    { label: "Goals completed", value: `${summary.goals_completed}`, detail: goalsDetail },
    {
      label: "Quiz accuracy",
      value: accuracyLabel,
      detail:
        weakest && summary.accuracy !== null
          ? `${accuracyDetail} · hardest: ${weakest.difficulty} ${Math.round((weakest.correct / weakest.total) * 100)}%`
          : accuracyDetail,
    },
    {
      label: "Cards due today",
      value: `${summary.cards_due}`,
      detail: "Not yet reviewed or due by end of today (UTC)",
    },
  ];

  return (
    <section aria-label="Range summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <article
          key={card.label}
          className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
        >
          <p className="text-sm text-muted-foreground">{card.label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{card.value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{card.detail}</p>
        </article>
      ))}
    </section>
  );
}

import type { RoomSummary } from "@/lib/analytics/queries";

type RoomStatsProps = {
  summary: RoomSummary;
};

/**
 * Room summary cards (spec component `room-stats`): aggregate counts only —
 * no member names, aliases or ids ever reach this component, which is what
 * the room payload is allowed to contain.
 */
export function RoomStats({ summary }: RoomStatsProps) {
  const accuracyDetail =
    summary.quiz_total > 0
      ? `${Math.round((summary.quiz_correct / summary.quiz_total) * 100)}% correct`
      : "No quiz attempts yet";
  const goalsDetail =
    summary.goals_created > 0
      ? `${summary.goals_completed} of ${summary.goals_created} created`
      : "No goals created in this range";

  const cards: { label: string; value: string; detail: string }[] = [
    {
      label: "Focus time",
      value: `${summary.focus_minutes_total} min`,
      detail: "Attributed room sessions in this range",
    },
    {
      label: "Active members",
      value: `${summary.active_members}`,
      detail: "Members who studied, reviewed, uploaded or set goals",
    },
    { label: "Goals completed", value: `${summary.goals_completed}`, detail: goalsDetail },
    {
      label: "Quiz attempts",
      value: `${summary.quiz_attempts}`,
      detail: accuracyDetail,
    },
    {
      label: "Uploads",
      value: `${summary.uploads}`,
      detail: "Files added to the room in this range",
    },
  ];

  return (
    <section aria-label="Room summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

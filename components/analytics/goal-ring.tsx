import { percentOf } from "./chart-utils";

type GoalRingProps = {
  completed: number;
  created: number;
};

/**
 * Goal completion ring (spec component `goal-ring`): `role="progressbar"`
 * with clamped min/max/now (completed above created never reports >100%).
 * The ring's stroke dash is presentation only — the adjacent text and the
 * progressbar value carry the same honest numbers.
 */
export function GoalRing({ completed, created }: GoalRingProps) {
  const rawFraction = created > 0 ? completed / created : 0;
  const clamped = Math.min(Math.max(rawFraction, 0), 1);
  const percent = percentOf(clamped);
  const maxValue = created > 0 ? created : 100;
  const value = Math.min(Math.max(completed, 0), maxValue);
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const dash = clamped * circumference;

  return (
    <section aria-labelledby="goal-ring-heading" className="flex flex-col">
      <h2 id="goal-ring-heading" className="mb-2 text-base font-semibold">
        Goal completion
      </h2>
      <div className="flex items-center gap-4">
        <svg
          viewBox="0 0 80 80"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={maxValue}
          aria-valuenow={value}
          aria-label="Goals completed out of goals created in this range"
          className="size-20 shrink-0 -rotate-90"
        >
          <title>Goal completion</title>
          <circle
            cx={40}
            cy={40}
            r={radius}
            fill="none"
            className="stroke-muted"
            strokeWidth={8}
          />
          <circle
            cx={40}
            cy={40}
            r={radius}
            fill="none"
            className="stroke-primary"
            strokeWidth={8}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference - dash}`}
          />
        </svg>
        <div>
          <p className="text-2xl font-semibold tabular-nums">
            {created === 0 ? "—" : `${percent}%`}
          </p>
          <p className="text-sm text-muted-foreground">
            {created === 0
              ? "No goals created in this range"
              : `${completed} of ${created} goals completed`}
          </p>
        </div>
      </div>
    </section>
  );
}

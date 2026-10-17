import { AccuracyChart } from "@/components/analytics/accuracy-chart";
import { FocusChart } from "@/components/analytics/focus-chart";
import { GoalRing } from "@/components/analytics/goal-ring";
import { RangeSwitcher } from "@/components/analytics/range-switcher";
import { SummaryStrip } from "@/components/analytics/summary-strip";
import { RANGE_DAYS, parseRangeParam, rangeWindow } from "@/lib/analytics/range";
import {
  AnalyticsError,
  fetchPersonalAnalytics,
} from "@/lib/analytics/queries";
import { utcTodayIso } from "@/lib/planner/dates";
import { createClient } from "@/lib/supabase/server";
import type { AnalyticsRange } from "@/lib/validation/analytics";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Analytics · SdyRoom",
};

// Session-gated page: the panel is the caller's own data.
export const instant = false;

type AnalyticsPageProps = {
  searchParams: Promise<{ range?: string }>;
};

const DEFAULT_RANGE: AnalyticsRange = "7d";

function hasAnyActivity(days: readonly { focus_minutes: number; goals_completed: number; quizzes_taken: number; cards_reviewed: number; uploads: number }[]): boolean {
  return days.some(
    (day) =>
      day.focus_minutes > 0 ||
      day.goals_completed > 0 ||
      day.quizzes_taken > 0 ||
      day.cards_reviewed > 0 ||
      day.uploads > 0,
  );
}

/**
 * `/analytics` — the caller's study dashboard: four summary cards, the
 * focus bar chart, the quiz-accuracy line, the goal-completion ring, and the
 * plan-vs-actual comparison, over `?range=7d|30d|90d` (default 7d; an
 * explicit but unknown value is a 404, the API answers 400 for the same URL
 * on `/api/analytics/me`).
 *
 * The whole panel is one `analytics_me` round trip; charts each ship an
 * sr-only data table plus a collapsed `<details>` copy; the visible footer
 * states the UTC bucketing so a late-night session is never read as a bug.
 */
export default async function AnalyticsPage({ searchParams }: AnalyticsPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const viewerId = data?.claims?.sub;

  if (!viewerId) {
    redirect("/auth/login");
  }

  const params = await searchParams;
  const parsedRange =
    params.range === undefined
      ? { ok: true as const, range: DEFAULT_RANGE }
      : parseRangeParam(params.range);
  if (!parsedRange.ok) {
    notFound();
  }
  const range = parsedRange.range;

  let analytics;
  try {
    analytics = await fetchPersonalAnalytics(supabase, {
      userId: viewerId,
      days: RANGE_DAYS[range],
    });
  } catch (error) {
    if (error instanceof AnalyticsError && error.status === 401) {
      redirect("/auth/login");
    }
    throw error;
  }

  const rangeDates = rangeWindow(range, utcTodayIso());
  const plan = analytics.plan;

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">Analytics</h1>
            <p className="text-sm text-muted-foreground">
              Your focus time, goals, quizzes and reviews across the last{" "}
              {RANGE_DAYS[range]} days.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <RangeSwitcher current={range} />
            <Link
              href={`/api/analytics/me.csv?range=${range}`}
              download
              className="text-sm underline"
            >
              Download CSV
            </Link>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Calendar dates are UTC — a session starting 23:30 UTC counts on that
          UTC day. Window: {rangeDates.start} to {rangeDates.end} (last{" "}
          {RANGE_DAYS[range]} days, including today).
        </p>
        <p className="text-xs text-muted-foreground">
          Current streak: {analytics.summary.current_streak_days} day
          {analytics.summary.current_streak_days === 1 ? "" : "s"} · longest:{" "}
          {analytics.summary.longest_streak_days} day
          {analytics.summary.longest_streak_days === 1 ? "" : "s"} · active
          days: {analytics.summary.study_days} of {RANGE_DAYS[range]}
        </p>
      </header>

      {!hasAnyActivity(analytics.days) && (
        <p className="rounded-lg border bg-muted/50 p-4 text-sm" role="note">
          No study activity in this range yet — start a focus timer to build
          your streak.
        </p>
      )}

      <SummaryStrip summary={analytics.summary} range={range} />

      {/* Additive beyond the spec's component list: the planner already
          exposes its own plan-vs-actual numbers, so this block only echoes
          them for the range — plan=null means no active plan at all. */}
      <section
        aria-labelledby="plan-actual-heading"
        className="rounded-xl border p-5 text-sm"
      >
        <h2 id="plan-actual-heading" className="text-base font-semibold">
          Plan vs actual
        </h2>
        {plan === null ? (
          <p className="mt-1 text-muted-foreground">
            No active plan yet —{" "}
            <Link href="/planner" className="underline">
              create one
            </Link>{" "}
            to compare planned minutes with your focus time.
          </p>
        ) : (
          <p className="mt-1 text-muted-foreground">
            {plan.planned_minutes} min planned · {plan.items_total} task
            {plan.items_total === 1 ? "" : "s"} ({plan.items_done} done
            {plan.items_overdue > 0 ? ` · ${plan.items_overdue} overdue` : ""}
            ) · {analytics.summary.focus_minutes} min focused in this window ·{" "}
            <Link href="/planner" className="underline">
              open planner
            </Link>
          </p>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <FocusChart days={analytics.days} />
        <div className="flex flex-col gap-6">
          <AccuracyChart days={analytics.days} />
          <GoalRing
            completed={analytics.summary.goals_completed}
            created={analytics.summary.goals_created}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Your analytics are personal — only you can see them. They are computed
        from your own sessions, goals, quizzes and reviews; nothing here is
        estimated or fabricated.
      </p>
    </section>
  );
}

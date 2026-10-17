import { DataTable, type DataTableColumn } from "@/components/analytics/data-table";
import { FocusChart } from "@/components/analytics/focus-chart";
import { RangeSwitcher } from "@/components/analytics/range-switcher";
import { RoomStats } from "@/components/analytics/room-stats";
import { RANGE_DAYS, parseRangeParam, rangeWindow } from "@/lib/analytics/range";
import {
  AnalyticsError,
  fetchRoomAnalytics,
  type RoomDay,
} from "@/lib/analytics/queries";
import { utcTodayIso } from "@/lib/planner/dates";
import { createClient } from "@/lib/supabase/server";
import type { AnalyticsRange } from "@/lib/validation/analytics";
import { roomIdSchema } from "@/lib/validation/rooms";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Room analytics · SdyRoom",
};

// Session-gated page: authorization is proven inside the RPC per request.
export const instant = false;

type RoomAnalyticsPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
};

const DEFAULT_RANGE: AnalyticsRange = "7d";

const DAY_COLUMNS: DataTableColumn<RoomDay>[] = [
  { key: "date", header: "Date", render: (row) => row.date },
  { key: "focus", header: "Focus minutes", render: (row) => `${row.focus_minutes}` },
  {
    key: "members",
    header: "Active members",
    render: (row) => `${row.active_members}`,
  },
  {
    key: "quizzes",
    header: "Quiz attempts",
    render: (row) => `${row.quiz_attempts}`,
  },
];

function hasAnyActivity(days: readonly RoomDay[]): boolean {
  return days.some(
    (day) =>
      day.focus_minutes > 0 ||
      day.active_members > 0 ||
      day.quiz_attempts > 0,
  );
}

/**
 * `/rooms/[id]/analytics` — the room's aggregate panel (owner or moderator).
 * The privilege check lives inside `analytics_room`: a plain member, a
 * non-member and a missing room all arrive here as the same 404, so the URL
 * never reveals which rooms exist or who can moderate them. The payload is
 * counts and minutes only — this page renders no member-identifying data.
 */
export default async function RoomAnalyticsPage({ params, searchParams }: RoomAnalyticsPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) {
    redirect("/auth/login");
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    notFound();
  }

  const search = await searchParams;
  const parsedRange =
    search.range === undefined
      ? { ok: true as const, range: DEFAULT_RANGE }
      : parseRangeParam(search.range);
  if (!parsedRange.ok) {
    notFound();
  }
  const range = parsedRange.range;

  let analytics;
  try {
    analytics = await fetchRoomAnalytics(supabase, {
      roomId: parsedRoomId.data,
      days: RANGE_DAYS[range],
    });
  } catch (error) {
    if (error instanceof AnalyticsError) {
      if (error.status === 401) {
        redirect("/auth/login");
      }
      if (error.status === 404) {
        // Member, non-member or vanished room — identical by design.
        notFound();
      }
    }
    throw error;
  }

  const rangeDates = rangeWindow(range, utcTodayIso());

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">Room analytics</h1>
            <p className="text-sm text-muted-foreground">
              Aggregate activity for this room across the last{" "}
              {RANGE_DAYS[range]} days — counts and minutes only.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <RangeSwitcher current={range} />
            <Link
              href={`/rooms/${parsedRoomId.data}`}
              className="text-sm underline"
            >
              Back to room
            </Link>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Calendar dates are UTC — a session starting 23:30 UTC counts on that
          UTC day. Window: {rangeDates.start} to {rangeDates.end} (last{" "}
          {RANGE_DAYS[range]} days, including today).
        </p>
      </header>

      {!hasAnyActivity(analytics.days) && (
        <p className="rounded-lg border bg-muted/50 p-4 text-sm" role="note">
          No activity in this range yet — focus sessions, quizzes, reviews and
          uploads in this window will appear here.
        </p>
      )}

      <RoomStats summary={analytics.summary} />

      <FocusChart days={analytics.days} />

      <section aria-labelledby="room-daily-heading" className="flex flex-col">
        <h2 id="room-daily-heading" className="mb-2 text-base font-semibold">
          Daily activity
        </h2>
        <div className="overflow-x-auto">
          <DataTable
            caption="Room activity by day"
            columns={DAY_COLUMNS}
            rows={analytics.days}
            rowKey={(row) => row.date}
          />
        </div>
      </section>
    </section>
  );
}

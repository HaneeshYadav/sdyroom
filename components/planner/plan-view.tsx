"use client";

import { PlanActions } from "@/components/planner/plan-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  computeProgress,
  groupItemIndicesByDate,
} from "@/lib/planner/progress";
import { parseIsoDate } from "@/lib/planner/dates";
import type { PlanDetail, PlanItemView } from "@/lib/planner/plans";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** "Monday, October 19" — weekday included so a missed day is obvious. */
function dayHeading(date: string): string {
  const epoch = parseIsoDate(date);
  if (epoch === null) {
    return date;
  }
  // Locale pinned: the default locale differs between the Node render and
  // the browser, which would hydrate-mismatch the heading text.
  return new Date(epoch).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-2 text-lg font-semibold first:mt-0">{children}</h2>
  );
}

function DayBlock({
  date,
  indices,
  items,
  today,
  busyItemId,
  onToggle,
}: {
  date: string;
  indices: number[];
  items: PlanItemView[];
  today: string;
  busyItemId: string | null;
  onToggle: (item: PlanItemView) => void;
}) {
  const headingId = `plan-day-${date}`;
  const minutes = indices.reduce(
    (sum, index) => sum + items[index].estimated_minutes,
    0,
  );
  const done = indices.filter((index) => items[index].done).length;

  return (
    <div className="flex flex-col gap-2">
      <h3
        id={headingId}
        className="flex flex-wrap items-baseline gap-2 text-sm font-semibold"
      >
        {dayHeading(date)}
        {date === today && <Badge variant="secondary">Today</Badge>}
        <span className="font-normal text-muted-foreground">
          {minutes} min · {done}/{indices.length} done
        </span>
      </h3>
      <fieldset aria-labelledby={headingId} className="flex flex-col gap-2">
        <legend className="sr-only">{dayHeading(date)}</legend>
        {indices.map((index) => {
          const item = items[index];
          return (
            <div
              key={item.id}
              className="flex flex-wrap items-start gap-3 rounded-lg border p-3"
            >
              <input
                type="checkbox"
                id={item.id}
                checked={item.done}
                disabled={busyItemId === item.id}
                onChange={() => onToggle(item)}
                className="mt-1 size-4"
              />
              <label
                htmlFor={item.id}
                className={
                  item.done
                    ? "flex-1 cursor-pointer text-sm text-muted-foreground line-through"
                    : "flex-1 cursor-pointer text-sm font-medium"
                }
              >
                {item.task}
              </label>
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{item.kind}</Badge>
                {item.subject && <span>{item.subject}</span>}
                <span>{item.estimated_minutes} min</span>
              </span>
              {item.citation && (
                <Link
                  href={item.citation.href}
                  className="w-full text-xs underline sm:w-auto"
                >
                  {item.citation.title}
                </Link>
              )}
            </div>
          );
        })}
      </fieldset>
    </div>
  );
}

/**
 * The active plan: checklist grouped by day (today first), live progress, and
 * the deterministic adjustments. Checkbox toggles are optimistic — the next
 * progress numbers come from `computeProgress` immediately and revert with an
 * alert if the API refuses.
 */
export function PlanView({
  detail,
  today,
  demoMode,
}: {
  detail: PlanDetail;
  today: string;
  demoMode: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState<PlanItemView[]>(detail.items);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const progress = computeProgress(items, today);
  const groups = groupItemIndicesByDate(items, today);
  const todayGroups = groups.filter((group) => group.date === today);
  const upcomingGroups = groups.filter((group) => group.date > today);
  const earlierGroups = groups.filter((group) => group.date < today);
  const percent =
    progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

  const toggle = async (item: PlanItemView) => {
    const nextDone = !item.done;
    const previousDoneAt = item.done_at;
    setBusyItemId(item.id);
    setError(null);
    setItems((current) =>
      current.map((entry) =>
        entry.id === item.id
          ? {
              ...entry,
              done: nextDone,
              done_at: nextDone ? new Date().toISOString() : null,
            }
          : entry,
      ),
    );

    try {
      const response = await fetch(
        `/api/plans/${detail.plan.id}/items/${item.id}/done`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ done: nextDone }),
        },
      );

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as {
        item?: { done_at?: string | null };
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        setItems((current) =>
          current.map((entry) =>
            entry.id === item.id
              ? { ...entry, done: previousDoneAt !== null, done_at: previousDoneAt }
              : entry,
          ),
        );
        setError(
          body?.error?.message ?? "That task could not be updated. Try again.",
        );
        return;
      }

      const serverDoneAt =
        typeof body?.item?.done_at === "string" ? body.item.done_at : null;
      setItems((current) =>
        current.map((entry) =>
          entry.id === item.id
            ? { ...entry, done: serverDoneAt !== null, done_at: serverDoneAt }
            : entry,
        ),
      );
    } catch {
      setItems((current) =>
        current.map((entry) =>
          entry.id === item.id
            ? { ...entry, done: previousDoneAt !== null, done_at: previousDoneAt }
            : entry,
        ),
      );
      setError("Could not reach the server. Your change was not saved.");
    } finally {
      setBusyItemId(null);
    }
  };

  return (
    <section className="flex flex-col gap-4" aria-label="Your study plan">
      <header className="flex flex-col gap-2 rounded-xl border p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Current plan</h2>
          <Badge variant="outline">Exam {detail.plan.exam_date}</Badge>
          <Badge variant="outline">{detail.plan.hours_per_day} h/day</Badge>
          {demoMode && <Badge variant="secondary">Demo mode</Badge>}
        </div>
        {detail.plan.summary && (
          <p className="text-sm text-muted-foreground">{detail.plan.summary}</p>
        )}
        {detail.plan.topics.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {detail.plan.topics.map((topic) => (
              <li key={topic}>
                <Badge variant="secondary">{topic}</Badge>
              </li>
            ))}
          </ul>
        )}
        {detail.plan.document_ids.length === 0 && (
          <p className="text-sm text-muted-foreground" role="note">
            No indexed documents are attached to this plan — tasks are
            topic-based. Regenerate from a room with indexed files to ground
            reading tasks in citations.
          </p>
        )}
        {detail.plan.room_id && (
          <Link
            href={`/rooms/${detail.plan.room_id}`}
            className="text-sm underline"
          >
            Open the linked room
          </Link>
        )}
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.max(progress.total, 1)}
          aria-valuenow={progress.done}
          aria-label="Study plan progress"
          className="h-2 overflow-hidden rounded bg-accent"
        >
          <div
            className="h-full rounded bg-primary transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {progress.done} of {progress.total} items done · {progress.minutes_done}
          /{progress.minutes_planned} min
          {progress.minutes_planned_today > 0 &&
            ` · today ${progress.minutes_done_today}/${progress.minutes_planned_today} min`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/api/plans/${detail.plan.id}?format=csv`}
            className="text-xs underline"
            download
          >
            Download CSV
          </Link>
          <span className="text-xs text-muted-foreground">
            {detail.days} days · {detail.item_count} tasks
          </span>
        </div>
      </header>

      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}

      <PlanActions
        plan={detail.plan}
        items={items}
        today={today}
        onItemsApplied={setItems}
        onError={setError}
      />

      <div className="flex flex-col gap-6">
        {todayGroups.length > 0 && (
          <div className="flex flex-col gap-4">
            <SectionHeading>Today</SectionHeading>
            {todayGroups.map((group) => (
              <DayBlock
                key={group.date}
                date={group.date}
                indices={group.indices}
                items={items}
                today={today}
                busyItemId={busyItemId}
                onToggle={(item) => void toggle(item)}
              />
            ))}
          </div>
        )}
        {upcomingGroups.length > 0 && (
          <div className="flex flex-col gap-4">
            <SectionHeading>Upcoming</SectionHeading>
            {upcomingGroups.map((group) => (
              <DayBlock
                key={group.date}
                date={group.date}
                indices={group.indices}
                items={items}
                today={today}
                busyItemId={busyItemId}
                onToggle={(item) => void toggle(item)}
              />
            ))}
          </div>
        )}
        {earlierGroups.length > 0 && (
          <div className="flex flex-col gap-4">
            <SectionHeading>Earlier</SectionHeading>
            <p className="text-sm text-muted-foreground">
              Days you fell behind on — still here until you do them or shift
              the plan forward.
            </p>
            {earlierGroups.map((group) => (
              <DayBlock
                key={group.date}
                date={group.date}
                indices={group.indices}
                items={items}
                today={today}
                busyItemId={busyItemId}
                onToggle={(item) => void toggle(item)}
              />
            ))}
          </div>
        )}
        {groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            This plan has no tasks yet.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * In-flight generation: the server holds a `generating` row; this panel runs
 * the one step that calls the provider, then refreshes — the page swaps to
 * the active checklist or the failure notice with no further clicks.
 */
export function PlanGeneratingPanel({ planId }: { planId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/plans/${planId}/step`, {
          method: "POST",
        });
        if (cancelled) {
          return;
        }
        if (response.status === 401) {
          router.push("/auth/login");
          return;
        }
      } catch {
        if (!cancelled) {
          setError("Could not reach the server while building the plan.");
        }
      }
      if (!cancelled) {
        router.refresh();
        setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [planId, router]);

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border p-5"
      role="status"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold">Building your plan…</h2>
      <p className="text-sm text-muted-foreground">
        The planner is drafting day-by-day tasks from your inputs. This takes a
        moment.
      </p>
      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => router.refresh()}
        >
          {busy ? "Working…" : "Check again"}
        </Button>
      </div>
    </section>
  );
}

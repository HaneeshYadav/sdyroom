"use client";

import { Button } from "@/components/ui/button";
import { addDaysIso, compareIso } from "@/lib/planner/dates";
import type { PlanItemView } from "@/lib/planner/plans";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The deterministic adjustments — mark a whole day done, shift what remains
 * ("I missed today"), regenerate, archive. None of these touch the AI; they
 * are plain API writes against the plan's own rows.
 *
 * Shift and archive are two-step confirms: a shift rewrites dates (a repeat
 * from the same window start applies the same advance again), and an archive
 * is the end of the plan. After either write the item list is re-fetched from
 * the API — the server's dates always win over any local guess.
 */
export function PlanActions({
  plan,
  items,
  today,
  onItemsApplied,
  onError,
}: {
  plan: { id: string; exam_date: string };
  items: PlanItemView[];
  today: string;
  onItemsApplied: (items: PlanItemView[]) => void;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"day" | "shift" | "archive" | null>(null);
  const [confirmShift, setConfirmShift] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const undone = items.filter((item) => !item.done);
  const todayUndone = undone.filter((item) => item.date === today).length;
  const hasUndone = undone.length > 0;

  /**
   * "I missed today" posts the earliest date whose work is still outstanding,
   * or yesterday when everything through today is done — either way the
   * window's lag behind today is exactly the days the student missed, and a
   * fresh plan shifts by one day.
   */
  const shiftFromDate = (): string => {
    const earliest = undone.reduce(
      (min, item) => (compareIso(item.date, min) < 0 ? item.date : min),
      undone[0]?.date ?? today,
    );
    return compareIso(earliest, today) < 0 ? earliest : addDaysIso(today, -1);
  };

  const refetchItems = async (): Promise<PlanItemView[] | null> => {
    const response = await fetch(`/api/plans/${plan.id}`);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json().catch(() => null)) as {
      items?: PlanItemView[];
    } | null;
    return Array.isArray(body?.items) ? body.items : null;
  };

  const readError = async (response: Response): Promise<string | null> => {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return body?.error?.message ?? null;
  };

  const handleUnauthorized = (status: number): boolean => {
    if (status === 401) {
      router.push("/auth/login");
      return true;
    }
    return false;
  };

  const completeToday = async () => {
    setBusy("day");
    onError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/plans/${plan.id}/complete-day`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: today }),
      });
      if (handleUnauthorized(response.status)) {
        return;
      }
      if (!response.ok) {
        onError(
          (await readError(response)) ??
            "Could not mark today done. Please try again.",
        );
        return;
      }
      const refreshed = await refetchItems();
      if (refreshed) {
        onItemsApplied(refreshed);
      }
      setNotice(`Marked all of today's tasks done (${todayUndone}).`);
    } catch {
      onError("Could not reach the server. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const shiftRemaining = async () => {
    setBusy("shift");
    onError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/plans/${plan.id}/shift`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_date: shiftFromDate(),
          mode: "shift_remaining",
        }),
      });
      if (handleUnauthorized(response.status)) {
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        moved?: number;
        past_exam_date?: number;
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        onError(
          body?.error?.message ??
            "Could not shift your plan. Please try again.",
        );
        return;
      }
      const moved = body?.moved ?? 0;
      const clamped = body?.past_exam_date ?? 0;
      const refreshed = await refetchItems();
      if (refreshed) {
        onItemsApplied(refreshed);
      }
      setNotice(
        moved === 0
          ? "Nothing to shift — your plan is already on time."
          : `Moved ${moved} remaining ${moved === 1 ? "task" : "tasks"} forward${
              clamped > 0
                ? ` (${clamped} landed on the exam date — the plan had to squeeze)`
                : ""
            }.`,
      );
    } catch {
      onError("Could not reach the server. Please try again.");
    } finally {
      setBusy(null);
      setConfirmShift(false);
    }
  };

  const archivePlan = async () => {
    setBusy("archive");
    onError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/plans/${plan.id}/archive`, {
        method: "POST",
      });
      if (handleUnauthorized(response.status)) {
        return;
      }
      if (!response.ok) {
        onError(
          (await readError(response)) ??
            "Could not archive that plan. Please try again.",
        );
        return;
      }
      router.push("/planner");
      router.refresh();
    } catch {
      onError("Could not reach the server. Please try again.");
    } finally {
      setBusy(null);
      setConfirmArchive(false);
    }
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border p-5"
      aria-label="Plan actions"
    >
      <h2 className="text-lg font-semibold">Adjust</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null || todayUndone === 0}
          onClick={() => void completeToday()}
        >
          {busy === "day" ? "Saving…" : "Mark all of today done"}
        </Button>
        {confirmShift ? (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => void shiftRemaining()}
            >
              {busy === "shift" ? "Shifting…" : "Confirm shift"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirmShift(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null || !hasUndone}
            onClick={() => setConfirmShift(true)}
          >
            I missed today — shift remaining
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => router.push("/planner?regenerate=1")}
        >
          Regenerate
        </Button>
        {confirmArchive ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void archivePlan()}
            >
              {busy === "archive" ? "Archiving…" : "Confirm archive"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirmArchive(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setConfirmArchive(true)}
          >
            Archive
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Shifting moves every not-yet-done task forward by the days you missed
        and never past your exam date. Done tasks never move.
      </p>
      {notice && (
        <p className="text-sm" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

/**
 * Progress arithmetic for plan items (PR 15).
 *
 * Mirrors `plan_progress` in 0020_study_plans.sql exactly — the database
 * function is the server authority the API returns, and this module is the
 * client's copy for optimistic rendering (an optimistic checkbox needs the
 * next numbers *before* the round-trip lands). The integration suite
 * asserts the two agree on the same rows; unit tests pin each shape here.
 *
 * All comparisons are calendar-date strings in UTC, same as the database's
 * `current_date` — a plan's "today" never shifts with the machine's zone.
 */

export type PlanProgress = {
  done: number;
  total: number;
  minutes_planned_today: number;
  minutes_done_today: number;
  minutes_planned: number;
  minutes_done: number;
};

export type ProgressItem = {
  /** Calendar date of the item — the view's `date` key. */
  date: string;
  estimated_minutes: number;
  done_at: string | null;
};

export const ZERO_PROGRESS: PlanProgress = {
  done: 0,
  total: 0,
  minutes_planned_today: 0,
  minutes_done_today: 0,
  minutes_planned: 0,
  minutes_done: 0,
};

/** Totals + today's slice for a set of items (`today` = `YYYY-MM-DD`). */
export function computeProgress(
  items: readonly ProgressItem[],
  today: string,
): PlanProgress {
  let done = 0;
  let minutesPlannedToday = 0;
  let minutesDoneToday = 0;
  let minutesPlanned = 0;
  let minutesDone = 0;

  for (const item of items) {
    const isDone = item.done_at !== null;
    if (isDone) {
      done += 1;
      minutesDone += item.estimated_minutes;
    }
    minutesPlanned += item.estimated_minutes;
    if (item.date === today) {
      minutesPlannedToday += item.estimated_minutes;
      if (isDone) {
        minutesDoneToday += item.estimated_minutes;
      }
    }
  }

  return {
    done,
    total: items.length,
    minutes_planned_today: minutesPlannedToday,
    minutes_done_today: minutesDoneToday,
    minutes_planned: minutesPlanned,
    minutes_done: minutesDone,
  };
}

export type DayGroup = {
  date: string;
  /** Item positions (in the input array) that fall on this date. */
  indices: number[];
  items: number;
  minutes: number;
  done: number;
};

/**
 * Groups item *indices* by date for the checklist view, ordered today
 * first, then upcoming days ascending, then earlier (missed) days
 * ascending — the spec's "Today section first", with nothing dropped: a
 * day the student fell behind on stays visible at the end rather than
 * vanishing from the schedule.
 */
export function groupItemIndicesByDate(
  items: readonly {
    date: string;
    estimated_minutes?: number;
    done_at?: string | null;
  }[],
  today: string,
): DayGroup[] {
  const byDate = new Map<string, { indices: number[]; minutes: number; done: number }>();
  items.forEach((item, index) => {
    const entry = byDate.get(item.date) ?? { indices: [], minutes: 0, done: 0 };
    entry.indices.push(index);
    entry.minutes += item.estimated_minutes ?? 0;
    if (item.done_at != null) {
      entry.done += 1;
    }
    byDate.set(item.date, entry);
  });

  const dates = [...byDate.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const todayIndex = dates.indexOf(today);
  const ordered: string[] = [];
  if (todayIndex >= 0) {
    ordered.push(today);
  }
  const upcoming = dates.filter((date) => date > today);
  const earlier = dates.filter((date) => date < today);
  ordered.push(...upcoming, ...earlier);

  return ordered.map((date) => {
    const entry = byDate.get(date)!;
    return {
      date,
      indices: entry.indices,
      items: entry.indices.length,
      minutes: entry.minutes,
      done: entry.done,
    };
  });
}

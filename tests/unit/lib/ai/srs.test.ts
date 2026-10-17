import {
  nextReviewState,
  SRS_AGAIN_DELAY_MINUTES,
  SRS_INTERVALS_DAYS,
  SRS_MIN_EASE,
} from "@/lib/ai/srs";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-01-15T12:00:00.000Z");

describe("nextReviewState", () => {
  it("sends an 'again' card back to the start of the schedule", () => {
    const state = nextReviewState(
      { streak: 3, ease: 2.5, intervalDays: 7 },
      "again",
      NOW,
    );
    expect(state.streak).toBe(0);
    expect(state.intervalDays).toBe(0);
    expect(state.ease).toBeCloseTo(2.3, 3);
    expect(state.nextReviewAt.getTime()).toBe(
      NOW.getTime() + SRS_AGAIN_DELAY_MINUTES * 60_000,
    );
    expect(state.nextReviewAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("floors ease at SRS_MIN_EASE on repeated 'again'", () => {
    const state = nextReviewState(
      { streak: 0, ease: SRS_MIN_EASE, intervalDays: 0 },
      "again",
      NOW,
    );
    expect(state.ease).toBe(SRS_MIN_EASE);
  });

  it("walks 'got_it' up the documented interval table, capped at 30 days", () => {
    let previous: Parameters<typeof nextReviewState>[0] = null;
    const intervals: number[] = [];
    for (let round = 0; round < 7; round += 1) {
      previous = nextReviewState(previous, "got_it", NOW);
      intervals.push(previous.intervalDays);
    }
    expect(intervals).toEqual([
      SRS_INTERVALS_DAYS[0],
      SRS_INTERVALS_DAYS[1],
      SRS_INTERVALS_DAYS[2],
      SRS_INTERVALS_DAYS[3],
      SRS_INTERVALS_DAYS[4],
      SRS_INTERVALS_DAYS[4],
      SRS_INTERVALS_DAYS[4],
    ]);
    expect(previous?.streak).toBe(7);
  });

  it("keeps ease unchanged on 'got_it'", () => {
    const state = nextReviewState(
      { streak: 1, ease: 2.1, intervalDays: 1 },
      "got_it",
      NOW,
    );
    expect(state.ease).toBe(2.1);
    expect(state.streak).toBe(2);
    expect(state.intervalDays).toBe(3);
    expect(state.nextReviewAt.getTime()).toBe(
      NOW.getTime() + 3 * 86_400_000,
    );
    expect(state.nextReviewAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("treats a never-reviewed card as streak 0 with default ease", () => {
    const state = nextReviewState(null, "got_it", NOW);
    expect(state.streak).toBe(1);
    expect(state.ease).toBe(2.5);
    expect(state.intervalDays).toBe(1);
  });
});

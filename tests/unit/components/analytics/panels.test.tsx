// @vitest-environment jsdom
import { RoomStats } from "@/components/analytics/room-stats";
import { SummaryStrip } from "@/components/analytics/summary-strip";
import type { PersonalSummary, RoomSummary } from "@/lib/analytics/queries";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

function summary(overrides: Partial<PersonalSummary> = {}): PersonalSummary {
  return {
    focus_minutes: 85,
    goals_completed: 2,
    goals_created: 3,
    goals_active: 1,
    quiz_correct: 8,
    quiz_total: 10,
    accuracy: 0.8,
    quiz_by_difficulty: [
      { difficulty: "easy", correct: 3, total: 3 },
      { difficulty: "hard", correct: 2, total: 5 },
      { difficulty: "medium", correct: 3, total: 4 },
    ],
    cards_due: 9,
    uploads: 4,
    upload_bytes: 4096,
    sessions: 2,
    avg_session_minutes: 43,
    previous_focus_minutes: 40,
    study_days: 5,
    current_streak_days: 2,
    longest_streak_days: 4,
    ...overrides,
  };
}

describe("SummaryStrip", () => {
  it("renders the four spec cards with their details", () => {
    render(<SummaryStrip summary={summary()} range="7d" />);

    expect(screen.getByText("Focus time")).toBeInTheDocument();
    expect(screen.getByText("85 min")).toBeInTheDocument();
    expect(screen.getByText("previous 7 days: 40 min")).toBeInTheDocument();

    expect(screen.getByText("Goals completed")).toBeInTheDocument();
    expect(screen.getByText("2 of 3 created · 1 active")).toBeInTheDocument();

    expect(screen.getByText("Quiz accuracy")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("8 of 10 correct · hardest: hard 40%")).toBeInTheDocument();

    expect(screen.getByText("Cards due today")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(
      screen.getByText("Not yet reviewed or due by end of today (UTC)"),
    ).toBeInTheDocument();
  });

  it("keeps accuracy honest — an em dash, never a fake 0%", () => {
    render(
      <SummaryStrip
        summary={summary({ accuracy: null, quiz_correct: 0, quiz_total: 0, quiz_by_difficulty: [] })}
        range="30d"
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(
      screen.getByText("No quiz attempts in this range"),
    ).toBeInTheDocument();
  });

  it("says so plainly when no goal was created in the range", () => {
    render(
      <SummaryStrip
        summary={summary({ goals_created: 0, goals_completed: 0, goals_active: 0 })}
        range="90d"
      />,
    );
    expect(screen.getByText("No goals created in this range")).toBeInTheDocument();
  });

  it("uses the range's own length in the previous-window detail", () => {
    render(<SummaryStrip summary={summary()} range="90d" />);
    expect(screen.getByText("previous 90 days: 40 min")).toBeInTheDocument();
  });
});

function roomSummary(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    focus_minutes_total: 85,
    active_members: 2,
    goals_created: 3,
    goals_completed: 2,
    quiz_attempts: 12,
    quiz_correct: 8,
    quiz_total: 10,
    uploads: 4,
    ...overrides,
  };
}

describe("RoomStats", () => {
  it("renders the five aggregate cards, counts only", () => {
    render(<RoomStats summary={roomSummary()} />);
    const region = screen.getByRole("region", { name: "Room summary" });
    const cards = within(region).getAllByRole("article");
    expect(cards).toHaveLength(5);

    expect(within(cards[0] as HTMLElement).getByText("85 min")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(
      within(cards[2] as HTMLElement).getByText("2 of 3 created"),
    ).toBeInTheDocument();
    expect(
      within(cards[3] as HTMLElement).getByText("80% correct"),
    ).toBeInTheDocument();
    expect(within(cards[4] as HTMLElement).getByText("4")).toBeInTheDocument();
  });

  it("stays honest with zero quiz attempts", () => {
    render(
      <RoomStats
        summary={roomSummary({ quiz_attempts: 0, quiz_correct: 0, quiz_total: 0 })}
      />,
    );
    expect(screen.getByText("No quiz attempts yet")).toBeInTheDocument();
  });
});

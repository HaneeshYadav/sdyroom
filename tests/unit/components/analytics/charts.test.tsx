// @vitest-environment jsdom
import { AccuracyChart } from "@/components/analytics/accuracy-chart";
import { DataTable } from "@/components/analytics/data-table";
import { FocusChart } from "@/components/analytics/focus-chart";
import { GoalRing } from "@/components/analytics/goal-ring";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

function focusDays(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, "0")}`,
    focus_minutes: index, // day 1 is 0 — a zero bar, still in the table
  }));
}

describe("FocusChart", () => {
  it("renders an honest note instead of a chart when everything is zero", () => {
    const { container } = render(<FocusChart days={focusDays(7).map((d) => ({ ...d, focus_minutes: 0 }))} />);
    expect(
      screen.getByText("No focus sessions in this range yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelectorAll("rect")).toHaveLength(0);
  });

  it("renders the same note for an empty range without crashing", () => {
    render(<FocusChart days={[]} />);
    expect(
      screen.getByText("No focus sessions in this range yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("ships role=img with a title/desc, focusable bars and both tables", () => {
    const days = focusDays(7);
    const { container } = render(<FocusChart days={days} />);

    expect(
      screen.getByRole("heading", { name: "Focus minutes per day" }),
    ).toBeInTheDocument();
    const image = screen.getByRole("img", { name: /Daily focus minutes/i });
    expect(image).toBeInTheDocument();
    expect(image.querySelector("desc")?.textContent).toContain("Peak");

    // Bars: only the six days with focus time > 0 get a rect (day 1 is 0).
    const bars = container.querySelectorAll("rect[aria-label]");
    expect(bars).toHaveLength(6);
    expect(bars[0]?.getAttribute("aria-label")).toBe("2026-10-02: 1 minutes");
    expect(bars[0]?.getAttribute("tabindex")).toBe("0");
    expect(bars[0]?.querySelector("title")?.textContent).toContain("min");

    // Text fallback: sr-only table + the collapsed <details> copy.
    const tables = screen.getAllByRole("table");
    expect(tables).toHaveLength(2);
    expect(within(tables[0] as HTMLElement).getAllByRole("row")).toHaveLength(
      days.length + 1,
    );
    expect(
      screen.getByText("Show focus minutes data table"),
    ).toBeInTheDocument();
  });

  it("keeps the data table row-for-row with 90 days", () => {
    const days = focusDays(90);
    render(<FocusChart days={days} />);
    const tables = screen.getAllByRole("table");
    expect(
      within(tables[0] as HTMLElement).getAllByRole("row"),
    ).toHaveLength(91);
  });
});

describe("AccuracyChart", () => {
  const quiet = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, "0")}`,
    quiz_correct: 0,
    quiz_total: 0,
  }));

  it("shows an honest note when no question was attempted", () => {
    render(<AccuracyChart days={quiet} />);
    expect(
      screen.getByText("No quiz attempts in this range yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("breaks the line on days with no attempts and marks them as gaps", () => {
    const days = [
      { date: "2026-10-13", quiz_correct: 2, quiz_total: 2 },
      { date: "2026-10-14", quiz_correct: 0, quiz_total: 0 },
      { date: "2026-10-15", quiz_correct: 1, quiz_total: 2 },
      { date: "2026-10-16", quiz_correct: 3, quiz_total: 4 },
    ];
    const { container } = render(<AccuracyChart days={days} />);

    expect(screen.getByRole("img", { name: /Daily quiz accuracy/i })).toBeInTheDocument();
    expect(container.querySelectorAll("polyline")).toHaveLength(2);

    const points = container.querySelectorAll("circle[aria-label]");
    expect(points).toHaveLength(3);
    expect(points[0]?.getAttribute("aria-label")).toBe(
      "2026-10-13: 100% (2 of 2 correct)",
    );
    expect(points[1]?.getAttribute("aria-label")).toBe(
      "2026-10-15: 50% (1 of 2 correct)",
    );

    const tables = screen.getAllByRole("table");
    expect(within(tables[0] as HTMLElement).getByText("—")).toBeInTheDocument();
    expect(
      screen.getByText("Show quiz accuracy data table"),
    ).toBeInTheDocument();
  });
});

describe("GoalRing", () => {
  it("exposes progressbar semantics with the honest fraction", () => {
    render(<GoalRing completed={3} created={4} />);
    const bar = screen.getByRole("progressbar", { name: /goals/i });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("3 of 4 goals completed")).toBeInTheDocument();
  });

  it("clamps completed above created instead of reporting >100%", () => {
    render(<GoalRing completed={5} created={4} />);
    const bar = screen.getByRole("progressbar", { name: /goals/i });
    expect(bar).toHaveAttribute("aria-valuemax", "4");
    expect(bar).toHaveAttribute("aria-valuenow", "4");
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("5 of 4 goals completed")).toBeInTheDocument();
  });

  it("stays honest when no goal was created", () => {
    render(<GoalRing completed={0} created={0} />);
    const bar = screen.getByRole("progressbar", { name: /goals/i });
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(
      screen.getByText("No goals created in this range"),
    ).toBeInTheDocument();
  });
});

describe("DataTable", () => {
  it("renders a caption and scoped column headers", () => {
    render(
      <DataTable
        caption="Daily focus minutes"
        columns={[
          { key: "date", header: "Date", render: (row) => row.date },
          { key: "v", header: "Value", render: (row) => `${row.v}` },
        ]}
        rows={[{ date: "2026-10-17", v: 5 }]}
        rowKey={(row) => row.date}
      />,
    );
    expect(screen.getByText("Daily focus minutes")).toBeInTheDocument();
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((node) => node.getAttribute("scope"))).toEqual([
      "col",
      "col",
    ]);
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });
});

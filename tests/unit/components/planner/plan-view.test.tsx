// @vitest-environment jsdom
import { PlanGeneratingPanel, PlanView } from "@/components/planner/plan-view";
import type { PlanDetail, PlanItemView } from "@/lib/planner/plans";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, refresh, fetchMock } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-10-17";
const YESTERDAY = "2026-10-16";
const TOMORROW = "2026-10-18";

function item(overrides: Partial<PlanItemView> = {}): PlanItemView {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ordinal: 0,
    date: TODAY,
    subject: "Mechanics",
    task: "Read projectile motion notes",
    estimated_minutes: 25,
    kind: "read",
    resource_id: null,
    citation: null,
    done: false,
    done_at: null,
    ...overrides,
  };
}

function detail(items: PlanItemView[], documentIds: string[] = []): PlanDetail {
  const done = items.filter((entry) => entry.done).length;
  return {
    plan: {
      id: PLAN_ID,
      room_id: null,
      status: "active",
      exam_date: "2026-10-30",
      hours_per_day: 2,
      topics: ["Vectors"],
      document_ids: documentIds,
      summary: "A two-week sprint.",
      error_code: null,
      model: "mock",
      created_at: "2026-10-17T00:00:00Z",
      updated_at: "2026-10-17T00:00:00Z",
      generated_at: "2026-10-17T00:00:00Z",
      href: `/planner?plan=${PLAN_ID}`,
    },
    items,
    progress: {
      done,
      total: items.length,
      minutes_planned_today: 70,
      minutes_done_today: items
        .filter((entry) => entry.date === TODAY && entry.done)
        .reduce((sum, entry) => sum + entry.estimated_minutes, 0),
      minutes_planned: items.reduce((sum, entry) => sum + entry.estimated_minutes, 0),
      minutes_done: items
        .filter((entry) => entry.done)
        .reduce((sum, entry) => sum + entry.estimated_minutes, 0),
    },
    item_count: items.length,
    days: new Set(items.map((entry) => entry.date)).size,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const sample = [
  item({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", date: YESTERDAY, task: "Yesterday's reading", done: true, done_at: "2026-10-16T18:00:00Z" }),
  item({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ordinal: 1, date: TODAY, task: "Today's practice set", kind: "practice", estimated_minutes: 45 }),
  item({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ordinal: 2, date: TOMORROW, task: "Tomorrow's review", kind: "review", estimated_minutes: 20, citation: { title: "Mechanics notes", href: "/rooms/x/resources/y" } }),
];

describe("PlanView", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("groups items under Today, Upcoming and Earlier with live progress", () => {
    render(<PlanView detail={detail(sample)} today={TODAY} demoMode={false} />);

    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Upcoming" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Earlier" })).toBeInTheDocument();

    const bar = screen.getByRole("progressbar", { name: "Study plan progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "3");
    expect(screen.getByText(/1 of 3 items done · 25\/90 min/)).toBeInTheDocument();

    expect(screen.getByText("A two-week sprint.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
      "href",
      `/api/plans/${PLAN_ID}?format=csv`,
    );
    expect(screen.getByRole("link", { name: "Mechanics notes" })).toHaveAttribute(
      "href",
      "/rooms/x/resources/y",
    );
    // The current day's block carries a Today badge inside its h3 (the
    // heading locale is pinned to en-US so SSR and the browser agree).
    expect(
      screen.getByRole("heading", { level: 3, name: /October 17/ }),
    ).toHaveTextContent("Today");
  });

  it("says out loud when the plan has no documents", () => {
    render(<PlanView detail={detail(sample)} today={TODAY} demoMode={false} />);
    expect(screen.getByRole("note")).toHaveTextContent(
      "No indexed documents are attached to this plan",
    );
  });

  it("toggles a checkbox optimistically and applies the server's done_at", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        item: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", done_at: "2026-10-17T09:00:00Z" },
      }),
    );

    render(<PlanView detail={detail(sample)} today={TODAY} demoMode={false} />);
    const checkbox = screen.getByRole("checkbox", {
      name: /Today's practice set/,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);

    // Optimistic: the box flips before the response lands.
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText(/2 of 3 items done/)).toBeInTheDocument();

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/plans/${PLAN_ID}/items/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/done`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ done: true }),
        }),
      ),
    );
    expect(screen.getByText(/2 of 3 items done/)).toBeInTheDocument();
  });

  it("reverts the toggle and alerts when the server refuses", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "plan_not_active", message: "This plan is no longer active." },
      }),
    );

    render(<PlanView detail={detail(sample)} today={TODAY} demoMode={false} />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Today's practice set/ }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This plan is no longer active.",
    );
    expect(
      (screen.getByRole("checkbox", { name: /Today's practice set/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(screen.getByText(/1 of 3 items done/)).toBeInTheDocument();
  });

  it("sends the viewer to login when the session is gone", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: {} }));

    render(<PlanView detail={detail(sample)} today={TODAY} demoMode={false} />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Today's practice set/ }),
    );

    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/login"));
  });

  it("reports a lost connection without changing the checklist", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    render(<PlanView detail={detail(sample)} today={TODAY} demoMode={false} />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Today's practice set/ }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the server. Your change was not saved.",
    );
    expect(
      (screen.getByRole("checkbox", { name: /Today's practice set/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });
});

describe("PlanGeneratingPanel", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("runs the one step on mount, then refreshes", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "active" }));

    render(<PlanGeneratingPanel planId={PLAN_ID} />);

    expect(screen.getByText("Working…")).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/plans/${PLAN_ID}/step`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("surfaces an unreachable server", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    render(<PlanGeneratingPanel planId={PLAN_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the server while building the plan.",
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

// @vitest-environment jsdom
import { PlanActions } from "@/components/planner/plan-actions";
import type { PlanItemView } from "@/lib/planner/plans";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const behindItems = [
  item({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", date: YESTERDAY, task: "Missed reading" }),
  item({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ordinal: 1, date: TODAY, task: "Today's practice", kind: "practice", estimated_minutes: 45 }),
  item({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ordinal: 2, date: TOMORROW, task: "Tomorrow's review", kind: "review", estimated_minutes: 20, done: true, done_at: "2026-10-17T08:00:00Z" }),
];

const plan = { id: PLAN_ID, exam_date: "2026-10-30" };

describe("PlanActions", () => {
  let onItemsApplied: Mock<(items: PlanItemView[]) => void>;
  let onError: Mock<(message: string | null) => void>;

  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    fetchMock.mockReset();
    onItemsApplied = vi.fn();
    onError = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderActions(items: PlanItemView[]) {
    render(
      <PlanActions
        plan={plan}
        items={items}
        today={TODAY}
        onItemsApplied={onItemsApplied}
        onError={onError}
      />,
    );
  }

  it("marks all of today's undone items done, then applies the refetched list", async () => {
    const refreshed = behindItems.map((entry) =>
      entry.date === TODAY ? { ...entry, done: true, done_at: "2026-10-17T12:00:00Z" } : entry,
    );
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { completed: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: refreshed }));

    renderActions(behindItems);
    fireEvent.click(screen.getByRole("button", { name: "Mark all of today done" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `/api/plans/${PLAN_ID}/complete-day`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ date: TODAY }),
        }),
      ),
    );
    await waitFor(() =>
      expect(onItemsApplied).toHaveBeenCalledWith(refreshed),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Marked all of today's tasks done (1).",
    );
  });

  it("stays disabled when nothing from today is outstanding", () => {
    renderActions(
      behindItems.map((entry) =>
        entry.date === TODAY ? { ...entry, done: true, done_at: "2026-10-17T08:00:00Z" } : entry,
      ),
    );
    expect(
      screen.getByRole("button", { name: "Mark all of today done" }),
    ).toBeDisabled();
  });

  it("shifts remaining from the earliest outstanding day after a two-step confirm", async () => {
    const shifted = [
      item({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ordinal: 0, date: TODAY, task: "Missed reading" }),
      item({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ordinal: 1, date: TOMORROW, task: "Today's practice", kind: "practice", estimated_minutes: 45 }),
    ];
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { moved: 2, past_exam_date: 0, skipped_done: 1 }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { items: shifted }));

    renderActions(behindItems);
    fireEvent.click(
      screen.getByRole("button", { name: "I missed today — shift remaining" }),
    );
    // Two-step: nothing is posted until the confirm.
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm shift" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `/api/plans/${PLAN_ID}/shift`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ from_date: YESTERDAY, mode: "shift_remaining" }),
        }),
      ),
    );
    await waitFor(() => expect(onItemsApplied).toHaveBeenCalledWith(shifted));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Moved 2 remaining tasks forward.",
    );
  });

  it("shifts a fresh plan by yesterday", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { moved: 1, past_exam_date: 0, skipped_done: 0 }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { items: behindItems }));

    renderActions(behindItems);
    fireEvent.click(
      screen.getByRole("button", { name: "I missed today — shift remaining" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm shift" }));

    await waitFor(() => {
      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as { body: string }).body,
      ) as { from_date: string };
      expect(body.from_date).toBe(YESTERDAY);
    });
  });

  it("reports an already-on-time no-op", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { moved: 0, past_exam_date: 0, skipped_done: 0 }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { items: behindItems }));

    renderActions(
      // Everything through today is done; only tomorrow's work remains.
      behindItems.map((entry) =>
        entry.date === TOMORROW
          ? { ...entry, done: false, done_at: null }
          : { ...entry, done: true, done_at: "2026-10-17T08:00:00Z" },
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "I missed today — shift remaining" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm shift" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Nothing to shift — your plan is already on time.",
    );
  });

  it("cancels a shift without posting", () => {
    renderActions(behindItems);
    fireEvent.click(
      screen.getByRole("button", { name: "I missed today — shift remaining" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "I missed today — shift remaining" }),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed shift through onError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "plan_not_active", message: "This plan is no longer active." },
      }),
    );

    renderActions(behindItems);
    fireEvent.click(
      screen.getByRole("button", { name: "I missed today — shift remaining" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm shift" }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("This plan is no longer active."),
    );
    // The server dates won: no local list mutation was applied.
    expect(onItemsApplied).not.toHaveBeenCalled();
  });

  it("archives after a two-step confirm and leaves the planner", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { archived: true }));

    renderActions(behindItems);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm archive" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/plans/${PLAN_ID}/archive`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/planner"));
    expect(refresh).toHaveBeenCalled();
  });

  it("regenerates without touching the AI from here", () => {
    renderActions(behindItems);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(push).toHaveBeenCalledWith("/planner?regenerate=1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the viewer to login when the session is gone", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: {} }));

    renderActions(behindItems);
    fireEvent.click(
      screen.getByRole("button", { name: "I missed today — shift remaining" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm shift" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/login"));
  });
});

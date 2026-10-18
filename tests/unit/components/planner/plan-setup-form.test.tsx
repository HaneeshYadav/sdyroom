// @vitest-environment jsdom
import { PlanSetupForm } from "@/components/planner/plan-setup-form";
import { PLAN_DOCUMENTS_MAX } from "@/lib/validation/planner";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, replace, refresh, fetchMock } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, refresh }),
}));

const ROOM = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const TODAY = "2026-10-17";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function submitForm() {
  const form = document.querySelector("form");
  expect(form).not.toBeNull();
  fireEvent.submit(form!);
}

function readyDoc(id: string, title: string) {
  return { resource_id: id, title, status: "ready", chunks: 3 };
}

describe("PlanSetupForm", () => {
  beforeEach(() => {
    push.mockReset();
    replace.mockReset();
    refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the fresh and regenerate variants", () => {
    const { rerender } = render(
      <PlanSetupForm
        rooms={[{ id: ROOM, name: "Physics" }]}
        documents={[]}
        initialRoomId={ROOM}
        today={TODAY}
        demoMode={false}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Build your plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Generate plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /That room has no indexed documents yet — tasks will be topic-based\./,
      ),
    ).toBeInTheDocument();

    rerender(
      <PlanSetupForm
        rooms={[{ id: ROOM, name: "Physics" }]}
        documents={[]}
        initialRoomId={ROOM}
        today={TODAY}
        demoMode={false}
        regenerate
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Regenerate your plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Regenerate plan" }),
    ).toBeInTheDocument();
  });

  it("refuses an out-of-window exam date before touching the server", () => {
    render(
      <PlanSetupForm
        rooms={[]}
        documents={[]}
        initialRoomId={null}
        today={TODAY}
        demoMode={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Exam date"), {
      target: { value: "2026-10-17" }, // today: the window starts tomorrow
    });
    submitForm();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Exam date must be between tomorrow and the next 180 days.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates the plan, drives the step, and refreshes", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(201, {
          plan: { id: PLAN_ID, status: "generating", deduped: false },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { status: "active" }));

    render(
      <PlanSetupForm
        rooms={[{ id: ROOM, name: "Physics" }]}
        documents={[
          readyDoc("33333333-3333-4333-8333-333333333333", "Mechanics notes"),
          { resource_id: "44444444-4444-4444-8444-444444444444", title: "Indexing", status: "indexing", chunks: 0 },
        ]}
        initialRoomId={ROOM}
        today={TODAY}
        demoMode={false}
      />,
    );
    expect(
      screen.getByText(/Grounded in 1 ready document from that room\./),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Exam date"), {
      target: { value: "2026-11-01" },
    });
    fireEvent.change(screen.getByLabelText("Hours you can study per day"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("Topic"), {
      target: { value: "Vectors" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add topic" }));
    submitForm();

    await waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/plans",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            exam_date: "2026-11-01",
            hours_per_day: 3,
            topics: ["Vectors"],
            room_id: ROOM,
            document_ids: ["33333333-3333-4333-8333-333333333333"],
          }),
        }),
      ),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        `/api/plans/${PLAN_ID}/step`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("caps pinned documents at the API limit", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(201, { plan: { id: PLAN_ID, status: "generating" } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const documents = Array.from({ length: PLAN_DOCUMENTS_MAX + 2 }, (_, index) =>
      readyDoc(
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        `Doc ${index}`,
      ),
    );

    render(
      <PlanSetupForm
        rooms={[{ id: ROOM, name: "Physics" }]}
        documents={documents}
        initialRoomId={ROOM}
        today={TODAY}
        demoMode={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Exam date"), {
      target: { value: "2026-11-01" },
    });
    submitForm();

    await waitFor(() => {
      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as { body: string }).body,
      ) as { document_ids: string[] };
      expect(body.document_ids).toHaveLength(PLAN_DOCUMENTS_MAX);
    });
  });

  it("round-trips a room change through ?room= and keeps regenerate", () => {
    render(
      <PlanSetupForm
        rooms={[
          { id: ROOM, name: "Physics" },
          { id: "55555555-5555-4555-8555-555555555555", name: "Chemistry" },
        ]}
        documents={[]}
        initialRoomId={null}
        today={TODAY}
        demoMode={false}
        regenerate
      />,
    );

    fireEvent.change(screen.getByLabelText("Ground in a room (optional)"), {
      target: { value: ROOM },
    });
    expect(replace).toHaveBeenCalledWith(`/planner?room=${ROOM}&regenerate=1`);

    fireEvent.change(screen.getByLabelText("Ground in a room (optional)"), {
      target: { value: "" },
    });
    expect(replace).toHaveBeenLastCalledWith("/planner?regenerate=1");
  });

  it("adds, dedupes and removes topics", () => {
    render(
      <PlanSetupForm
        rooms={[]}
        documents={[]}
        initialRoomId={null}
        today={TODAY}
        demoMode={false}
      />,
    );
    const draft = screen.getByLabelText("Topic");
    fireEvent.change(draft, { target: { value: "Vectors" } });
    fireEvent.click(screen.getByRole("button", { name: "Add topic" }));
    fireEvent.change(draft, { target: { value: "Vectors" } });
    fireEvent.click(screen.getByRole("button", { name: "Add topic" }));
    expect(screen.getByText("1/25")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove topic Vectors" }));
    expect(screen.queryByRole("button", { name: "Remove topic Vectors" })).toBeNull();
    expect(screen.getByText("0/25")).toBeInTheDocument();
  });

  it("shows the server's message, and login on 401", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "plan_already_active", message: "Finish your active plan first." },
      }),
    );
    const { rerender } = render(
      <PlanSetupForm
        rooms={[]}
        documents={[]}
        initialRoomId={null}
        today={TODAY}
        demoMode={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Exam date"), {
      target: { value: "2026-11-01" },
    });
    submitForm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Finish your active plan first.",
    );
    expect(
      screen.getByRole("button", { name: "Generate plan" }),
    ).toBeEnabled();

    rerender(
      <PlanSetupForm
        rooms={[]}
        documents={[]}
        initialRoomId={null}
        today={TODAY}
        demoMode={false}
      />,
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: {} }));
    fireEvent.change(screen.getByLabelText("Exam date"), {
      target: { value: "2026-11-02" },
    });
    submitForm();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/login"));
  });
});

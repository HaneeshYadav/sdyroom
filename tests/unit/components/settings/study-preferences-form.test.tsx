// @vitest-environment jsdom
import { StudyPreferencesForm } from "@/components/settings/study-preferences-form";
import { EXAM_TRACKS } from "@/lib/vocab/exam-tracks";
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

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function submittedBody() {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("StudyPreferencesForm", () => {
  it("renders the checkbox group as a labelled fieldset", () => {
    render(
      <StudyPreferencesForm initialExamTargets={[]} initialLanguage={null} />,
    );

    const group = screen.getByRole("group", { name: "Exam targets" });
    expect(group.tagName).toBe("FIELDSET");
    expect(screen.getByText("Exam targets")).toBeInTheDocument();
    for (const track of EXAM_TRACKS) {
      expect(screen.getByLabelText(track)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("checkbox")).toHaveLength(EXAM_TRACKS.length);
  });

  it("prefills checked targets and the language select", () => {
    render(
      <StudyPreferencesForm
        initialExamTargets={["JEE", "NEET"]}
        initialLanguage="English"
      />,
    );

    expect(screen.getByLabelText("NEET")).toBeChecked();
    expect(screen.getByLabelText("JEE")).toBeChecked();
    expect(screen.getByLabelText("UPSC")).not.toBeChecked();
    expect(screen.getByLabelText("Preferred language")).toHaveValue("English");
  });

  it("submits the current targets and language, announcing success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { profile: { exam_targets: ["NEET"] } }),
    );
    render(
      <StudyPreferencesForm
        initialExamTargets={[]}
        initialLanguage={null}
      />,
    );

    fireEvent.click(screen.getByLabelText("NEET"));
    fireEvent.change(screen.getByLabelText("Preferred language"), {
      target: { value: "Hinglish" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save study details" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Exam targets and language saved.",
      ),
    );
    expect(fetchMock.mock.calls[0][0]).toBe("/api/profile");
    expect(submittedBody()).toEqual({
      exam_targets: ["NEET"],
      language: "Hinglish",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("sends language as null when no preference is chosen", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { profile: {} }));
    render(
      <StudyPreferencesForm initialExamTargets={[]} initialLanguage={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save study details" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(submittedBody()).toEqual({
      exam_targets: [],
      language: null,
    });
  });

  it("clears a previously saved language with the empty option", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { profile: {} }));
    render(
      <StudyPreferencesForm
        initialExamTargets={[]}
        initialLanguage="English"
      />,
    );

    fireEvent.change(screen.getByLabelText("Preferred language"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save study details" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(submittedBody().language).toBeNull();
  });

  it("refuses more than three targets without sending a request", async () => {
    render(
      <StudyPreferencesForm initialExamTargets={[]} initialLanguage={null} />,
    );
    for (const track of EXAM_TRACKS.slice(0, 4)) {
      fireEvent.click(screen.getByLabelText(track));
    }

    fireEvent.click(screen.getByRole("button", { name: "Save study details" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose up to 3 exam targets.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a server-side validation message as an alert", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: { code: "validation", message: "Check the highlighted fields and try again." },
      }),
    );
    render(
      <StudyPreferencesForm initialExamTargets={[]} initialLanguage={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save study details" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Check the highlighted fields",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("sends a 401 session to the login screen", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: {} }));
    render(
      <StudyPreferencesForm initialExamTargets={[]} initialLanguage={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save study details" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/login"));
  });

  it("disables and relabels the submit button while a save is pending", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(
      <StudyPreferencesForm initialExamTargets={[]} initialLanguage={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save study details" }));

    const button = await screen.findByRole("button", { name: "Saving…" });
    expect(button).toBeDisabled();
  });
});

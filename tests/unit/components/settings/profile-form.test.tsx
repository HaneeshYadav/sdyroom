// @vitest-environment jsdom
import { ProfileForm } from "@/components/settings/profile-form";
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

describe("ProfileForm", () => {
  it("prefills the alias input from the server row", () => {
    render(<ProfileForm initialAlias="OldTimer" />);

    expect(screen.getByLabelText("Study alias")).toHaveValue("OldTimer");
  });

  it("announces an invalid alias inline without sending a request", async () => {
    render(<ProfileForm initialAlias="OldTimer" />);
    fireEvent.change(screen.getByLabelText("Study alias"), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save alias" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Study alias is required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("announces an over-long alias without sending a request", async () => {
    render(<ProfileForm initialAlias="OldTimer" />);
    fireEvent.change(screen.getByLabelText("Study alias"), {
      target: { value: "x".repeat(33) },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save alias" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "32 characters or fewer",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims, PATCHes the alias and announces success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { profile: { alias: "NewName" } }),
    );
    render(<ProfileForm initialAlias="OldTimer" />);
    fireEvent.change(screen.getByLabelText("Study alias"), {
      target: { value: "  NewName  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save alias" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Saved."),
    );
    expect(fetchMock.mock.calls[0][0]).toBe("/api/profile");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(submittedBody()).toEqual({ alias: "NewName" });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces the server's alias-taken message as an alert", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: { code: "alias_taken", message: "That study alias is already taken. Try another one." },
      }),
    );
    render(<ProfileForm initialAlias="OldTimer" />);
    fireEvent.change(screen.getByLabelText("Study alias"), {
      target: { value: "TakenName" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save alias" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already taken",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("sends a 401 session to the login screen", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: {} }));
    render(<ProfileForm initialAlias="OldTimer" />);

    fireEvent.click(screen.getByRole("button", { name: "Save alias" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/login"));
  });

  it("reports a network failure without claiming success", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<ProfileForm initialAlias="OldTimer" />);

    fireEvent.click(screen.getByRole("button", { name: "Save alias" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the server",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("disables and relabels the submit button while a save is pending", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<ProfileForm initialAlias="OldTimer" />);
    fireEvent.change(screen.getByLabelText("Study alias"), {
      target: { value: "PendingName" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save alias" }));

    const button = await screen.findByRole("button", { name: "Saving…" });
    expect(button).toBeDisabled();
  });
});

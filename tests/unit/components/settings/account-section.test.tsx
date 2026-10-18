// @vitest-environment jsdom
import { AccountSection } from "@/components/settings/account-section";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AccountSection", () => {
  it("shows the session email in a read-only field", () => {
    render(
      <AccountSection email="aarav@example.com" createdAt="2026-01-02T03:04:05.000Z" />,
    );

    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.value).toBe("aarav@example.com");
    expect(email.readOnly).toBe(true);
  });

  it("renders an empty read-only email when the claim is absent", () => {
    render(<AccountSection email={null} createdAt="2026-01-02T03:04:05.000Z" />);

    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.value).toBe("");
    expect(email.readOnly).toBe(true);
  });

  it("shows the join date as the fixed UTC date, read-only", () => {
    render(
      <AccountSection email="aarav@example.com" createdAt="2026-01-02T03:04:05.000Z" />,
    );

    const created = screen.getByLabelText("Member since") as HTMLInputElement;
    expect(created.value).toBe("2026-01-02");
    expect(created.readOnly).toBe(true);
  });

  it("points at Supabase Auth for email changes and offers sign-out", () => {
    render(
      <AccountSection email="aarav@example.com" createdAt="2026-01-02T03:04:05.000Z" />,
    );

    expect(
      screen.getByText(/use the confirmation link Supabase Auth sent/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Logout" })).toBeInTheDocument();
  });
});

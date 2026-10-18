// @vitest-environment jsdom
import { RoomCard } from "@/components/room-card";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function summary(
  overrides: Partial<{
    viewer_membership: "none" | "member" | "owner";
    viewer_role: "owner" | "student" | null;
    member_count: number;
    status: string;
    last_activity_at: string | null;
    language: string | null;
  }> = {},
) {
  return {
    id: ROOM_ID,
    name: "Calculus Study Room",
    exam_track: "JEE",
    subject: "Mathematics",
    language: "English",
    capacity: 4,
    status: "open",
    shared_goal: "Finish the syllabus.",
    created_at: "2026-01-05T10:00:00.000Z",
    member_count: 1,
    last_activity_at: null,
    viewer_role: null,
    viewer_membership: "none" as const,
    ...overrides,
  };
}

describe("RoomCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("links a member into the workspace", () => {
    render(<RoomCard room={summary({ viewer_membership: "member" })} />);

    const enter = screen.getByRole("link", { name: "Enter room" });
    expect(enter).toHaveAttribute("href", `/rooms/${ROOM_ID}`);
    expect(
      screen.getByRole("button", { name: `Leave Calculus Study Room` }),
    ).toBeInTheDocument();
  });

  it("links the owner into the workspace", () => {
    render(<RoomCard room={summary({ viewer_membership: "owner" })} />);

    const enter = screen.getByRole("link", { name: "Enter room" });
    expect(enter).toHaveAttribute("href", `/rooms/${ROOM_ID}`);
    expect(screen.getByText("You own this room.")).toBeInTheDocument();
  });

  it("shows no workspace link before the viewer has joined", () => {
    render(<RoomCard room={summary({ viewer_membership: "none" })} />);

    expect(
      screen.queryByRole("link", { name: "Enter room" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Join Calculus Study Room" }),
    ).toBeInTheDocument();
  });

  it("labels the status badge in sentence case", () => {
    const { unmount } = render(<RoomCard room={summary({ status: "open" })} />);
    expect(screen.getByText("Open")).toBeInTheDocument();
    unmount();

    render(<RoomCard room={summary({ status: "closed" })} />);
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("links the card to the preview with an accessible name of title and subject", () => {
    render(<RoomCard room={summary()} />);

    const link = screen.getByRole("link", {
      name: "Calculus Study Room, Mathematics",
    });
    expect(link).toHaveAttribute("href", `/rooms/${ROOM_ID}/preview`);
  });

  it("shows a text Joined badge for the viewer's own membership", () => {
    const { unmount } = render(
      <RoomCard room={summary({ viewer_membership: "member" })} />,
    );
    expect(screen.getByText("Joined")).toBeInTheDocument();
    unmount();

    render(<RoomCard room={summary({ viewer_membership: "none" })} />);
    expect(screen.queryByText("Joined")).not.toBeInTheDocument();
  });

  it("renders derived activity as a relative label and hides it when absent", () => {
    const { unmount } = render(
      <RoomCard
        room={summary({
          last_activity_at: new Date(Date.now() - 3 * 60_000).toISOString(),
        })}
      />,
    );
    expect(screen.getByText(/^Active /)).toBeInTheDocument();
    unmount();

    render(<RoomCard room={summary({ last_activity_at: null })} />);
    expect(screen.queryByText(/^Active /)).not.toBeInTheDocument();
  });

  it("keeps the seat usage on the card", () => {
    render(<RoomCard room={summary({ member_count: 2 })} />);
    expect(screen.getByText("2 of 4 seats taken")).toBeInTheDocument();
  });
});

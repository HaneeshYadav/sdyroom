// @vitest-environment jsdom
import { RoomPreview } from "@/components/rooms/room-preview";
import type { RoomPreview as RoomPreviewData } from "@/lib/rooms/discovery";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function preview(
  overrides: Partial<RoomPreviewData> = {},
): RoomPreviewData {
  return {
    id: ROOM_ID,
    name: "Alpha Physics",
    shared_goal: "Finish mechanics",
    subject: "Physics",
    exam_track: "JEE",
    language: "English",
    visibility: "public",
    status: "open",
    capacity: 6,
    member_count: 3,
    created_at: "2026-09-20T00:00:00.000Z",
    is_member: false,
    viewer_role: null,
    ...overrides,
  };
}

afterEach(cleanup);

describe("RoomPreview", () => {
  it("shows enough to decide: goal, badges, seats and created date", () => {
    render(<RoomPreview room={preview()} backPath="/rooms?q=physics" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Alpha Physics" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Finish mechanics")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("3 of 6 seats taken")).toBeInTheDocument();
    expect(screen.getByText("Physics")).toBeInTheDocument();
    expect(screen.getByText("JEE")).toBeInTheDocument();
    expect(screen.getByText("English")).toBeInTheDocument();
  });

  it("keeps the back link on the originating filters", () => {
    render(<RoomPreview room={preview()} backPath="/rooms?q=physics" />);
    expect(screen.getByRole("link", { name: /back to results/i })).toHaveAttribute(
      "href",
      "/rooms?q=physics",
    );
  });

  it("offers Join to a stranger and Open room to a member", () => {
    const { unmount } = render(
      <RoomPreview room={preview()} backPath="/rooms" />,
    );
    expect(
      screen.getByRole("button", { name: `Join ${preview().name}` }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open room" }),
    ).toBeNull();
    unmount();

    render(
      <RoomPreview
        room={preview({ is_member: true, viewer_role: "student" })}
        backPath="/rooms"
      />,
    );
    expect(screen.getByRole("link", { name: "Open room" })).toHaveAttribute(
      "href",
      `/rooms/${ROOM_ID}`,
    );
    expect(
      screen.getByRole("button", { name: `Leave ${preview().name}` }),
    ).toBeInTheDocument();
  });

  it("tells an owner they own the room instead of offering leave", () => {
    render(
      <RoomPreview
        room={preview({ is_member: true, viewer_role: "owner" })}
        backPath="/rooms"
      />,
    );

    expect(screen.getByText("You own this room.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open room" })).toBeInTheDocument();
  });

  it("marks a closed or full room with text, not colour alone", () => {
    render(
      <RoomPreview
        room={preview({ status: "closed", member_count: 6 })}
        backPath="/rooms"
      />,
    );

    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.getByText("Full")).toBeInTheDocument();
    expect(screen.getByText("Room is closed.")).toBeInTheDocument();
  });
});

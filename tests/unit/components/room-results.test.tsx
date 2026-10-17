// @vitest-environment jsdom
import { RoomResults } from "@/components/rooms/room-results";
import type { RoomSummary } from "@/lib/rooms/types";
import type { RoomSearchInput } from "@/lib/validation/rooms";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replace, push } = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push }),
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function summary(name: string, id = ROOM_ID): RoomSummary {
  return {
    id,
    name,
    exam_track: "JEE",
    subject: "Physics",
    language: "English",
    capacity: 6,
    status: "open",
    shared_goal: null,
    created_at: "2026-10-06T00:00:00.000Z",
    member_count: 1,
    last_activity_at: null,
    viewer_role: null,
    viewer_membership: "none",
  };
}

const search: RoomSearchInput = {
  q: "",
  subject: null,
  exam_track: null,
  language: null,
  min_members: 0,
  sort: undefined,
  limit: 20,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  replace.mockReset();
  push.mockReset();
});

describe("RoomResults", () => {
  it("announces the loaded count with role=status", () => {
    render(
      <RoomResults
        initialRooms={[summary("Alpha"), summary("Beta", "22222222-2222-4222-8222-222222222222")]}
        initialHasMore={false}
        initialCursor={null}
        search={search}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "2 rooms — public rooms only",
    );
  });

  it("mentions the query in the count line", () => {
    render(
      <RoomResults
        initialRooms={[summary("Alpha")]}
        initialHasMore
        initialCursor="cursor-1"
        search={{ ...search, q: "alpha" }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "1 room matching “alpha” — more available",
    );
  });

  it("offers a clear search and a create action in the empty state", () => {
    render(
      <RoomResults
        initialRooms={[]}
        initialHasMore={false}
        initialCursor={null}
        search={{ ...search, q: "nothing" }}
      />,
    );

    expect(screen.getByText("No public rooms match your search.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(replace).toHaveBeenCalledWith("/rooms", { scroll: false });
    expect(screen.getByRole("link", { name: "Create a room" })).toHaveAttribute(
      "href",
      "/rooms/new",
    );
  });

  it("says the directory is empty only when nothing was searched", () => {
    render(
      <RoomResults
        initialRooms={[]}
        initialHasMore={false}
        initialCursor={null}
        search={search}
      />,
    );

    expect(
      screen.getByText("No public rooms yet. Create the first one."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("appends the next page through the cursor and drops Load more at the end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          rooms: [summary("Beta", "22222222-2222-4222-8222-222222222222")],
          has_more: false,
          next_cursor: null,
        }),
      })),
    );

    render(
      <RoomResults
        initialRooms={[summary("Alpha")]}
        initialHasMore
        initialCursor="cursor-1"
        search={search}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more rooms" }));
    });

    expect(fetch).toHaveBeenCalledWith("/api/rooms?limit=20&cursor=cursor-1");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Load more rooms" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("2 rooms");
  });

  it("keeps loaded rooms and offers a retry when a page fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 500,
        ok: false,
        json: async () => ({
          error: { message: "Public rooms could not be loaded." },
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          rooms: [summary("Beta", "22222222-2222-4222-8222-222222222222")],
          has_more: false,
          next_cursor: null,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RoomResults
        initialRooms={[summary("Alpha")]}
        initialHasMore
        initialCursor="cursor-1"
        search={search}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more rooms" }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Public rooms could not be loaded.",
    );
    // The first page is never thrown away by a failed second page.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("redirects to login when the session has expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) })),
    );

    render(
      <RoomResults
        initialRooms={[summary("Alpha")]}
        initialHasMore
        initialCursor="cursor-1"
        search={search}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more rooms" }));
    });

    expect(push).toHaveBeenCalledWith("/auth/login");
  });

  it("adopts a refreshed first page from the server (join / leave)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          rooms: [summary("Beta", "22222222-2222-4222-8222-222222222222")],
          has_more: false,
          next_cursor: null,
        }),
      })),
    );

    const { rerender } = render(
      <RoomResults
        initialRooms={[summary("Alpha")]}
        initialHasMore={false}
        initialCursor={null}
        search={search}
      />,
    );

    // router.refresh() after a join re-renders the server page: same query,
    // but the membership the server now sees.
    const joined = { ...summary("Alpha"), viewer_membership: "member" as const };
    rerender(
      <RoomResults
        initialRooms={[joined]}
        initialHasMore={false}
        initialCursor={null}
        search={search}
      />,
    );

    expect(screen.getByRole("link", { name: "Enter room" })).toHaveAttribute(
      "href",
      `/rooms/${ROOM_ID}`,
    );
  });

  it("drops client-loaded pages when the server's first page changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          rooms: [summary("Beta", "22222222-2222-4222-8222-222222222222")],
          has_more: false,
          next_cursor: null,
        }),
      })),
    );

    const { rerender } = render(
      <RoomResults
        initialRooms={[summary("Alpha")]}
        initialHasMore
        initialCursor="cursor-1"
        search={search}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more rooms" }));
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    // A refresh must not mix the stale cursor page with the fresh first page.
    const refreshed = { ...summary("Alpha"), viewer_membership: "member" as const };
    rerender(
      <RoomResults
        initialRooms={[refreshed]}
        initialHasMore={false}
        initialCursor={null}
        search={search}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("1 room");
  });
});

// @vitest-environment jsdom
import { NotificationsInbox } from "@/components/notifications/notifications-inbox";
import type { NotificationView } from "@/lib/notifications/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, fetchMock } = vi.hoisted(() => ({
  push: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const ROW: NotificationView = {
  id: "33333333-3333-4333-8333-333333333333",
  type: "invite_created",
  room_id: "11111111-1111-4111-8111-111111111111",
  payload: {
    title: "Invitation to Quiet Hall",
    body: "owner invited you.",
    href: "/invitations",
  },
  read_at: null,
  created_at: new Date().toISOString(),
};

const PROPS = {
  initialNotifications: [ROW],
  initialHasMore: false,
  initialNextCursor: null,
  initialUnreadCount: 1,
  initialPrefs: { default: "all" as const },
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("NotificationsInbox", () => {
  it("posts a mark-read with keepalive so the row's deep link cannot cancel it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { notifications: [], unread_count: 0 }),
    );

    render(<NotificationsInbox {...PROPS} />);
    fireEvent.click(screen.getByRole("link", { name: /Invitation to Quiet Hall/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/notifications/${ROW.id}/read`,
        { method: "POST", keepalive: true },
      );
    });
  });

  it("posts a mark-all with keepalive so a navigation right after the click cannot cancel it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { notifications: [], unread_count: 0 }),
    );

    render(<NotificationsInbox {...PROPS} />);
    fireEvent.click(screen.getByTestId("inbox-mark-all"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/notifications/read-all", {
        method: "POST",
        keepalive: true,
      });
    });
  });
});

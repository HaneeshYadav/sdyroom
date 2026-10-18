import {
  MESSAGE_LIMIT,
  NOTIFICATION_PREFS_LIMIT,
  ROOM_CREATE_LIMIT,
  messageKey,
  messageSpec,
  notificationPrefsKey,
  notificationPrefsSpec,
  roomCreateKey,
  roomCreateSpec,
} from "@/lib/rate-limit/keys";
import { describe, expect, it } from "vitest";

/**
 * These strings are the published API contract (docs/API_CONTRACTS.md
 * "Rate limits"). Renaming a key silently resets every live counter and
 * desynchronizes the docs, so the exact shapes are pinned here.
 */
describe("rate-limit keys added in PR 21", () => {
  it("keys chat sends per room and per sender", () => {
    expect(messageKey("room-1", "user-1")).toBe("message:room-1:user-1");
    expect(messageSpec("room-1", "user-1")).toEqual({
      key: "message:room-1:user-1",
      max: 30,
      windowSeconds: 60,
    });
    expect(MESSAGE_LIMIT).toEqual({ max: 30, windowSeconds: 60 });
  });

  it("keys room creation per account", () => {
    expect(roomCreateKey("user-1")).toBe("room_create:user:user-1");
    expect(roomCreateSpec("user-1")).toEqual({
      key: "room_create:user:user-1",
      max: 5,
      windowSeconds: 60,
    });
    expect(ROOM_CREATE_LIMIT).toEqual({ max: 5, windowSeconds: 60 });
  });

  it("keys notification-preference saves per account", () => {
    expect(notificationPrefsKey("user-1")).toBe("notification_prefs:user-1");
    expect(notificationPrefsSpec("user-1")).toEqual({
      key: "notification_prefs:user-1",
      max: 30,
      windowSeconds: 60,
    });
    expect(NOTIFICATION_PREFS_LIMIT).toEqual({ max: 30, windowSeconds: 60 });
  });

  it("never lets two rooms share a chat counter", () => {
    expect(messageKey("room-a", "user-1")).not.toBe(messageKey("room-b", "user-1"));
  });
});

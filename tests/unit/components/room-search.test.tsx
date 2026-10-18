// @vitest-environment jsdom
import { RoomSearch } from "@/components/rooms/room-search";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));

let params = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => params,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  replace.mockReset();
  params = new URLSearchParams();
});

describe("RoomSearch", () => {
  it("debounces typing into a URL update that keeps the other filters", () => {
    vi.useFakeTimers();
    params = new URLSearchParams("subject=Physics&sort=active");
    render(<RoomSearch />);

    fireEvent.change(screen.getByLabelText("Search public rooms"), {
      target: { value: "neet" },
    });
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(replace).toHaveBeenCalledWith(
      "/rooms?q=neet&subject=Physics&sort=active",
      { scroll: false },
    );
  });

  it("flushes immediately when the form is submitted", () => {
    vi.useFakeTimers();
    render(<RoomSearch />);

    fireEvent.change(screen.getByLabelText("Search public rooms"), {
      target: { value: "physics" },
    });
    fireEvent.submit(screen.getByRole("search"));

    expect(replace).toHaveBeenCalledWith("/rooms?q=physics", { scroll: false });

    // The pending debounce must not fire a second, stale navigation.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("trims the query and drops an unchanged one", () => {
    vi.useFakeTimers();
    render(<RoomSearch />);

    fireEvent.change(screen.getByLabelText("Search public rooms"), {
      target: { value: "  physics  " },
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(replace).toHaveBeenCalledWith("/rooms?q=physics", { scroll: false });

    // Typing back to the active value must not navigate again.
    replace.mockClear();
    fireEvent.change(screen.getByLabelText("Search public rooms"), {
      target: { value: "physics" },
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("clears only the query and leaves filters alone", () => {
    vi.useFakeTimers();
    params = new URLSearchParams("q=neet&subject=Biology");
    render(<RoomSearch />);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(replace).toHaveBeenCalledWith("/rooms?subject=Biology", {
      scroll: false,
    });
  });

  it("shows no Clear button when there is no active query", () => {
    render(<RoomSearch />);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("syncs the field when the URL changes externally", () => {
    const view = render(<RoomSearch />);
    expect(
      (screen.getByLabelText("Search public rooms") as HTMLInputElement).value,
    ).toBe("");

    params = new URLSearchParams("q=biology");
    view.rerender(<RoomSearch />);

    expect(
      (screen.getByLabelText("Search public rooms") as HTMLInputElement).value,
    ).toBe("biology");
  });
});

// @vitest-environment jsdom
import { RoomFilters } from "@/components/rooms/room-filters";
import type { DiscoveryState } from "@/lib/rooms/discovery-params";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

afterEach(cleanup);

beforeEach(() => {
  replace.mockReset();
});

const OPTIONS = {
  subjects: ["Biology", "Physics"],
  exam_tracks: ["JEE", "NEET"],
  languages: ["English", "Hinglish"],
};

const DEFAULT_STATE: DiscoveryState = {
  q: "",
  subject: null,
  exam_track: null,
  language: null,
  min_members: 0,
  sort: null,
};

describe("RoomFilters", () => {
  it("renders one labelled select per filter plus sort", () => {
    render(<RoomFilters state={DEFAULT_STATE} options={OPTIONS} />);

    for (const label of [
      "Subject",
      "Exam",
      "Language",
      "Minimum members",
      "Sort by",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("group", { name: "Room filters" })).toBeInTheDocument();
  });

  it("offers the distinct public values from the options RPC", () => {
    render(<RoomFilters state={DEFAULT_STATE} options={OPTIONS} />);

    const subject = screen.getByLabelText("Subject") as HTMLSelectElement;
    expect([...subject.options].map((option) => option.value)).toEqual([
      "",
      "Biology",
      "Physics",
    ]);
  });

  it("writes a changed filter to the URL while keeping the query", () => {
    render(
      <RoomFilters
        state={{ ...DEFAULT_STATE, q: "neet" }}
        options={OPTIONS}
      />,
    );

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Biology" },
    });
    expect(replace).toHaveBeenCalledWith("/rooms?q=neet&subject=Biology", {
      scroll: false,
    });
  });

  it("treats the empty option as clearing that filter", () => {
    render(
      <RoomFilters
        state={{ ...DEFAULT_STATE, subject: "Physics" }}
        options={OPTIONS}
      />,
    );

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "" },
    });
    expect(replace).toHaveBeenCalledWith("/rooms", { scroll: false });
  });

  it("serialises min_members and sort through the URL", () => {
    render(<RoomFilters state={DEFAULT_STATE} options={OPTIONS} />);

    fireEvent.change(screen.getByLabelText("Minimum members"), {
      target: { value: "5" },
    });
    expect(replace).toHaveBeenCalledWith("/rooms?min_members=5", {
      scroll: false,
    });

    fireEvent.change(screen.getByLabelText("Sort by"), {
      target: { value: "active" },
    });
    expect(replace).toHaveBeenLastCalledWith("/rooms?sort=active", {
      scroll: false,
    });
  });

  it("keeps the current values selected", () => {
    render(
      <RoomFilters
        state={{
          q: "",
          subject: "Physics",
          exam_track: "JEE",
          language: null,
          min_members: 2,
          sort: "name",
        }}
        options={OPTIONS}
      />,
    );

    expect(
      (screen.getByLabelText("Subject") as HTMLSelectElement).value,
    ).toBe("Physics");
    expect(
      (screen.getByLabelText("Minimum members") as HTMLSelectElement).value,
    ).toBe("2");
    expect((screen.getByLabelText("Sort by") as HTMLSelectElement).value).toBe(
      "name",
    );
  });
});

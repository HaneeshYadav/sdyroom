// @vitest-environment jsdom
import { ActiveFilters } from "@/components/rooms/active-filters";
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

const DEFAULT_STATE: DiscoveryState = {
  q: "",
  subject: null,
  exam_track: null,
  language: null,
  min_members: 0,
  sort: null,
};

describe("ActiveFilters", () => {
  it("renders nothing when the search is unrestricted", () => {
    const { container } = render(<ActiveFilters state={DEFAULT_STATE} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every active restriction as a labelled chip", () => {
    render(
      <ActiveFilters
        state={{
          q: "neet",
          subject: "Biology",
          exam_track: "NEET",
          language: null,
          min_members: 2,
          sort: "largest",
        }}
      />,
    );

    expect(screen.getByText("Search: neet")).toBeInTheDocument();
    expect(screen.getByText("Subject: Biology")).toBeInTheDocument();
    expect(screen.getByText("Exam: NEET")).toBeInTheDocument();
    expect(screen.getByText("2+ members")).toBeInTheDocument();
    expect(screen.getByText("Sorted by largest")).toBeInTheDocument();
  });

  it("removes exactly one restriction per chip", () => {
    render(
      <ActiveFilters
        state={{
          q: "neet",
          subject: "Biology",
          exam_track: null,
          language: null,
          min_members: 0,
          sort: "recent",
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove filter Subject: Biology" }),
    );
    expect(replace).toHaveBeenCalledWith("/rooms?q=neet&sort=recent", {
      scroll: false,
    });
  });

  it("clears everything back to the browse root", () => {
    render(
      <ActiveFilters
        state={{
          q: "neet",
          subject: "Biology",
          exam_track: null,
          language: null,
          min_members: 0,
          sort: null,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(replace).toHaveBeenCalledWith("/rooms", { scroll: false });
  });
});

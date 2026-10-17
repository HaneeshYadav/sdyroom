// @vitest-environment jsdom
import { RangeSwitcher } from "@/components/analytics/range-switcher";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replace, pathname } = vi.hoisted(() => ({
  replace: vi.fn(),
  pathname: vi.fn(() => "/analytics"),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname(),
}));

afterEach(cleanup);

beforeEach(() => {
  replace.mockReset();
  pathname.mockReturnValue("/analytics");
});

describe("RangeSwitcher", () => {
  it("offers exactly the three spec ranges with the current one selected", () => {
    render(<RangeSwitcher current="30d" />);
    const select = screen.getByRole("combobox", { name: /range/i }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "7d",
      "30d",
      "90d",
    ]);
    expect(select.value).toBe("30d");
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Last 7 days",
      "Last 30 days",
      "Last 90 days",
    ]);
  });

  it("replaces ?range= on the current path without scrolling", () => {
    pathname.mockReturnValue("/rooms/11111111-1111-4111-8111-111111111111/analytics");
    render(<RangeSwitcher current="7d" />);
    const select = screen.getByRole("combobox", { name: /range/i });
    fireEvent.change(select, { target: { value: "90d" } });
    expect(replace).toHaveBeenCalledWith(
      "/rooms/11111111-1111-4111-8111-111111111111/analytics?range=90d",
      { scroll: false },
    );
  });
});

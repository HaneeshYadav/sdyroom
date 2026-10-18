// @vitest-environment jsdom
import { RoomCreateForm } from "@/components/room-create-form";
import { StudyPreferencesForm } from "@/components/settings/study-preferences-form";
import { EXAM_TRACKS } from "@/lib/vocab/exam-tracks";
import { LANGUAGES } from "@/lib/vocab/languages";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => cleanup());

function optionValues(label: string): string[] {
  const select = screen.getByLabelText(label) as HTMLSelectElement;
  return Array.from(select.options).map((option) => option.value);
}

/**
 * The anti-drift guarantee: room creation and settings render their options
 * from the *same* arrays, so adding an exam or language in one module lights
 * up both surfaces and neither can quietly diverge.
 */
describe("shared vocabulary", () => {
  it("offers the identical exam-track list on the create-room form and settings", () => {
    render(<RoomCreateForm />);
    expect(optionValues("Exam track")).toEqual(["", ...EXAM_TRACKS]);

    cleanup();
    render(
      <StudyPreferencesForm initialExamTargets={[]} initialLanguage={null} />,
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(EXAM_TRACKS.length);
    for (const track of EXAM_TRACKS) {
      expect(screen.getByLabelText(track)).toBeInTheDocument();
    }
  });

  it("offers the identical language list on the create-room form and settings", () => {
    render(<RoomCreateForm />);
    expect(optionValues("Language")).toEqual(["", ...LANGUAGES]);

    cleanup();
    render(
      <StudyPreferencesForm initialExamTargets={[]} initialLanguage={null} />,
    );
    expect(optionValues("Preferred language")).toEqual(["", ...LANGUAGES]);
  });
});

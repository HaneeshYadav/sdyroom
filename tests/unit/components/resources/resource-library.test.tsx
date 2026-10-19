// @vitest-environment jsdom
import { ResourceLibrary } from "@/components/resources/resource-library";
import type { StudyResource } from "@/lib/resources/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({}),
}));

const RESOURCE: StudyResource = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Mechanics notes",
  original_filename: "mechanics.pdf",
  content_type: "application/pdf",
  size_bytes: 1024,
  subject: "Physics",
  chapter: null,
  room_id: null,
  created_at: "2026-10-17T10:00:00.000Z",
  updated_at: "2026-10-17T10:00:00.000Z",
  ai: null,
  is_owner: true,
};

function renderLibrary(initialHasMore: boolean) {
  return render(
    <ResourceLibrary
      scope={{ kind: "personal" }}
      initialResources={[RESOURCE]}
      initialHasMore={initialHasMore}
      quota={null}
      idPrefix="personal"
      heading="My resources"
      description="Private study files only you can open."
    />,
  );
}

describe("ResourceLibrary initial pagination flag", () => {
  afterEach(() => cleanup());

  it("renders Show more when the server's first page reports more rows (PR 21 regression)", () => {
    renderLibrary(true);

    expect(
      screen.getByRole("button", { name: "Show more" }),
    ).toBeInTheDocument();
  });

  it("stays hidden when the first page is also the last", () => {
    renderLibrary(false);

    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});

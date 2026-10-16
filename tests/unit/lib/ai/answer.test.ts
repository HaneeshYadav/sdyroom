import {
  appendSourcesFooter,
  extractCitationMarkers,
  finalizeAnswer,
  sanitizeAnswerMarkers,
} from "@/lib/ai/answer";
import type { CitationRef } from "@/lib/ai/retrieve";
import { describe, expect, it } from "vitest";

const CITATIONS: CitationRef[] = [
  { resourceId: "a", title: "Mechanics", href: "/resources", pages: [3, 5] },
  { resourceId: "b", title: "Waves", href: "/rooms/r1" },
];

describe("extractCitationMarkers", () => {
  it("collects distinct in-range markers in appearance order", () => {
    expect(extractCitationMarkers("Torque [1] then [2] again [1].")).toEqual([
      1, 2,
    ]);
  });

  it("ignores zero, oversized and out-of-band markers", () => {
    expect(extractCitationMarkers("[0] [1000] [99]")).toEqual([99]);
  });
});

describe("sanitizeAnswerMarkers", () => {
  it("keeps in-range markers, including repeats", () => {
    expect(sanitizeAnswerMarkers("A [1] B [2] C [1]", 2)).toBe("A [1] B [2] C [1]");
  });

  it("strips markers that point past the citation list", () => {
    expect(sanitizeAnswerMarkers("See [3] and [9].", 2)).toBe("See  and .");
    expect(sanitizeAnswerMarkers("See [0].", 2)).toBe("See .");
  });
});

describe("appendSourcesFooter", () => {
  it("builds the footer from the real citations, pages included", () => {
    expect(appendSourcesFooter("Answer.", CITATIONS)).toBe(
      "Answer.\n\nSources: [1] Mechanics (p. 3, 5), [2] Waves",
    );
  });

  it("returns the answer untouched when there are no citations", () => {
    expect(appendSourcesFooter("Answer.", [])).toBe("Answer.");
  });
});

describe("finalizeAnswer", () => {
  it("strips orphans first, then appends the application-built footer", () => {
    expect(finalizeAnswer("Claim [1], also [7].", CITATIONS)).toBe(
      "Claim [1], also .\n\nSources: [1] Mechanics (p. 3, 5), [2] Waves",
    );
  });
});

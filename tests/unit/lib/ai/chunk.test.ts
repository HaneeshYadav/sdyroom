import {
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  chunkDocument,
} from "@/lib/ai/chunk";
import { estimateTokens } from "@/lib/ai/tokens";
import { describe, expect, it } from "vitest";

/** A deterministic multi-thousand-character study note (word-boundary safe). */
function longNote(words: number): string {
  const pieces: string[] = [];
  for (let index = 0; index < words; index += 1) {
    pieces.push(`torque${index}`);
  }
  return pieces.join(" ");
}

const NOISE = /\s/g;

describe("chunkDocument — window invariants", () => {
  it("splits a long plain document into windows no larger than the target", () => {
    const drafts = chunkDocument(longNote(3000));
    expect(drafts.length).toBeGreaterThan(1);
    for (const draft of drafts) {
      expect(draft.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
      expect(draft.text.length).toBeGreaterThan(0);
    }
  });

  it("loses no words at window boundaries (overlap only ever adds text)", () => {
    const text = longNote(3000);
    const stripped = chunkDocument(text)
      .map((draft) => draft.text)
      .join("")
      .replace(NOISE, "");
    for (const word of text.split(" ")) {
      expect(stripped).toContain(word);
    }
  });

  it("overlaps consecutive windows instead of hard-slicing words", () => {
    const drafts = chunkDocument(longNote(3000));
    const first = drafts[0].text;
    const second = drafts[1].text;
    // The next window starts ~480 chars before the previous cut, so its head
    // must still be findable inside the previous chunk.
    expect(first.includes(second.slice(0, 40))).toBe(true);
    expect(CHUNK_OVERLAP_CHARS).toBe(480);
  });

  it("cuts at word boundaries, never mid-word at a chunk end", () => {
    for (const draft of chunkDocument(longNote(3000))) {
      // `torque123` words: a trimmed window always ends on a word character
      // because the cut lands on the whitespace after a word.
      expect(draft.text).toMatch(/\w$/);
      expect(draft.text.trim()).toBe(draft.text);
    }
  });
});

describe("chunkDocument — pages", () => {
  const PAGED = "page one content\fpage two content\fpage three content";

  it("never lets a chunk span a page boundary and numbers pages 1-based for PDFs", () => {
    const drafts = chunkDocument(PAGED, { pdf: true });
    expect(drafts.map((d) => d.page_start)).toEqual([1, 2, 3]);
    for (const draft of drafts) {
      expect(draft.text).not.toContain("\f");
    }
    expect(drafts.map((d) => d.text)).toEqual([
      "page one content",
      "page two content",
      "page three content",
    ]);
  });

  it("keeps page_start null for plain formats", () => {
    const drafts = chunkDocument(PAGED, { pdf: false });
    expect(drafts.every((draft) => draft.page_start === null)).toBe(true);
    // Without the page flag the separator is still just whitespace to skip over.
    expect(drafts.length).toBeGreaterThanOrEqual(1);
  });

  it("skips empty pages", () => {
    const drafts = chunkDocument("keep me\f\f\falso me", { pdf: true });
    expect(drafts.map((d) => d.text)).toEqual(["keep me", "also me"]);
    expect(drafts.map((d) => d.page_start)).toEqual([1, 4]);
  });
});

describe("chunkDocument — markdown headings", () => {
  const MD = [
    "# Chapter 3: Rotational Dynamics",
    "Torque is the rotational analogue of force.",
    "",
    "## Worked example",
    "A wheel accelerates from rest.",
  ].join("\n");

  it("carries the nearest heading onto each of its chunks", () => {
    const drafts = chunkDocument(MD, { markdown: true });
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts[0].heading).toBe("Chapter 3: Rotational Dynamics");
    expect(drafts[0].text).toContain("# Chapter 3");
    expect(drafts.at(-1)?.heading).toBe("Worked example");
    expect(drafts.at(-1)?.text).toContain("wheel accelerates");
  });

  it("leaves heading null for non-markdown documents", () => {
    const drafts = chunkDocument("# not really markdown", { markdown: false });
    expect(drafts[0].heading).toBeNull();
  });
});

describe("chunkDocument — contract invariants", () => {
  it("returns [] for content with nothing to index", () => {
    expect(chunkDocument("")).toEqual([]);
    expect(chunkDocument("   \n\t  ")).toEqual([]);
    expect(chunkDocument("\f\f\f")).toEqual([]);
  });

  it("assigns 0-based ordinals in reading order across the whole document", () => {
    const drafts = chunkDocument(`# A\f${longNote(3000)}`, {
      pdf: true,
      markdown: true,
    });
    drafts.forEach((draft, index) => {
      expect(draft.ordinal).toBe(index);
    });
  });

  it("stores the token estimate and stays inside the table's bounds", () => {
    for (const draft of chunkDocument(longNote(3000))) {
      expect(draft.tokens).toBe(estimateTokens(draft.text));
      expect(draft.tokens).toBeGreaterThanOrEqual(1);
      expect(draft.tokens).toBeLessThanOrEqual(100_000);
      expect(draft.text.length).toBeLessThanOrEqual(16_000);
    }
  });

  it("is pure: identical input produces identical output (idempotent re-runs)", () => {
    const text = `# Notes\f${longNote(3000)}\fappendix`;
    const first = chunkDocument(text, { pdf: true, markdown: true });
    const second = chunkDocument(text, { pdf: true, markdown: true });
    expect(second).toEqual(first);
  });
});

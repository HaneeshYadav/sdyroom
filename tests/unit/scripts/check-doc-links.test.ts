import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  checkDocument,
  checkTarget,
  collectAnchors,
  extractLinks,
  isExternal,
  slugify,
  stripFences,
} from "../../../scripts/check-doc-links.mjs";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const k = (rel: string) => path.join(ROOT, rel);

const FILES: Record<string, string> = {
  [k("README.md")]: "# Overview\n\n## Current suite\n\nSee [security](docs/SECURITY.md#coverage).\n",
  [k("docs/SECURITY.md")]: "# Security\n\n## Coverage\n\nTable.\n\n### Unit floor\n",
  [k("docs/milestones.md")]: '# Milestones\n\n<a name="roadmap"></a>\n\n## Done\n',
};

const fileExists = (abs: string) => abs in FILES;
const anchorsFor = (abs: string) => collectAnchors(FILES[abs]);
const opts = { fileExists, anchorsFor };

describe("slugify", () => {
  it("matches GitHub's heading slug rules", () => {
    expect(slugify("Current suite")).toBe("current-suite");
    expect(slugify("Coverage table (per suite)")).toBe("coverage-table-per-suite");
    expect(slugify("  Trailing space  ")).toBe("trailing-space");
    expect(slugify("What's new?")).toBe("whats-new");
  });
});

describe("collectAnchors", () => {
  it("collects heading slugs and explicit <a name> targets", () => {
    const anchors = collectAnchors(FILES[k("docs/milestones.md")]);
    expect(anchors.has("milestones")).toBe(true);
    expect(anchors.has("roadmap")).toBe(true);
    expect(anchors.has("done")).toBe(true);
  });

  it("ignores headings that only appear inside fenced code blocks", () => {
    const anchors = collectAnchors("# Real\n\n```\n# Not A Heading\n```\n");
    expect(anchors.has("real")).toBe(true);
    expect(anchors.has("not-a-heading")).toBe(false);
  });
});

describe("stripFences and extractLinks", () => {
  it("drops links inside fences and inline code", () => {
    const md = "# T\n\n`[not a link](x.md)`\n\n```\n[fenced](gone.md)\n```\n\n[real](docs/a.md)";
    const links = extractLinks(md);
    expect(links.map((l) => l.href)).toEqual(["docs/a.md"]);
    expect(stripFences(md)).not.toContain("gone.md");
  });

  it("extracts links with titles, anchors and definition-style targets", () => {
    const md = `[a](b.md "title") and [c](#local) and [d][ref]\n\n[ref]: defs/e.md`;
    expect(extractLinks(md).map((l) => l.href)).toEqual(["b.md", "#local", "defs/e.md"]);
  });

  it("reports the line each link came from", () => {
    const links = extractLinks("one\n\n[second](x.md)");
    expect(links).toEqual([{ raw: "x.md", href: "x.md", line: 3 }]);
  });
});

describe("isExternal", () => {
  it("classifies scheme links as out of scope", () => {
    expect(isExternal("https://example.com")).toBe(true);
    expect(isExternal("http://example.com")).toBe(true);
    expect(isExternal("mailto:a@b.c")).toBe(true);
    expect(isExternal("//cdn.example.com/x")).toBe(true);
    expect(isExternal("docs/a.md")).toBe(false);
    expect(isExternal("#anchor")).toBe(false);
  });
});

describe("checkTarget", () => {
  it("accepts external links without touching the filesystem", () => {
    expect(checkTarget("https://example.com", "README.md", opts)).toBeNull();
  });

  it("resolves a relative file link against the containing document", () => {
    expect(checkTarget("docs/SECURITY.md", "README.md", opts)).toBeNull();
    expect(checkTarget("missing.md", "README.md", opts)).toBe("file does not exist: missing.md");
  });

  it("resolves a same-document bare anchor against the containing document", () => {
    expect(checkTarget("#coverage", "docs/SECURITY.md", opts)).toBeNull();
    expect(checkTarget("#coverage", "README.md", opts)).toContain("missing #coverage");
  });

  it("validates file#anchor combinations across documents", () => {
    expect(checkTarget("docs/SECURITY.md#coverage", "README.md", opts)).toBeNull();
    expect(checkTarget("docs/SECURITY.md#nope", "README.md", opts)).toBe(
      "missing #nope in docs/SECURITY.md",
    );
    expect(
      checkTarget("docs/SECURITY.md#nope", "README.md", { ...opts, anchorsFor: () => new Set<string>() }),
    ).toBeTruthy();
  });

  it("rejects missing root-relative targets and links that escape the repository", () => {
    expect(checkTarget("/nope.md", "README.md", opts)).toContain("does not exist");
    expect(checkTarget("../../etc/passwd", "README.md", opts)).toContain("escapes the repository");
  });

  it("treats a bare '#' fragment as the document itself", () => {
    expect(checkTarget("#", "docs/SECURITY.md", opts)).toBeNull();
  });
});

describe("checkDocument", () => {
  it("collects every broken link with its line number", () => {
    const md = "# T\n\n[ok](docs/SECURITY.md)\n\n[bad](docs/gone.md)\n";
    expect(checkDocument(md, "README.md", opts)).toEqual([
      { file: "README.md", line: 5, href: "docs/gone.md", reason: "file does not exist: docs/gone.md" },
    ]);
  });

  it("finds no problems in the repository's real README", () => {
    const real = {
      fileExists: existsSync,
      anchorsFor: (abs: string) => collectAnchors(readFileSync(abs, "utf8")),
    };
    const md = readFileSync("README.md", "utf8");
    expect(checkDocument(md, "README.md", real)).toEqual([]);
  });
});

#!/usr/bin/env node
/**
 * PR 21: every relative link in the repository's markdown must resolve —
 * both the file it points at and, when given, the `#anchor` inside it.
 * External links (http/https/mailto) are never fetched; this check is
 * offline, deterministic and CI-safe.
 *
 * Skips: fenced code blocks, inline code spans, reference-style link
 * definitions, and bare anchors that only name a same-document heading.
 *
 * Exit codes: 0 all links resolve · 1 at least one broken · 2 read failure.
 *
 * Usage: node scripts/check-doc-links.mjs [file.md ...]
 *        (no arguments → every tracked markdown file in the repository)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested in tests/unit/scripts/check-doc-links.test.ts)
 * ------------------------------------------------------------------ */

/** GitHub-style heading slug. */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/** All anchor targets a markdown document offers: headings + <a name>. */
export function collectAnchors(markdown) {
  const anchors = new Set();
  const stripped = stripFences(markdown);
  for (const line of stripped.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) anchors.add(slugify(heading[1]));
    for (const named of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(named[1]);
    for (const named of line.matchAll(/<a\s+(?:name|id)=([^\s>"]+)/g)) anchors.add(named[1]);
  }
  return anchors;
}

/** Remove fenced code blocks and inline code spans (links inside are docs). */
export function stripFences(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

/**
 * Every markdown link target in a document: [{ raw, href, line }].
 * Definition-style references (`[x]: url`) are captured too.
 */
export function extractLinks(markdown) {
  const links = [];
  const lines = stripFences(markdown).split("\n");
  let inDefinitionBlock = false;
  lines.forEach((line, index) => {
    // A run of `[label]: target` definitions — treat targets as links.
    const def = line.match(/^\s*\[[^\]]+\]:\s+(\S+)\s*$/);
    if (def) {
      links.push({ raw: def[1], href: def[1], line: index + 1 });
      inDefinitionBlock = true;
      return;
    }
    inDefinitionBlock = false;
    void inDefinitionBlock;
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      links.push({ raw: m[1], href: m[1], line: index + 1 });
    }
  });
  return links;
}

/** Classify a target: external links are out of scope for this check. */
export function isExternal(href) {
  return /^(https?:|mailto:|tel:|\/\/)/i.test(href);
}

/**
 * Resolve one relative (or same-document) target against the file that
 * contains it. Returns null when valid, or a reason string when broken.
 * `fileExists` and `anchorsFor` are injectable for tests.
 */
export function checkTarget(href, fromFile, { fileExists, anchorsFor }) {
  if (isExternal(href)) return null;
  const [pathPart, anchor] = href.split("#");
  let targetAbs;
  if (pathPart === "") {
    targetAbs = path.resolve(ROOT, fromFile);
  } else {
    if (/^\//.test(pathPart)) {
      // Root-relative: valid only if it exists under the repository root.
      targetAbs = path.join(ROOT, pathPart);
    } else {
      targetAbs = path.resolve(ROOT, path.dirname(fromFile), pathPart);
    }
  }
  const rel = path.relative(ROOT, targetAbs);
  if (rel.startsWith("..")) return `escapes the repository: ${href}`;
  if (!fileExists(targetAbs)) return `file does not exist: ${href}`;
  if (anchor) {
    const anchors = anchorsFor(targetAbs);
    if (!anchors.has(anchor)) return `missing #${anchor} in ${pathPart || fromFile}`;
  }
  return null;
}

/** Check a whole document. Returns [{ line, href, reason }]. */
export function checkDocument(markdown, fromFile, { fileExists, anchorsFor }) {
  const problems = [];
  for (const { href, line } of extractLinks(markdown)) {
    const reason = checkTarget(href, fromFile, { fileExists, anchorsFor });
    if (reason) problems.push({ file: fromFile, line, href, reason });
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const anchorCache = new Map();
function anchorsFor(absPath) {
  const key = absPath;
  if (!anchorCache.has(key)) {
    anchorCache.set(key, collectAnchors(readFileSync(absPath, "utf8")));
  }
  return anchorCache.get(key);
}
const fileExists = existsSync;

function listMarkdownFiles() {
  const out = execFileSync("git", ["ls-files", "*.md", "*.MD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((rel) => rel.replaceAll(path.sep, "/"));
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args : listMarkdownFiles();
  const problems = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) {
      problems.push({ file: rel, line: 0, href: rel, reason: "file does not exist" });
      continue;
    }
    problems.push(...checkDocument(readFileSync(abs, "utf8"), rel, { fileExists, anchorsFor }));
  }
  if (problems.length > 0) {
    console.error("check:links FAILED — broken relative links:");
    for (const p of problems) console.error(`  - ${p.file}:${p.line} → ${p.href} (${p.reason})`);
    return 1;
  }
  console.log(`check:links ok — ${files.length} markdown files, no broken relative links`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

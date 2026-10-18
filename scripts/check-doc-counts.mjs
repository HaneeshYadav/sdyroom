#!/usr/bin/env node
/**
 * PR 21: documented test counts must match what the repository actually
 * contains. A reviewer should not be able to merge a PR that adds 40 tests
 * while README.md still says 1559.
 *
 * Checked sources (cheap, no test execution):
 *   - unit/integration file counts   → `vitest list --filesOnly`
 *   - e2e totals and per-spec counts → `playwright test --list`
 * Checked sources (need the suite's own JSON reporter output, which CI
 * produces by adding `--reporter=json --outputFile.json=…` to the existing
 * run — zero extra executions):
 *   - unit/integration test totals   → `--unit-json=…` / `--integration-json=…`
 *   - SECURITY.md per-integration-file numbers → `--integration-json=…`
 *
 * Checked documents:
 *   - README.md            "Current suite:" line (files always; totals when
 *                           the matching json is supplied)
 *   - docs/SECURITY.md     every written `tests/… (N)` number (integration Ns
 *                           need --integration-json; e2e Ns are always checked)
 *   - tests/integration/README.md  must mention every integration test file
 *   - tests/e2e/README.md          must mention every e2e spec file
 *
 * Exit codes: 0 all available checks pass · 1 at least one mismatch ·
 * 2 could not read a source.
 *
 * Usage:
 *   node scripts/check-doc-counts.mjs [--unit-json=path] [--integration-json=path] [--print]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ *
 * Pure parsers (unit-tested in tests/unit/scripts/check-doc-counts.test.ts)
 * ------------------------------------------------------------------ */

/**
 * Parse README.md's "Current suite:" paragraph (it wraps onto the next
 * line). Returns null when the expected shapes are missing so a rewritten
 * README fails loudly rather than silently skipping the check.
 */
export function parseReadmeSuiteLine(markdown) {
  const m = markdown.match(
    /Current suite:\s*\*\*(\d+) unit\*\*\s*\((\d+) files\),\s*\*\*(\d+) integration\*\*\s*\((\d+) files\),\s*\*\*(\d+) e2e\*\*\s*\((\d+) specs\)/,
  );
  if (!m) return null;
  return {
    unitTests: Number(m[1]),
    unitFiles: Number(m[2]),
    integrationTests: Number(m[3]),
    integrationFiles: Number(m[4]),
    e2eTests: Number(m[5]),
    e2eSpecs: Number(m[6]),
  };
}

/** Regenerate the README line from observed counts (used by --print). */
export function formatReadmeSuiteLine(c) {
  return (
    `Current suite: **${c.unitTests} unit** (${c.unitFiles} files), ` +
    `**${c.integrationTests} integration** (${c.integrationFiles} files), ` +
    `**${c.e2eTests} e2e**\n(${c.e2eSpecs} specs).`
  );
}

/** Every `tests/… (N)` number written in docs/SECURITY.md's coverage table. */
export function parseSecurityCoverage(markdown) {
  const out = [];
  const re = /`tests\/(integration\/[\w.-]+\.test\.ts|e2e\/[\w.-]+\.spec\.ts)`\s*\((\d+)\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    out.push({ file: `tests/${m[1]}`, suite: m[1].startsWith("integration") ? "integration" : "e2e", count: Number(m[2]) });
  }
  return out;
}

/** Aggregate vitest's json reporter output into totals and per-file counts. */
export function aggregateVitestJson(json) {
  const parsed = typeof json === "string" ? JSON.parse(json) : json;
  const files = {};
  for (const result of parsed.testResults ?? []) {
    const rel = path.relative(ROOT, result.name).replaceAll(path.sep, "/");
    files[rel] = (result.assertionResults ?? []).length;
  }
  return { tests: parsed.numTotalTests, files };
}

/**
 * Parse `playwright test --list` output: totals from the `Total: N tests in
 * M files` footer, per-spec counts from the `› <file>.spec.ts:` prefixes.
 */
export function parsePlaywrightList(text) {
  const total = text.match(/Total:\s+(\d+)\s+tests in\s+(\d+)\s+files/);
  const files = {};
  for (const m of text.matchAll(/›\s+([\w.-]+\.spec\.ts):/g)) {
    files[m[1]] = (files[m[1]] ?? 0) + 1;
  }
  return {
    tests: total ? Number(total[1]) : null,
    specs: total ? Number(total[2]) : null,
    files,
  };
}

/** Human-readable mismatch line, or null when documented === observed. */
export function compareCount(label, documented, observed) {
  if (documented === observed) return null;
  return `${label}: docs say ${documented}, repository has ${observed}`;
}

/** True when `file` is mentioned as a row/entry in the given README. */
export function mentionsFile(markdown, file) {
  const base = path.basename(file);
  return markdown.includes(`\`${base}\``) || markdown.includes(`\`${file}\``);
}

/**
 * Full check pass. `observed` carries every measured number; sources that
 * were not supplied are null and are reported as skipped (never silently).
 * Returns { problems, skipped }.
 */
export function runChecks({ readmeMd, securityMd, integrationReadmeMd, e2eReadmeMd, observed }) {
  const problems = [];
  const skipped = [];
  const doc = parseReadmeSuiteLine(readmeMd);
  if (!doc) {
    problems.push("README.md: could not find the 'Current suite:' line in the expected format");
  } else {
    const pairs = [
      ["README unit file count", doc.unitFiles, observed.unitFiles],
      ["README integration file count", doc.integrationFiles, observed.integrationFiles],
      ["README e2e test count", doc.e2eTests, observed.e2eTests],
      ["README e2e spec count", doc.e2eSpecs, observed.e2eSpecs],
      ["README unit test count", doc.unitTests, observed.unitTests],
      ["README integration test count", doc.integrationTests, observed.integrationTests],
    ];
    for (const [label, d, o] of pairs) {
      if (o === null || o === undefined) {
        skipped.push(`${label} (suite json not supplied — CI verifies it)`);
        continue;
      }
      const problem = compareCount(label, d, o);
      if (problem) problems.push(problem);
    }
  }

  for (const entry of parseSecurityCoverage(securityMd)) {
    const source =
      entry.suite === "e2e"
        ? observed.e2eFiles?.[path.basename(entry.file)]
        : observed.integrationTestFiles?.[entry.file];
    if (source === null || source === undefined) {
      if (entry.suite === "integration") {
        if (observed.integrationTestFiles) {
          problems.push(
            `docs/SECURITY.md: integration entry ${entry.file} (${entry.count}) matches no file in the integration run`,
          );
        } else {
          skipped.push(`docs/SECURITY.md ${entry.file} (${entry.count}) — integration json not supplied`);
        }
      } else {
        problems.push(`docs/SECURITY.md: e2e entry ${entry.file} (${entry.count}) matches no spec in playwright --list`);
      }
      continue;
    }
    const problem = compareCount(`docs/SECURITY.md ${entry.file}`, entry.count, source);
    if (problem) problems.push(problem);
  }

  for (const file of observed.integrationFileList ?? []) {
    if (!mentionsFile(integrationReadmeMd, file)) {
      problems.push(`tests/integration/README.md: no row for ${file}`);
    }
  }
  for (const file of observed.e2eFileList ?? []) {
    if (!mentionsFile(e2eReadmeMd, file)) {
      problems.push(`tests/e2e/README.md: no row for ${file}`);
    }
  }

  return { problems, skipped };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function vitestFileList(config) {
  const args = ["vitest", "list", "--filesOnly"];
  if (config) args.push("-c", config);
  const out = execFileSync("npx", args, { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim().replace(/^\[[^\]]+\]\s+/, ""))
    .filter((line) => line.length > 0);
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  const unitFiles = vitestFileList(undefined);
  const integrationFileList = vitestFileList("vitest.integration.config.ts");
  const playwright = parsePlaywrightList(
    execFileSync("npx", ["playwright", "test", "--list"], { cwd: ROOT, encoding: "utf8" }),
  );

  const observed = {
    unitFiles: unitFiles.length,
    integrationFiles: integrationFileList.length,
    integrationFileList,
    e2eTests: playwright.tests,
    e2eSpecs: playwright.specs,
    e2eFiles: playwright.files,
    e2eFileList: Object.keys(playwright.files).map((base) => `tests/e2e/${base}`),
    unitTests: null,
    integrationTests: null,
    integrationTestFiles: null,
  };

  const unitJson = flag("unit-json");
  if (unitJson && existsSync(unitJson)) {
    observed.unitTests = aggregateVitestJson(readFileSync(unitJson, "utf8")).tests;
  }
  const integrationJson = flag("integration-json");
  if (integrationJson && existsSync(integrationJson)) {
    const agg = aggregateVitestJson(readFileSync(integrationJson, "utf8"));
    observed.integrationTests = agg.tests;
    // SECURITY.md's per-file integration numbers come from the run itself —
    // `vitest list` does not expand it.each templates and would undercount.
    observed.integrationTestFiles = agg.files;
  }

  if (args.includes("--print")) {
    const line = formatReadmeSuiteLine({
      unitTests: observed.unitTests ?? "?",
      unitFiles: observed.unitFiles,
      integrationTests: observed.integrationTests ?? "?",
      integrationFiles: observed.integrationFiles,
      e2eTests: observed.e2eTests,
      e2eSpecs: observed.e2eSpecs,
    });
    console.log(line);
    return 0;
  }

  const { problems, skipped } = runChecks({
    readmeMd: read("README.md"),
    securityMd: read("docs/SECURITY.md"),
    integrationReadmeMd: read("tests/integration/README.md"),
    e2eReadmeMd: read("tests/e2e/README.md"),
    observed,
  });

  for (const note of skipped) console.log(`check:counts skip  ${note}`);
  if (problems.length > 0) {
    console.error("check:counts FAILED — documented counts drifted from reality:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("Update the named document (or the tests) so they agree, then rerun.");
    return 1;
  }
  console.log(
    `check:counts ok — unit ${observed.unitFiles} files` +
      (observed.unitTests !== null ? `/${observed.unitTests} tests` : "") +
      `, integration ${observed.integrationFiles} files` +
      (observed.integrationTests !== null ? `/${observed.integrationTests} tests` : "") +
      `, e2e ${observed.e2eSpecs} specs/${observed.e2eTests} tests`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

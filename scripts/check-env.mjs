#!/usr/bin/env node
/**
 * Environment drift check (spec PR 18).
 *
 * Every `process.env.X` the application code reads must appear in
 * `.env.example` — the file a new contributor copies. The check is pure
 * static analysis and needs no secrets, so CI can run it on every push.
 *
 * Exit 0: no drift. Exit 1: keys referenced in code are missing from
 * `.env.example` (listed). Keys present in the example but never referenced
 * are reported as a warning only — an intentionally documented knob is fine.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

/** Read through a computed name — see `lib/ai/config.ts` (`process.env[name]`). */
const DYNAMIC_KEYS = ["AI_EMBED_MODEL", "AI_CHAT_MODEL"];

/** Provided by the deployment platform, never by a local `.env` file. */
const PLATFORM_KEYS = new Set(["VERCEL_URL"]);

const STATIC_REF = /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g;
const BRACKET_REF = /\bprocess\.env\["([A-Z][A-Z0-9_]*)"\]/g;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) yield full;
  }
}

const referenced = new Set(DYNAMIC_KEYS);
// Application code only: scripts are operator tools whose own knobs
// (SMOKE_BASE_URL, LOAD_TOTAL, …) are not deployment configuration.
const scanRoots = ["lib", "app"]
  .map((dir) => path.join(root, dir))
  .filter((dir) => {
    try {
      readdirSync(dir);
      return true;
    } catch {
      return false;
    }
  });

for (const dir of scanRoots) {
  for (const file of walk(dir)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(STATIC_REF)) referenced.add(match[1]);
    for (const match of source.matchAll(BRACKET_REF)) referenced.add(match[1]);
  }
}
for (const file of ["instrumentation.ts", "proxy.ts"]) {
  const full = path.join(root, file);
  try {
    const source = readFileSync(full, "utf8");
    for (const match of source.matchAll(STATIC_REF)) referenced.add(match[1]);
    for (const match of source.matchAll(BRACKET_REF)) referenced.add(match[1]);
  } catch {
    // Optional file.
  }
}

const examplePath = path.join(root, ".env.example");
let exampleKeys;
try {
  exampleKeys = readFileSync(examplePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split("=")[0].trim());
} catch {
  console.error("check:env — .env.example is missing");
  process.exit(1);
}

const exampleSet = new Set(exampleKeys);
const required = [...referenced].filter((key) => !PLATFORM_KEYS.has(key)).sort();
const missing = required.filter((key) => !exampleSet.has(key));
const unused = exampleKeys.filter((key) => !referenced.has(key)).sort();

if (missing.length > 0) {
  console.error("check:env — keys referenced in code but missing from .env.example:");
  for (const key of missing) console.error(`  - ${key}`);
  process.exit(1);
}

if (unused.length > 0) {
  console.warn("check:env — keys in .env.example never referenced (warning only):");
  for (const key of unused) console.warn(`  - ${key}`);
}

console.log(`check:env — ok (${required.length} keys covered by .env.example)`);

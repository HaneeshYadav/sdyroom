# Development

Practical day-to-day guide. The database deep-dive lives in
[`docs/local-supabase.md`](local-supabase.md); the operational contract for
agents and reviewers lives in [`AGENTS.md`](../AGENTS.md). Security claims
and API contracts live in [`docs/SECURITY.md`](SECURITY.md) and
[`docs/API_CONTRACTS.md`](API_CONTRACTS.md) — this file does not restate
them.

## First setup

```bash
npm install                 # exact versions from the lockfile; do not bump casually
npx supabase start          # local stack (Docker; see docs/local-supabase.md)
npx supabase db reset       # migrations in order + supabase/seed.sql
cp .env.example .env.local  # then fill the Supabase URL/key from `npx supabase status`
npm run dev                 # http://localhost:3000
```

Sign-up needs email confirmation locally — see the "Email confirmation"
section of `docs/local-supabase.md`. `.env.example` is the authoritative
key list; `npm run check:env` fails when the code reads a key the example
does not document.

## Running the suites

| Suite | Command | Needs | Notes |
| --- | --- | --- | --- |
| Lint | `npm run lint` | — | Zero errors, zero warnings. Baseline suppressions are listed in `AGENTS.md`; do not add more. |
| Types | `npx tsc --noEmit` | — | |
| Unit | `npm test` | — | vitest, node environment; DOM component tests included via jsdom-style rendering. |
| Unit + coverage | `npm run test:coverage` | — | Measures `lib/**` + `app/api/**` only; floors are statements 74% / branches 64%. |
| Integration | `npm run test:integration` | local stack running + `db reset` | Real auth users over HTTP and SQL. No DOM assertions. |
| E2E | `npm run test:e2e` | local stack running + `db reset` | Playwright Chromium; the dev server is started by the Playwright config. |
| Build | `npm run build` | — | Must pass without any Supabase reachable. |
| Smoke | `npm run smoke` | a running production build (`npm run start`) | Probes health, readiness, metrics and the error envelope. |

Doc gates (run when you touch tests or markdown):

```bash
npm run check:counts        # add -- --unit-json=… / --integration-json=… after a run for totals
npm run check:links
```

## Adding a migration

1. Number it as the next file in `supabase/migrations/` (`NNNN_snake_case.sql`).
   **Never edit a migration that has merged** — add a new one that supersedes
   it (expand/contract pattern if a column must go away).
2. Revoke-first: `revoke … from …;` then `grant …`, so privilege widening is
   a visible, deliberate diff.
3. Enable RLS on every new table and write explicit policies; narrow column
   grants to what the routes actually read or write.
4. `SECURITY DEFINER` functions only with a comment justifying the definer
   rights and integration tests that pin the grant surface.
5. Apply with `npx supabase db reset`, then run `npm run test:integration`.
   Update `docs/local-supabase.md`'s schema/grant sections and any
   `docs/SECURITY.md` counts that changed — `check:counts` verifies the
   test-count side.

## Adding an endpoint

1. **Schema first.** zod schema in `lib/validation/**`, `.strict()`, trim
   before length checks, blank optionals normalised to `null`.
2. **Route.** `app/api/**` stays thin: parse → validate → call `lib/**` →
   return the envelope. Read identity from the session claims, never from
   the body.
3. **Rate limit**, if the route writes or spends resources: take a slot from
   `lib/rate-limit/keys.ts` after validation and before the write; document
   the `429` in the route's JSDoc table and in `docs/API_CONTRACTS.md`.
4. **Errors.** Map to the shared envelope (`code` + user-facing English
   message); `404 not_found` for "missing or not yours"; no SQL detail
   leaks. Server logging goes through `lib/server/log.ts`, never `console.*`.
5. **Tests.** Unit: status/code matrix including every error branch
   (`tests/unit/**` with a mocked client). Integration: the real route with
   real users (`tests/integration/**`). E2E only when a user journey
   changes.
6. **Docs.** The route's section in `docs/API_CONTRACTS.md`, any security
   claim in `docs/SECURITY.md`, and the README endpoint table if the route
   is user-facing.

## Style and conventions

- Exact dependency versions in `package.json` (no `^`/`~` ranges).
- Conventional-commit messages; the PR title usually mirrors the branch.
- Dates in prose are ISO (`YYYY-MM-DD`).
- Comments explain *why*, not *what*; route and migration files carry a
  short header doc-comment describing their contract.
- Feature specs and their checkboxes live in `docs/prs/*`; landed history in
  `docs/milestones.md`; remaining work in `docs/PR_ROADMAP.md`.

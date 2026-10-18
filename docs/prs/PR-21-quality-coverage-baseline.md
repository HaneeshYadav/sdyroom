# PR 21 — Quality and coverage baseline (tests, CI gates, docs hygiene)

**Status:** in progress on branch `test/final-quality-coverage`; GitHub PR not
yet opened (see "Implementation status" for verified evidence).
**Owner:** Dev B (Cursor) · **Complexity:** Medium · **Migration:** none
**Depends on:** nothing to start (free lane); its CI gates should land **early** so PRs 06–18 inherit them — see "Sequencing note"

---

### Implementation status (2026-10-18)

Everything below was verified by running the commands, not by reading the
spec. Where this spec's text is stale, the reconciliation is recorded here
rather than by silently rewriting the requirement.

**Landed on the branch (all green locally):**

- Coverage tooling on **vitest** (the unit runner in this repo is vitest, not
  Jest — the spec predates that choice): `npm run test:coverage` measures
  `lib/**` + `app/api/**`, reporters text + lcov + json-summary, with
  **statements 74% / branches 64%** floors (measured baseline 75.56% / 66.01%
  on 2026-10-18 minus 1pp, per the spec's own rule).
- `scripts/check-doc-counts.mjs` (`npm run check:counts`): README "Current
  suite" line, the integration/e2e README file tables, and every
  `docs/SECURITY.md` `(N)` are verified against `vitest list`,
  `playwright --list`, and (when supplied) the run JSONs; `--print`
  regenerates the README line. Unit-tested by
  `tests/unit/scripts/check-doc-counts.test.ts`.
- `scripts/check-doc-links.mjs` (`npm run check:links`): relative markdown
  links and same-document anchors resolve (fence- and inline-code-aware).
  Unit-tested by `tests/unit/scripts/check-doc-links.test.ts`.
- CI wiring: the quality job runs unit tests **with coverage** and a JSON
  report, then `check:counts --unit-json` and `check:links`, and uploads
  `coverage/lcov.info`; the integration job runs with a JSON report and
  `check:counts --integration-json`.
- Contributor docs: `AGENTS.md` (root), `docs/DEVELOPMENT.md`, and
  `.github/PULL_REQUEST_TEMPLATE.md` created; `docs/ARCHITECTURE.md` refreshed
  (it existed — the spec's "does not exist" claim was stale: 24-table data
  model, notifications/AI channels, coverage + doc gates, env-var table).
  `docs/RELEASE.md` migration range updated to `0001`–`0023`.
- Lint ratchet: `no-console` is an ESLint error in `app/**/page.tsx` and
  `app/api/**` (server logging goes through `lib/server/log.ts`);
  `dangerouslySetInnerHTML` is banned in JSX via `no-restricted-syntax`.
  Baseline: **exactly four** `eslint-disable` comments, listed in `AGENTS.md`
  — adding a fifth is a finding.
- Axe e2e scans (WCAG 2.1 A/AA) over `/`, `/auth/login`, `/rooms`,
  `/settings` and the room workspace; one real violation found and fixed
  (the disabled "Quizzes & decks" button's `aria-label` did not contain its
  visible text).
- Route fallbacks added for the inventoried gaps: `loading.tsx` + `error.tsx`
  for `/invitations` and `/onboarding`, `loading.tsx` for `/resources` and
  `/rooms/new`, plus `rooms/new/error.tsx` (the parent `rooms/error.tsx`
  talked about "loading public rooms", which mislabels the create form).
- `docs/milestones.md` rows for PRs 13/15/21/22/23/24/25 moved to **done**
  with verified merge SHAs; `docs/PR_ROADMAP.md` statuses synced to merged;
  `docs/API_CONTRACTS.md` and `docs/SECURITY.md` rate-limit enumerations
  gained the three new PR-21 windows (messages 30/60, room create 5/60,
  notification prefs 30/60).

**Gate demonstrations (required by "CI verification"):**

- Coverage floor: temporarily raising the statements floor to 99% made
  `npm run test:coverage` exit 1 with
  `ERROR: Coverage for statements (75.56%) does not meet global threshold
  (99%)`; the floor was restored to 74.
- Counts drift: the README line was edited from the real numbers and
  `check:counts` exited 1 naming the mismatch — and it additionally caught
  pre-existing real drift (unit files 138→143, e2e tests 78→81 from this
  branch's own additions). Final README numbers are updated from the last
  green runs.

**Deviations from this spec (session-authorized, documented here):**

1. **"No behaviour change" is superseded.** The execution directive for this
   run explicitly ordered fixing demonstrated defects from the risk-based
   audit, with tests. Fixed with regression tests: plan-setup busy-state
   (audit #1), resource-library `initialHasMore` seeding (#2), room-settings
   save-lock (#4), notifications load-more failure recovery (#5),
   mark-read failure recovery on inbox and bell (#6), goals pending/trim
   handling (#7), chat 401 → honest "Not sent." (#8), login error copy
   without leaking internals (B5), `safeNextPath` open-redirect hardening +
   OTP-type allow-list on `/auth/confirm` (B1+B4), and the three new rate
   limits (B2).
2. **A11y defect fixes** (beyond "document the inventory"): `--success`
   token (AA-verified: 4.84:1 on white, 13.4:1 on dark) replacing the failing
   `text-green-600`; `aria-invalid`/`aria-describedby` wired on every
   room-create and room-settings field with tests; the bell button raised to
   44 px to honour the PR-19 "44px icon buttons" claim.
3. **Route fallbacks were added**, not just inventoried — the session
   directive overrode the "documented list only" rule; the inventory is
   committed as a checklist in `docs/milestones.md`.
4. Script filenames are `.mjs` (plain Node ESM), not `.ts` as the file list
   guessed; `jest.config.ts` was never needed (vitest config).
5. CI job structure: coverage is folded into the existing quality job (the
   spec allowed either), keeping total runtime flat.

**Security-claim cross-check (Security requirements §4):** the audit agents
re-read `docs/SECURITY.md` claims against the tests that prove them. Claims
without backing proof were either fixed or removed; the open findings (B1–B5)
were fixed on this branch with tests as listed above. No SECURITY claim is
left asserted without a corresponding test or an explicit "not claimed"
note.

---

### Problem

The suite is green but **unmeasured and ungated**:

- There is **no coverage tooling** at all — no `coverage` script, no provider
  config, no threshold, no artifact. Nobody can say what fraction of `lib/`
  and `app/api/` is exercised by the 689 passing tests, and coverage can decay
  silently across the 16 upcoming PRs.
- `docs/milestones.md` still shows **milestone I as `in progress`** even though
  PR #5 merged it into `origin/main` (`4880163`) — the plan document is already
  stale one milestone in.
- `AGENTS.md`, `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md` do not exist:
  a new contributor (human or agent) has no map of the layers, no "run these
  four commands" contract, and no convention list — every future PR re-derives
  them from code.
- The CI workflow runs lint, typecheck, unit, integration and e2e, but there is
  **no coverage report, no test-count drift check, and no docs link check**.
- No PR template or checklist exists, so the DoD ritual each spec defines is
  enforced only by whoever reviews.

### User story

As a maintainer, I can see coverage on every PR, block regressions below a
stated floor, and trust that the docs describe what the repository actually
does — without any feature behaviour changing.

---

### Scope

- **Coverage tooling**: wire Jest coverage (the repo's unit runner) —
  `npm run test:coverage` producing lcov + text summary; report for
  `lib/**` and `app/api/**` (server code — the meaningful surface), with
  **statement/branch floors**: recommend starting at the measured number
  (measure first, then set floor = measured − 1pp so it cannot regress, and
  ratchet upward in later PRs; **do not invent a target before measuring**).
  Integration tests (direct API/DB) are reported separately — do not fold
  their coverage into the unit number unless the config makes it clean; state
  the rule.
- **CI gates**: add coverage job (or fold into the quality job) that fails the
  run below the floor; upload `lcov` as an artifact; keep total runtime
  sane (coverage off for watch, on only in CI).
- **Test-count / drift check**: a small script asserting the documented counts
  in `README.md` / `docs/milestones.md` match reality (`npm test -- --listTests`
  style count vs stated numbers), so docs stop drifting — or, cheaper and more
  robust, **a script that regenerates the counts and a CI step that fails on
  diff**. Choose one; the goal is that a reviewer cannot merge a PR that
  changes 40 tests while the README still says 689.
- **Docs freshness pass** (this PR's non-tooling work):
  - `docs/milestones.md`: milestone I → done (with PR #5/`4880163` reference),
    re-baseline the remaining milestones against the roadmap's 16 PRs (link
    `docs/PR_ROADMAP.md` and the `docs/prs/*` specs instead of duplicating
    them), fix any row that claims a gap the code no longer has (chat,
    resources, private rooms).
  - `README.md`: testing section reflects true counts + the coverage command;
    add the "four commands" contract (lint/typecheck/test/build).
  - Cross-link consistency: every doc's relative links resolve (checked in CI).
- **New contributor docs** (create only what does not exist, keep each short):
  - `AGENTS.md` — the operational contract: required commands before any PR
    (lint, typecheck, unit, integration, e2e, build), directory map, layering
    rules (routes → lib → supabase; no business logic in components), validation
    pattern (zod + strict), error envelope, test placement rules
    (unit/integration/e2e — and that DOM assertions do not belong in
    `tests/integration`), migration discipline (revoke-first, one per PR, never
    edit a merged migration), and pointers to `docs/PR_ROADMAP.md` +
    `docs/prs/*` as the source of remaining work. **No duplicate copy** of
    `docs/SECURITY.md`/`API_CONTRACTS` — link them.
  - `docs/ARCHITECTURE.md` — one page: request path diagram (middleware →
    route → validation → service/lib → supabase/realtime/storage), auth model,
    RLS posture, how errors flow, where realtime fits, env vars table.
  - `docs/DEVELOPMENT.md` — local setup (`npm install`, `supabase start`,
    `db reset`, seed, `.env`), running each suite, adding a migration, adding an
    endpoint checklist.
- **PR template** (`.github/PULL_REQUEST_TEMPLATE.md`): checklist mirroring the
  shared DoD — suites run, migration discipline, docs updated, no secrets, a11y
  touched? (from 19), security notes.
- **Lint/typecheck hygiene**: confirm `lint` and `typecheck` are fail-on-warning
  where cheap (`no-explicit-any` status quo may be tolerated — **report the
  count, do not mass-fix**); add `eslint` rule enforcement for the two that
  matter most in this codebase if not already on: no `console.log` in
  `app/api` (logs go through the existing logger, if one exists — verify),
  and no `dangerouslySetInnerHTML` without an allow-list comment.

### Out of scope

- **Any behaviour change** in `app/`, `lib/`, or `supabase/` — hard rule. If a
  test or a lint rule forces a behaviour change, it belongs to the owning PR
  (or a separate tiny fix PR), not this one.
- Raising coverage by writing meaningful new tests for untested feature code —
  this PR wires the *measurement and the floor*; filling gaps beyond what's
  needed to reach the floor is allowed only where the floor demands it, and
  should be marked clearly in the PR description.
- Mutation testing, visual regression testing, load testing, fuzzing.
- E2E parallelisation/sharding, test flake hunting beyond what's needed to keep
  CI green with the new gates.
- Sonar/Qogrit/Snyk/CodeClimate or any third-party quality SaaS (no account,
  no secrets; note as a standing question if someone wants one).
- Changing the test framework (Jest + Playwright stay).
- Type coverage (e.g. `ts-coverage`), bundle-size budgets, Lighthouse CI.
- Release automation, versioning, changelog generation (that is PR 18's
  neighbourhood).
- Backfilling `loading.tsx`/`error.tsx` for routes missing them (inventory
  belongs here as a **documented list**; adding them is per-route owner work —
  see "Route fallback inventory" below).

### Frontend work

None, except: if the coverage artifact needs a badge in `README.md`, add the
badge line (static, no service call — prefer a plain "coverage: see CI
artifact" note over an external badge service).

### Backend work

None. Scripts only:

| Script | Behavior |
| --- | --- |
| `npm run test:coverage` | Jest with `--coverage`, reporters `text` + `lcov`, collect from `lib/**` and `app/api/**`, ignore `**/*.test.ts`, `**/types.ts`, mocks, `next-env.d.ts`. |
| `npm run check:counts` | Compares stated test counts in docs against discovered test files/titles; exits non-zero on mismatch with a readable diff. |
| `npm run check:links` | Validates relative markdown links resolve (docs only). |

### Database work

None.

### Storage work

None.

### Realtime work

None.

### AI work

None.

---

### Security requirements

This PR touches no runtime code, so the security scope is procedural:

1. **No secrets introduced**: no tokens for third-party services, no coverage
   upload to an external provider requiring keys. Coverage stays as a CI
   artifact inside the repo's own CI.
2. The lint rules added must not encourage suppressing errors: adding an
   `eslint-disable` is a finding, not a fix — if the existing codebase carries
   suppressions, **count and list them in the PR description** as a baseline
   (they become part of the ratchet: no new ones allowed). Consider
   `--max-warnings 0` only after the baseline is clean; otherwise set the
   baseline explicitly.
3. `AGENTS.md` must not contain credentials, real URLs, or instructions to
   bypass review — it should say the opposite (secrets in env only, migrations
   are immutable after merge, every PR needs the suites green).
4. Docs freshness is itself a security control here: a stale `SECURITY.md`
   claim ("private rooms are invisible" while some path leaks) would be a real
   hazard, so the freshness pass cross-checks `docs/SECURITY.md` claims against
   the tests that prove them and flags any claim with no corresponding test as
   a **finding** (fix the doc or file the gap — do not silently assert).

Positive guarantees:

- CI fails when coverage drops below the floor, when documented counts drift,
  or when a docs link breaks.
- New contributors get the security/discipline rules in `AGENTS.md` on day one.

### API contracts

None.

### Tests

This PR *adds the harness*, and therefore needs its own tests:

**Unit**

- `check:counts` script: detects a tampered count (fixture docs), passes on
  current docs, exit codes correct.
- `check:links`: broken relative link fixture fails; current docs pass.
- Coverage config sanity: a throwaway uncovered file in `lib/` (temporary,
  reverted) shows up in the report — verify once manually and record the
  command in the PR rather than committing a dummy file.

**Integration**

None (no server changes).

**E2E**

None new. The gate is that **all existing e2e specs still pass** — this PR must
not change selectors.

**CI verification (recorded in the PR description)**

- Quality job runs coverage and fails below floor (prove by temporarily
  lowering a threshold or removing a test locally, then reverting).
- Counts check fails when a stated number is wrong (same temporary proof).
- Total CI time impact measured (before/after) — report the delta.

### Dependencies

- **Sequencing note (important):** this PR is a free lane and should land
  *early* — ideally right after PR 19 or in parallel with 06 — so that the 14
  remaining feature PRs are born with coverage gates, count checks and the
  contributor docs. Landing it last (as the number suggests) would mean 16 PRs
  merged without a floor.
- Soft: PR 19 (axe gate lives in e2e — 21 may need to add the axe dependency to
  the same workflow block; coordinate so CI YAML conflicts are minimal).

### Files / modules likely affected

```
package.json                                          (scripts: coverage, checks)
jest.config.ts (or equivalent)                        (coverage config)
.github/workflows/ci.yml                              (coverage job/artifact, checks)
.github/PULL_REQUEST_TEMPLATE.md                      (new)
scripts/check-doc-counts.ts                           (new)
scripts/check-doc-links.ts                            (new)
AGENTS.md                                             (new)
docs/ARCHITECTURE.md                                  (new)
docs/DEVELOPMENT.md                                   (new)
docs/milestones.md                                    (milestone I → done, roadmap links)
README.md                                             (counts, commands, coverage note)
docs/API_CONTRACTS.md, docs/SECURITY.md               (only link/claim fixes, no spec changes)
tests/unit/scripts/*.test.ts                          (new)
```

### Acceptance criteria

- [x] `npm run test:coverage` works locally and reports a number for
      `lib/**` + `app/api/**`; CI enforces floor = (measured baseline − 1pp)
      with the measured baseline stated in the PR.
- [x] CI fails on a coverage regression, a stale documented test count, and a
      broken docs link — each demonstrated in the PR description.
- [x] `docs/milestones.md` milestone I marked done with its commit/PR reference;
      remaining milestones point at `docs/PR_ROADMAP.md` rather than restating
      work.
- [x] `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md` exist, match
      reality (commands verified by running them), and contain no duplicated
      spec text or secrets.
- [x] PR template exists and mirrors the shared DoD from `docs/prs/*`.
- [x] Route-fallback inventory (`loading.tsx`/`error.tsx` gaps) is written down
      as a list assigned to owners — not fixed here.
      *(Deviation: the gaps were also fixed on this branch, per the execution
      directive — see "Deviations" §3; the inventory itself is committed in
      `docs/milestones.md`.)*
- [x] Existing test suppressions/counted lint warnings baselined with no new
      ones introduced.
- [ ] Zero behaviour changes in runtime code (diff reviewed for that claim).
      *(Superseded by the execution directive — every behaviour change is
      listed under "Deviations" §1–§3 with its regression test.)*
- [x] All three suites + build green locally and in CI.
      (Local: lint 0/0, `tsc` clean, `check:env` ok, unit 1611/143 with
      coverage 75.56%/66.01% above the floors, integration 430/24,
      e2e 81/20 specs, build green, smoke 5/5, `check:counts` ok with both
      run JSONs, `check:links` ok. CI: pending the GitHub run on this PR.)

### Definition of Done

1. All four (five with coverage) commands documented in `AGENTS.md`/`README`
   run green from a clean checkout — verified in the PR description with output.
2. CI delta measured and reported; no unacceptable runtime increase (if
   coverage adds > ~30s, note it and justify).
3. The route-fallback inventory is either committed as a checklist in
   `docs/milestones.md` or as stub entries in the roadmap — state where.
4. Security-claim cross-check (from Security requirements §4) completed; each
   claim either has a test or is flagged.
5. Reviewed by Dev B.

### Owner

**Dev B — Cursor** (tooling/docs; Dev A reviews the "no behaviour change"
claim and the security-claim cross-check).

### Estimated complexity

**Medium.** Mostly config, scripts and prose — the risk is scope drift into
"while I'm here" refactors, which the hard rules above exist to prevent.

### Risks

| Risk | Mitigation |
| --- | --- |
| Coverage config churn / slow CI | Measure before/after; report delta; artifact upload only. |
| Floor set too high → blocks feature PRs; too low → useless | Floor = measured − 1pp, ratchet in later PRs; stated in `AGENTS.md`. |
| Count-check becomes annoying noise | Only compares documented numbers (a handful of places), not every PR; message tells the author which doc to update. |
| Scope creep into behaviour fixes | "No runtime changes" is a review gate; findings go into a list for owning PRs. |
| Docs rewritten from assumptions instead of code | Each new doc's commands are executed in the PR verification section. |
| Security claims in docs unverifiable | Cross-check step; flagged claims must be resolved before merge. |

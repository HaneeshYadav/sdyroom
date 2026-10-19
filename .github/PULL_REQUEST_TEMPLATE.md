<!-- Spec (if any): docs/prs/PR-NN-*.md — link it and copy its acceptance
     criteria into a checklist below. Landed history: docs/milestones.md. -->

## What and why

<!-- One paragraph: the user-visible outcome and the reason. -->

## Checklist

### Gates (all required)

- [ ] `npm run lint` — zero errors, zero warnings (no new `eslint-disable`;
      the baseline is listed in `AGENTS.md`)
- [ ] `npx tsc --noEmit` — clean
- [ ] `npm test` — unit suite green
- [ ] `npm run test:integration` — green against the local stack
      (skip with a written reason if the PR cannot touch server behaviour)
- [ ] `npm run test:e2e` — green (skip with a written reason; selectors
      shared across suites — do not change them casually)
- [ ] `npm run build` — green without any Supabase reachable
- [ ] `npm run check:env` — green if env/docs could have drifted
- [ ] `npm run test:coverage` — floors hold (statements ≥ 74%,
      branches ≥ 64%); lowering a floor needs a written reason here

### If you touched tests or docs

- [ ] `npm run check:counts` passes (README "Current suite", the integration
      and e2e README tables, and any changed `docs/SECURITY.md` `(N)`)
- [ ] `npm run check:links` passes (relative markdown links resolve)

### If you touched the database

- [ ] New migration only — no merged migration edited
- [ ] Revoke-first; RLS enabled with explicit policies; column grants
      narrowed; `SECURITY DEFINER` justified in a comment
- [ ] `npx supabase db reset` applies cleanly and the integration suite
      proves the new surface
- [ ] `docs/local-supabase.md` schema/grant notes updated where they describe
      what changed

### If you touched a route or a contract

- [ ] zod schema `.strict()`; identity from the session, never the body
- [ ] Errors use the shared envelope; `404 not_found` stays the answer for
      "missing or not yours"
- [ ] Rate limit taken (after validation, before the write) and the `429`
      documented in the route JSDoc and `docs/API_CONTRACTS.md`
- [ ] `docs/API_CONTRACTS.md` / `docs/SECURITY.md` claims updated — a stale
      security claim is a bug

### If you touched the UI

- [ ] Accessibility: labels/`aria-*` wired, errors `role="alert"` and tied
      to their fields, keyboard-operable, no new axe violations
      (`tests/e2e/responsive-a11y.spec.ts` scans the main surfaces)
- [ ] No new `console.*` in `app/**/page.tsx` or `app/api/**`
      (use `lib/server/log.ts`)

### Hygiene

- [ ] No secrets, tokens, or real personal data in code, docs, tests, or
      commit messages
- [ ] No unrelated refactors mixed in
- [ ] Behaviour changes beyond the spec are listed and justified above

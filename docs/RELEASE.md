# Release runbook

Launch checklist, environment matrix, retention and backup/restore drills for
SdyRoom. Everything here assumes the deploy target is Vercel + Supabase
hosted; the local stack (`docs/local-supabase.md`) is for development and CI
only.

## Launch checklist

Work top to bottom; each item names the command or evidence that proves it.

1. **Environment matrix complete.** Every key in the matrix below is set in
   the production project (Vercel → Settings → Environment Variables), and
   `npm run check:env` passes in CI (the `quality` job runs it on every push).
2. **Migrations applied.** `supabase db push` (or the hosted SQL editor for
   each file in order) has applied `0001`–`0022`. Verify:
   `select count(*) from supabase_migrations.schema_migrations;` matches the
   number of files in `supabase/migrations/`.
3. **Health endpoints answer.** After the first production deploy:
   - `GET /api/health` → `200 { status: "ok", version, uptime_s }` — liveness,
     no dependency contact.
   - `GET /api/health/ready` → `200 { status: "ok", checks: { db: "ok",
     storage: "ok" } }` — readiness against the hosted project.
   - `GET /api/metrics` → `200` with `window_s: 300`, `instance: "single"`.
4. **Smoke run against production.** `npm run smoke` with
   `SMOKE_BASE_URL=https://<your-domain>` — all five checks green.
5. **Load sanity.** `npm run load:sanity` with `LOAD_BASE_URL` set; record
   the p50/p95/p99 table in the PR or release notes. This is a smoke-level
   signal on one machine, not a capacity study — say so wherever you paste it.
6. **Backup + restore drill executed and dated.** See the drill section
   below. An undated drill is not a drill.
7. **Retention scheduled.** The `prune_notifications(before)` SQL function
   exists but has no scheduler; either schedule it (Supabase → Database →
   Cron / a scheduled Edge Function) or accept unbounded notification growth
   as a documented limitation with an owner.
8. **Error correlation verified in production logs.** Trigger one deliberate
   error (e.g. `POST /api/rooms` with an invalid body while unauthenticated);
   confirm the response's `request_id` appears in the platform log stream on
   the matching line, and that no `authorization`/`cookie` value is present
   in any captured line.
9. **Rollback rehearsed.** Know the platform's rollback button and the
   migration-down path before you need either.

## Environment matrix

Authoritative list: `.env.example`. `npm run check:env` fails the build on
drift between the codebase's `process.env` reads and this file.

| Key | Required in production | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Hosted project URL (https). |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | `sb_publishable_*` / legacy anon key — never a secret key. |
| `AI_PROVIDER` | yes | `openai` or `mock`; `mock` is acceptable only for demos. |
| `AI_API_KEY` | yes | Server-side only; never exposed to the browser. |
| `AI_BASE_URL` | no | Override for proxies/self-hosted providers. |
| `AI_MAX_INGEST_BYTES` | no | Defaults in code; set to cap upload size for AI ingest. |
| `AI_EMBED_MODEL` / `AI_CHAT_MODEL` | no | Dynamic — read via `process.env[name]`; set when the default model is retired. |
| `VERCEL_URL` | platform | Set by Vercel automatically; used for absolute URL construction. |

Secrets belong in the platform's secret store, never in `.env` files committed
to the repository.

## Backup and restore drill

Run the drill **before** launch and repeat it quarterly. Record the date, the
operator and the measured restore duration in the table at the bottom.

### Take a backup (local stack)

```sh
# Full logical dump of the local database (includes storage schema metadata).
docker exec -e PGPASSWORD=postgres supabase_db_sdyroom \
  pg_dump -U postgres -d postgres -Fc \
  -f /tmp/sdyroom-$(date +%Y%m%d).dump

docker cp supabase_db_sdyroom:/tmp/sdyroom-$(date +%Y%m%d).dump ./sdyroom.dump
```

For hosted projects: use the Supabase dashboard's scheduled backups, and take
an on-demand backup before every migration that touches data.

### Restore into a scratch database and verify

A bare `postgres` image is **not** enough: the dump references the Supabase
roles (`anon`, `authenticated`, `service_role`, …) in grants and policies, and
`document_chunks.embedding` needs pgvector. Use the pgvector image with the
same major version as the source, and pre-create the roles:

```sh
# Same major version as the local stack (17.x) with pgvector built in.
docker run -d --name sdyroom-restore-drill -e POSTGRES_PASSWORD=postgres \
  -p 55432:5432 pgvector/pgvector:pg17

# Wait for readiness, then create the roles the dump grants to.
for i in $(seq 1 30); do docker exec sdyroom-restore-drill pg_isready -U postgres && break; sleep 1; done
docker exec -e PGPASSWORD=postgres sdyroom-restore-drill psql -U postgres -d postgres -c \
  "do \$\$ declare r text; begin foreach r in array array['anon','authenticated','service_role','supabase_admin','supabase_auth_admin','supabase_storage_admin','supabase_functions_admin','supabase_realtime_admin','dashboard_user','pgbouncer','pgsodium_keyholder','pgsodium_keyuser'] loop begin execute format('create role %I nologin', r); exception when duplicate_object then null; end; end loop; end \$\$;"

docker exec -i sdyroom-restore-drill pg_restore -U postgres -d postgres < sdyroom.dump
```

`pg_restore` exits non-zero with a small number of errors that are expected
in a scratch container and do not affect the application's schema or data:
grants to the `vault` schema (the `supabase_vault` extension is not
installed) and `ALTER … OWNER TO` on platform event triggers. Anything else
is a drill failure.

Spot-checks — each must equal the source:

```sh
docker exec -e PGPASSWORD=postgres sdyroom-restore-drill psql -U postgres -d postgres -tAc \
  "select (select count(*) from supabase_migrations.schema_migrations),
          (select count(*) from pg_policies where schemaname='public'),
          (select count(*) from information_schema.tables where table_schema='public'),
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public');"
```

For hosted projects: use the Supabase dashboard's scheduled backups, and take
an on-demand backup before every migration that touches data.

Storage *objects* (uploaded PDFs) live in the storage service, not
`pg_dump`; for hosted projects rely on Supabase's object replication, and
note that limitation here rather than discovering it during an incident.

Tear down the scratch instance when done — the live stack is untouched:

```sh
docker rm -f sdyroom-restore-drill
```

### Drill log

| Date | Operator | Backup source | Restore target | Duration | Result |
| --- | --- | --- | --- | --- | --- |
| 2026-10-18 | Dev B (local stack, post db-reset) | `pg_dump -Fc` of `supabase_db_sdyroom` (18 migrations) | `pgvector/pgvector:pg17` scratch on port 55432 | ~2 min (incl. image pull) | **pass** — migrations 18/18, public policies 35/35, public tables 24/24, public functions 79/79, row counts equal; 14 ignorable platform errors (vault/event-trigger owners) |

## Retention: notifications

`prune_notifications(p_before) → integer` (migration `0012`) deletes each
caller's notifications older than the given timestamp. It is SECURITY
DEFINER and granted to `service_role` only — no application request can
invoke it, so retention must be scheduled outside the request path:

```sh
# Manual run against the local stack (as superuser).
docker exec -e PGPASSWORD=postgres supabase_db_sdyroom \
  psql -U postgres -d postgres -c \
  "select public.prune_notifications(now() - interval '90 days');"
```

On hosted Supabase, schedule the same statement via pg_cron (if enabled) or a
scheduled Edge Function holding the service-role key. Pick a retention window
(90 days is the default suggestion), write it down, and revisit when users ask
"where did my old notifications go?".

## Smoke and load scripts

| Command | Purpose |
| --- | --- |
| `npm run check:env` | Static check: every `process.env` read in `lib/` and `app/` is covered by `.env.example`. Runs in CI. |
| `npm run smoke` | Five HTTP checks against a running server: `/api/health`, `/api/health/ready`, `/api/metrics`, error-envelope `request_id` echo, malformed `x-request-id` replacement. Set `SMOKE_BASE_URL` (default `http://127.0.0.1:3000`). |
| `npm run load:sanity` | Single-process load smoke: configurable `LOAD_TOTAL` (default 200) requests at `LOAD_CONCURRENCY` (default 20); prints p50/p95/p99 and fails if any unexpected status appears or success rate is below 99%. Set `LOAD_BASE_URL`. |

Both HTTP scripts are smoke-level: they prove the deploy answers correctly,
not that it scales. Pair them with the platform's own metrics after launch.

-- 0020_study_plans.sql — AI study planner (PR 15)
-- ---------------------------------------------------------------------------
-- Adds the personal plan store: `study_plans` (one request/horizon per row,
-- statuses generating → active | failed, archived as history) and
-- `plan_items` (the day-by-day checklist). Chunk storage, retrieval and the
-- embed/chat ledgers stay in 0013/0018; the artifact store stays in 0019.
-- This migration never touches them.
--
-- Design notes (spec: docs/prs/PR-15-ai-study-planner.md):
--   1. Plans are personal: `user_id = auth.uid()` inside every RPC, own-row
--      RLS for reads, and every write travels through a SECURITY DEFINER
--      function — no INSERT/UPDATE/DELETE grant exists on either table
--      (the same two-layer posture as 0019). `room_id` is an optional
--      grounding link: it only widens which documents may be cited, never
--      who can see the plan (a room-linked plan is still private to its
--      creator — a shared room plan would create peer pressure around
--      personal schedules, out of scope by design).
--   2. The one-active-plan invariant is a partial unique index
--      (`study_plans_one_active`), not application discipline: a racing
--      second create collides with SQLSTATE 23505, which `create_plan`
--      turns into an idempotent reuse and the route maps to
--      `409 plan_already_active` when regeneration was not requested. A
--      second partial unique (`study_plans_one_generating`) backs the
--      resumable two-step model: at most one pending generation exists per
--      user, and a repeated POST reuses that row (replacing only its
--      inputs — a pending row holds the request, never generated content).
--   3. Deviation from the spec's single `generate_plan` (which would
--      insert plan + items in one call): the API contract is a resumable
--      `POST /api/plans` → `status: "generating"` → one bounded `…/step`
--      (the PR-12/14 pattern), which needs a stub row to exist *before*
--      the provider call. So: `create_plan` creates the stub,
--      `generate_plan` validates the model output and materialises items
--      atomically on the step. `fail_plan` records honest failures
--      (ai_provider_failed / ai_quota_exceeded) — malformed output never
--      becomes an active plan.
--   4. Deviation from the spec's `shift_plan(p_plan_id, p_from_date)`
--      deriving dates in SQL: the shift formula lives once, as the pure
--      function `lib/planner/shift.ts` (the spec's own unit-test list
--      targets that module), and `shift_plan` re-validates and applies the
--      computed moves atomically — ownership, forward-only, window and
--      exam-date guards inside the database, done items never touched.
--      Still pure SQL at rest: no LLM, deterministic, race-tolerant (a
--      concurrent done/shift is skipped, never corrupted).
--   5. No time-based CHECK on `exam_date`: Postgres re-evaluates CHECK
--      constraints on every UPDATE, so a `exam_date >= current_date + 1`
--      constraint would start rejecting legitimate updates on the exam
--      day itself. The [today+1, today+180] window is validated where the
--      input arrives (Zod) and re-validated in `create_plan`.
--   6. Foreign plan/item probes answer `not_found` (404 parity — a
--      non-owner must not learn a plan exists). The spec's `403 not_owner`
--      is therefore unreachable through the API by design; owner checks
--      still exist inside every RPC as defence-in-depth.
--   7. Progress/totals come from `plan_progress` (SQL authority); the
--      client mirrors the same formula in `lib/planner/progress.ts` for
--      optimistic UI, and the integration suite asserts they agree.
--   8. `plan_items` carries `resource_id` + a server-built `citation`
--      ({title, href}) so read tasks either cite an accessible document or
--      carry nothing — the model never supplies titles or links. On
--      resource delete the FK sets `resource_id` null; readers must treat
--      a null `resource_id` as "no citation" regardless of a stale jsonb
--      (there is deliberately no pair CHECK — it would break the delete).

-- ---------------------------------------------------------------------------
-- Table: study_plans — one planner request / one horizon per row
-- ---------------------------------------------------------------------------
create table public.study_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid references public.rooms (id) on delete set null,
  status text not null default 'generating'
    check (status in ('generating', 'active', 'archived', 'failed')),
  error_code text check (
    error_code is null
    or error_code in ('ai_provider_failed', 'ai_quota_exceeded')
  ),
  exam_date date not null,
  hours_per_day real not null
    check (hours_per_day >= 1 and hours_per_day <= 12),
  topics text[] not null default '{}'::text[]
    check (cardinality(topics) <= 25),
  document_ids uuid[] not null default '{}'::uuid[]
    check (cardinality(document_ids) <= 25),
  summary text
    check (summary is null or (length(summary) between 1 and 300)),
  model text,
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  generated_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An active plan always finished generation; failed/archived-from-
  -- generating rows never carry a `generated_at`. The reverse direction
  -- deliberately does not exist: archiving a completed plan keeps its
  -- generated_at.
  constraint study_plans_active_generated_check
    check (status <> 'active' or generated_at is not null)
);

-- The database-level one-active guarantee (spec: enforced by the index,
-- not just application code), plus the pending-row invariant that backs
-- idempotent creates.
create unique index study_plans_one_active
  on public.study_plans (user_id)
  where status = 'active';

create unique index study_plans_one_generating
  on public.study_plans (user_id)
  where status = 'generating';

create index study_plans_user_status_created_idx
  on public.study_plans (user_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Table: plan_items — the day-by-day checklist
-- ---------------------------------------------------------------------------
create table public.plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.study_plans (id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  item_date date not null,
  subject text
    check (subject is null or (length(subject) between 1 and 60)),
  task text not null check (length(task) between 1 and 300),
  kind text not null
    check (kind in ('read', 'practice', 'review', 'mock', 'rest')),
  estimated_minutes integer not null
    check (estimated_minutes between 1 and 480),
  resource_id uuid references public.study_resources (id) on delete set null,
  citation jsonb
    check (citation is null or jsonb_typeof(citation) = 'object'),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  unique (plan_id, ordinal)
);

create index plan_items_plan_date_ordinal_idx
  on public.plan_items (plan_id, item_date, ordinal);

-- The working set every progress read and the shift window filter on.
create index plan_items_undone_idx
  on public.plan_items (plan_id)
  where done_at is null;

-- ---------------------------------------------------------------------------
-- Grants: revoke-first, then the narrowest surface that serves the API.
-- SELECT is column-scoped everywhere (0013/0018/0019 posture): token
-- accounting never leaves the server, and a wildcard SELECT fails outright.
-- No INSERT/UPDATE/DELETE for any application role on either table — every
-- write travels through the SECURITY DEFINER functions below.
-- ---------------------------------------------------------------------------
revoke all on public.study_plans from anon, authenticated, service_role;
revoke all on public.plan_items from anon, authenticated, service_role;

grant select (
  id,
  user_id,
  room_id,
  status,
  error_code,
  exam_date,
  hours_per_day,
  topics,
  document_ids,
  summary,
  model,
  generated_at,
  archived_at,
  created_at,
  updated_at
) on public.study_plans to authenticated;
-- prompt_tokens / completion_tokens are deliberately ungranted.

grant select (
  id,
  plan_id,
  ordinal,
  item_date,
  subject,
  task,
  kind,
  estimated_minutes,
  resource_id,
  citation,
  done_at,
  created_at
) on public.plan_items to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.study_plans enable row level security;
alter table public.plan_items enable row level security;

-- Own plans only — reads through the invoker's session, so a foreign id is
-- indistinguishable from a missing one (404 parity).
create policy "study_plans_select_own"
  on public.study_plans
  for select
  to authenticated
  using (user_id = auth.uid());

-- Own items only, resolved through the owning plan (the subquery itself
-- runs under this role, so `study_plans_select_own` applies there too).
create policy "plan_items_select_own"
  on public.plan_items
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.study_plans p
       where p.id = plan_items.plan_id
         and p.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy exists on either table, and no matching
-- grant does either — two independent layers, every write is an RPC.

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.study_plans_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger study_plans_set_updated_at
before update on public.study_plans
for each row
execute function public.study_plans_touch_updated_at();

revoke execute on function public.study_plans_touch_updated_at()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helper: plan_progress — totals + progress, one formula, SQL authority
-- ---------------------------------------------------------------------------
-- Invoker-less internal: execute is revoked from every application role, so
-- it is reachable only from inside the SECURITY DEFINER RPCs below (owner
-- context). `lib/planner/progress.ts` mirrors this exact arithmetic for the
-- client's optimistic view; the integration suite asserts the two agree.
-- Dates are calendar dates evaluated against `current_date` (UTC — the
-- stack's posture; planner dates are never timezone-shifted).
create or replace function public.plan_progress(p_plan_id uuid)
returns jsonb
language sql
set search_path = ''
as $$
  select jsonb_build_object(
    'done',
      coalesce((select count(*) from public.plan_items i
                 where i.plan_id = plan_progress.p_plan_id
                   and i.done_at is not null), 0),
    'total',
      coalesce((select count(*) from public.plan_items i
                 where i.plan_id = plan_progress.p_plan_id), 0),
    'minutes_planned_today',
      coalesce((select sum(i.estimated_minutes) from public.plan_items i
                 where i.plan_id = plan_progress.p_plan_id
                   and i.item_date = current_date), 0),
    'minutes_done_today',
      coalesce((select sum(i.estimated_minutes) from public.plan_items i
                 where i.plan_id = plan_progress.p_plan_id
                   and i.item_date = current_date
                   and i.done_at is not null), 0),
    'minutes_planned',
      coalesce((select sum(i.estimated_minutes) from public.plan_items i
                 where i.plan_id = plan_progress.p_plan_id), 0),
    'minutes_done',
      coalesce((select sum(i.estimated_minutes) from public.plan_items i
                 where i.plan_id = plan_progress.p_plan_id
                   and i.done_at is not null), 0)
  );
$$;

revoke execute on function public.plan_progress(uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPC: create_plan — the table's only insert path (POST /api/plans)
-- ---------------------------------------------------------------------------
-- Pins user_id = auth.uid() (an explicit p_user_id that differs from the
-- session is refused — the route never passes one), validates the input
-- domain, re-checks room membership and document accessibility inside the
-- database, enforces the one-active invariant (409 unless regenerating),
-- and either inserts a `generating` stub or reuses the pending one.
create or replace function public.create_plan(
  p_user_id uuid,
  p_room_id uuid,
  p_exam_date date,
  p_hours_per_day real,
  p_topics text[],
  p_document_ids uuid[],
  p_regenerate boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active public.study_plans;
  v_pending public.study_plans;
  v_row public.study_plans;
  v_bad uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'not_owner' using errcode = 'P0001';
  end if;

  -- Input domain (route Zod mirrors these; this is the authority).
  if p_exam_date is null
     or p_exam_date < current_date + 1
     or p_exam_date > current_date + 180 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_hours_per_day is null
     or p_hours_per_day < 1
     or p_hours_per_day > 12 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_topics is null or cardinality(p_topics) > 25 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if exists (
    select 1
      from unnest(p_topics) as t (topic)
     where length(btrim(t.topic)) = 0 or length(t.topic) > 60
  ) then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_document_ids is null or cardinality(p_document_ids) > 25 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  -- Room membership re-check (definer reads room_members directly): the
  -- route answers 403 room_not_member before calling, this raises for a
  -- bypassed route.
  if p_room_id is not null and not exists (
    select 1
      from public.room_members m
     where m.room_id = p_room_id
       and m.user_id = auth.uid()
  ) then
    raise exception 'room_not_member' using errcode = 'P0001';
  end if;

  -- Accessibility re-check (definer reads study_resources directly): every
  -- id must be a file of the linked room (never personal when no room is
  -- linked), or the caller's own personal file.
  if cardinality(p_document_ids) > 0 then
    select r.id into v_bad
      from unnest(p_document_ids) as r (id)
      left join public.study_resources s
        on s.id = r.id
       and (
         (p_room_id is not null and s.room_id = p_room_id)
         or (s.room_id is null and s.owner_id = auth.uid())
       )
     where s.id is null
     limit 1;

    if v_bad is not null then
      raise exception 'validation' using errcode = 'P0001';
    end if;
  end if;

  -- One active plan per user: 409 unless this create is an explicit
  -- regeneration, which archives the old plan in the same transaction.
  select * into v_active
    from public.study_plans
   where user_id = auth.uid()
     and status = 'active'
   for update;

  if v_active.id is not null then
    if coalesce(p_regenerate, false) = false then
      raise exception 'plan_already_active' using errcode = 'P0001';
    end if;
    update public.study_plans
       set status = 'archived',
           archived_at = now()
     where id = v_active.id;
  end if;

  -- A pending generation is reused as-is apart from its inputs: the row
  -- holds the request, never generated content, so replacing the request
  -- is the honest resume (the client drives …/step on the returned id).
  select * into v_pending
    from public.study_plans
   where user_id = auth.uid()
     and status = 'generating'
   order by created_at desc
   limit 1
     for update;

  if v_pending.id is not null then
    update public.study_plans
       set room_id = p_room_id,
           exam_date = p_exam_date,
           hours_per_day = p_hours_per_day,
           topics = p_topics,
           document_ids = p_document_ids,
           summary = null,
           model = null,
           prompt_tokens = 0,
           completion_tokens = 0,
           error_code = null,
           generated_at = null,
           archived_at = null
     where id = v_pending.id
     returning * into v_row;

    return jsonb_build_object(
      'id', v_row.id,
      'status', v_row.status,
      'exam_date', v_row.exam_date,
      'deduped', true,
      'href', '/planner?plan=' || v_row.id
    );
  end if;

  insert into public.study_plans (
    user_id,
    room_id,
    exam_date,
    hours_per_day,
    topics,
    document_ids,
    status
  )
  values (
    auth.uid(),
    p_room_id,
    p_exam_date,
    p_hours_per_day,
    p_topics,
    p_document_ids,
    'generating'
  )
  on conflict (user_id) where status = 'generating'
    do nothing
  returning * into v_row;

  if v_row.id is null then
    -- A concurrent create won the insert; adopt its row (still pending)
    -- and refresh the inputs so this request is what the step will build.
    select * into v_pending
      from public.study_plans
     where user_id = auth.uid()
       and status = 'generating'
     order by created_at desc
     limit 1
       for update;

    if v_pending.id is null then
      raise exception 'plan_failed' using errcode = 'P0001';
    end if;

    update public.study_plans
       set room_id = p_room_id,
           exam_date = p_exam_date,
           hours_per_day = p_hours_per_day,
           topics = p_topics,
           document_ids = p_document_ids,
           summary = null,
           model = null,
           prompt_tokens = 0,
           completion_tokens = 0,
           error_code = null,
           generated_at = null,
           archived_at = null
     where id = v_pending.id
     returning * into v_row;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'exam_date', v_row.exam_date,
    'deduped', false,
    'href', '/planner?plan=' || v_row.id
  );
end;
$$;

revoke execute on function public.create_plan(uuid, uuid, date, real, text[], uuid[], boolean)
  from public, anon;
grant execute on function public.create_plan(uuid, uuid, date, real, text[], uuid[], boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: generate_plan — generating → active (owner only, idempotent)
-- ---------------------------------------------------------------------------
-- Materialises the step's model output: validates every item (window,
-- ordinal order, per-day budget, kind/minutes domain, resource
-- accessibility), enforces the per-user daily chat-token cap, writes the
-- chat/retrieval usage ledger in the same transaction, inserts the items
-- and flips the plan to active — all atomically. Malformed output raises
-- `plan_invalid` and leaves the row `generating` so `fail_plan` decides its
-- fate: a half-validated plan can never become active. An already-active
-- plan returns its state without a second spend (idempotent step replay).
create or replace function public.generate_plan(
  p_plan_id uuid,
  p_items jsonb,
  p_summary text,
  p_model text,
  p_prompt_tokens integer default 0,
  p_completion_tokens integer default 0,
  p_retrieval_tokens integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chat_daily_limit constant integer := 100000; -- chat tokens / user / UTC day (mirrors record_qa)
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_used integer := 0;
  v_spend integer;
  v_row public.study_plans;
  v_count integer;
  v_i integer;
  v_elem jsonb;
  v_ord text;
  v_date_raw text;
  v_date date;
  v_kind text;
  v_task text;
  v_subject text;
  v_minutes_raw text;
  v_minutes integer;
  v_resource_raw text;
  v_resource uuid;
  v_citation jsonb;
  v_budget integer;
  v_day_dates date[] := '{}';
  v_day_mins integer[] := '{}';
  v_day_idx integer;
  v_item_count integer;
  v_days integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_row
    from public.study_plans
   where id = p_plan_id
   for update;

  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.user_id <> auth.uid() then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.status = 'active' then
    select count(*), count(distinct i.item_date)
      into v_item_count, v_days
      from public.plan_items i
     where i.plan_id = v_row.id;
    return jsonb_build_object(
      'id', v_row.id,
      'status', v_row.status,
      'item_count', v_item_count,
      'days', v_days,
      'model', v_row.model,
      'deduped', true
    );
  end if;

  if v_row.status <> 'generating' then
    return jsonb_build_object(
      'id', v_row.id,
      'status', v_row.status,
      'error_code', to_jsonb(v_row.error_code),
      'deduped', true
    );
  end if;

  if p_summary is not null
     and (length(btrim(p_summary)) = 0 or length(p_summary) > 300) then
    raise exception 'plan_invalid' using errcode = 'P0001';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'plan_invalid' using errcode = 'P0001';
  end if;

  v_count := jsonb_array_length(p_items);
  if v_count < 1 or v_count > 180 then
    raise exception 'plan_invalid' using errcode = 'P0001';
  end if;

  if coalesce(p_prompt_tokens, 0) < 0
     or coalesce(p_completion_tokens, 0) < 0
     or coalesce(p_retrieval_tokens, 0) < 0 then
    raise exception 'plan_invalid' using errcode = 'P0001';
  end if;

  -- Per-day budget identical to lib/planner/validate.ts: whole minutes of
  -- availability plus the spec's ±15 tolerance.
  v_budget := floor(v_row.hours_per_day * 60)::integer + 15;

  -- Pass 1: validate every item, track per-day sums and the 90-day cap.
  for v_i in 0 .. v_count - 1 loop
    v_elem := p_items -> v_i;

    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'plan_invalid' using errcode = 'P0001';
    end if;

    v_ord := v_elem ->> 'ordinal';
    if v_ord is null or v_ord !~ '^[0-9]+$' or v_ord::integer <> v_i then
      raise exception 'plan_invalid' using errcode = 'P0001';
    end if;

    v_date_raw := v_elem ->> 'item_date';
    if v_date_raw is null or v_date_raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'plan_invalid' using errcode = 'P0001';
    end if;
    v_date := v_date_raw::date;
    if v_date is null or v_date < current_date or v_date > v_row.exam_date then
      raise exception 'plan_invalid' using errcode = 'P0001';
    end if;

    v_kind := v_elem ->> 'kind';
    if v_kind not in ('read', 'practice', 'review', 'mock', 'rest') then
      raise exception 'plan_invalid' using errcode = 'P0001';
    end if;

    v_task := btrim(coalesce(v_elem ->> 'task', ''));
    if length(v_task) = 0 or length(v_task) > 300 then
      raise exception 'plan_invalid' using errcode = 'P0001';
    end if;

    if v_elem -> 'subject' is null or jsonb_typeof(v_elem -> 'subject') = 'null' then
      v_subject := null;
    else
      v_subject := btrim(coalesce(v_elem ->> 'subject', ''));
      if length(v_subject) = 0 or length(v_subject) > 60 then
        raise exception 'plan_invalid' using errcode = 'P0001';
      end if;
    end if;

    v_minutes_raw := v_elem ->> 'estimated_minutes';
    if v_minutes_raw is null or v_minutes_raw !~ '^[0-9]+$' then
      raise exception 'plan_invalid' using errcode = 'P0001';
    end if;
    v_minutes := v_minutes_raw::integer;
    if v_minutes < 1 or v_minutes > 480 then
      raise exception 'plan_invalid' using errcode = 'P0001';
    end if;

    -- Resource accessibility: a fabricated or foreign id fails the whole
    -- plan (never a silently uncited read task masquerading as valid, and
    -- never a citation the caller cannot follow).
    v_resource_raw := v_elem ->> 'resource_id';
    if v_resource_raw is null
       or jsonb_typeof(v_elem -> 'resource_id') = 'null' then
      v_resource := null;
      v_citation := null;
    else
      if v_resource_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'plan_invalid' using errcode = 'P0001';
      end if;
      v_resource := v_resource_raw::uuid;
      if not exists (
        select 1
          from public.study_resources s
         where s.id = v_resource
           and (
             (v_row.room_id is not null and s.room_id = v_row.room_id)
             or (s.room_id is null and s.owner_id = auth.uid())
           )
      ) then
        raise exception 'plan_invalid' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_elem -> 'citation') <> 'object' then
        raise exception 'plan_invalid' using errcode = 'P0001';
      end if;
      v_citation := v_elem -> 'citation';
    end if;

    v_day_idx := array_position(v_day_dates, v_date);
    if v_day_idx is null then
      if coalesce(array_length(v_day_dates, 1), 0) >= 90 then
        raise exception 'plan_invalid' using errcode = 'P0001';
      end if;
      v_day_dates := v_day_dates || v_date;
      v_day_mins := v_day_mins || v_minutes;
      if v_day_mins[array_length(v_day_mins, 1)] > v_budget then
        raise exception 'plan_invalid' using errcode = 'P0001';
      end if;
    else
      v_day_mins[v_day_idx] := v_day_mins[v_day_idx] + v_minutes;
      if v_day_mins[v_day_idx] > v_budget then
        raise exception 'plan_invalid' using errcode = 'P0001';
      end if;
    end if;
  end loop;

  -- The per-user daily chat cap, re-checked inside the database (the route
  -- pre-checks the same sum to answer 403 before any provider call).
  select coalesce(sum(amount), 0)
    into v_used
    from public.ai_usage
   where kind = 'chat_tokens'
     and user_id = auth.uid()
     and created_at >= v_day_start;

  v_spend := coalesce(p_prompt_tokens, 0) + coalesce(p_completion_tokens, 0);

  if v_used + v_spend > v_chat_daily_limit then
    update public.study_plans
       set status = 'failed',
           error_code = 'ai_quota_exceeded'
     where id = p_plan_id;
    raise exception 'ai_quota_exceeded' using errcode = 'P0001';
  end if;

  -- Pass 2: insert (ordinals = position, dates already in order upstream;
  -- the map is per-day so order inside a day does not matter).
  for v_i in 0 .. v_count - 1 loop
    v_elem := p_items -> v_i;
    v_date := (v_elem ->> 'item_date')::date;
    v_resource_raw := v_elem ->> 'resource_id';

    insert into public.plan_items (
      plan_id,
      ordinal,
      item_date,
      subject,
      task,
      kind,
      estimated_minutes,
      resource_id,
      citation
    )
    values (
      p_plan_id,
      v_i,
      v_date,
      nullif(btrim(coalesce(v_elem ->> 'subject', '')), ''),
      btrim(v_elem ->> 'task'),
      v_elem ->> 'kind',
      (v_elem ->> 'estimated_minutes')::integer,
      case
        when v_resource_raw is null then null
        else v_resource_raw::uuid
      end,
      case
        when v_resource_raw is null then null
        else v_elem -> 'citation'
      end
    );
  end loop;

  update public.study_plans
     set status = 'active',
         summary = nullif(btrim(coalesce(p_summary, '')), ''),
         model = p_model,
         prompt_tokens = coalesce(p_prompt_tokens, 0),
         completion_tokens = coalesce(p_completion_tokens, 0),
         error_code = null,
         generated_at = now()
   where id = p_plan_id
   returning * into v_row;

  insert into public.ai_usage (room_id, user_id, kind, amount)
  select v_row.room_id, auth.uid(), 'chat_tokens', v_spend
  where v_spend > 0;

  insert into public.ai_usage (room_id, user_id, kind, amount)
  select v_row.room_id, auth.uid(), 'embed_tokens', coalesce(p_retrieval_tokens, 0)
  where coalesce(p_retrieval_tokens, 0) > 0;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'item_count', v_count,
    'days', coalesce(array_length(v_day_dates, 1), 0),
    'model', v_row.model,
    'deduped', false,
    'chat_used_today', v_used + v_spend,
    'chat_limit', v_chat_daily_limit
  );
end;
$$;

revoke execute on function public.generate_plan(uuid, jsonb, text, text, integer, integer, integer)
  from public, anon;
grant execute on function public.generate_plan(uuid, jsonb, text, text, integer, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: fail_plan — generating → failed with an honest error code
-- ---------------------------------------------------------------------------
-- Never demotes a committed plan: active/archived rows return their state
-- untouched (idempotent), so a stale step replay cannot destroy a valid
-- plan. This is the "failed over a lying plan" path for provider errors,
-- validation failures and quota rejections at step time.
create or replace function public.fail_plan(
  p_plan_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.study_plans;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_error_code not in ('ai_provider_failed', 'ai_quota_exceeded') then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  select * into v_row
    from public.study_plans
   where id = p_plan_id
   for update;

  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.user_id <> auth.uid() then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.status = 'active' or v_row.status = 'archived' then
    return jsonb_build_object(
      'id', v_row.id,
      'status', v_row.status,
      'error_code', to_jsonb(v_row.error_code),
      'deduped', true
    );
  end if;

  if v_row.status = 'failed' then
    return jsonb_build_object(
      'id', v_row.id,
      'status', v_row.status,
      'error_code', v_row.error_code,
      'deduped', true
    );
  end if;

  update public.study_plans
     set status = 'failed',
         error_code = p_error_code
   where id = p_plan_id
   returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'error_code', v_row.error_code,
    'deduped', false
  );
end;
$$;

revoke execute on function public.fail_plan(uuid, text) from public, anon;
grant execute on function public.fail_plan(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: mark_plan_item — checkbox toggle (owner only, idempotent)
-- ---------------------------------------------------------------------------
-- Resolves the plan through the item, asserts the session owns it (foreign
-- item id → not_found, indistinguishable from missing), and only touches
-- `done_at` on an active plan. Idempotent: repeating the desired state is a
-- no-op, so the first completion timestamp is never rewritten.
create or replace function public.mark_plan_item(
  p_item_id uuid,
  p_done boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_id uuid;
  v_plan_id uuid;
  v_plan_status text;
  v_owner uuid;
  v_done_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_done is null then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  select i.id, i.plan_id, i.done_at, p.status, p.user_id
    into v_item_id, v_plan_id, v_done_at, v_plan_status, v_owner
    from public.plan_items i
    join public.study_plans p on p.id = i.plan_id
   where i.id = p_item_id
   for update of i;

  if v_item_id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_owner <> auth.uid() then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_plan_status <> 'active' then
    raise exception 'plan_not_active' using errcode = 'P0001';
  end if;

  if p_done and v_done_at is null then
    update public.plan_items
       set done_at = now()
     where id = v_item_id;
    v_done_at := now();
  elsif (not p_done) and v_done_at is not null then
    update public.plan_items
       set done_at = null
     where id = v_item_id;
    v_done_at := null;
  end if;

  return jsonb_build_object(
    'item',
    jsonb_build_object('id', v_item_id, 'done_at', to_jsonb(v_done_at)),
    'plan',
    jsonb_build_object(
      'id', v_plan_id,
      'status', v_plan_status,
      'progress', public.plan_progress(v_plan_id)
    )
  );
end;
$$;

revoke execute on function public.mark_plan_item(uuid, boolean)
  from public, anon;
grant execute on function public.mark_plan_item(uuid, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: complete_plan_day — "mark all of today done" (owner only)
-- ---------------------------------------------------------------------------
create or replace function public.complete_plan_day(
  p_plan_id uuid,
  p_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.study_plans;
  v_completed integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_date is null then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  select * into v_row
    from public.study_plans
   where id = p_plan_id
   for update;

  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.user_id <> auth.uid() then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.status <> 'active' then
    raise exception 'plan_not_active' using errcode = 'P0001';
  end if;

  update public.plan_items
     set done_at = now()
   where plan_id = p_plan_id
     and item_date = p_date
     and done_at is null;

  get diagnostics v_completed = row_count;

  return jsonb_build_object(
    'completed', v_completed,
    'progress', public.plan_progress(p_plan_id)
  );
end;
$$;

revoke execute on function public.complete_plan_day(uuid, date)
  from public, anon;
grant execute on function public.complete_plan_day(uuid, date)
  to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: shift_plan — move remaining items forward (owner only)
-- ---------------------------------------------------------------------------
-- `p_updates` is the computed move list: [{ "id": uuid, "item_date":
-- "YYYY-MM-DD" }, …] produced by the pure function lib/planner/shift.ts.
-- The database re-validates everything that matters here — items belong to
-- this plan, are not done (a concurrent completion is skipped, never
-- undone), move forward only, and never pass exam_date — then applies the
-- surviving moves in one statement. Pure SQL, no LLM; idempotent by
-- construction (a repeated identical request is a no-op).
create or replace function public.shift_plan(
  p_plan_id uuid,
  p_from_date date,
  p_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.study_plans;
  v_elem jsonb;
  v_id_raw text;
  v_item_id uuid;
  v_target_raw text;
  v_target date;
  v_current date;
  v_done timestamptz;
  v_valid jsonb := '[]'::jsonb;
  v_skipped_done integer := 0;
  v_moved integer := 0;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_from_date is null then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  select * into v_row
    from public.study_plans
   where id = p_plan_id
   for update;

  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.user_id <> auth.uid() then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.status <> 'active' then
    raise exception 'plan_not_active' using errcode = 'P0001';
  end if;

  if p_updates is null or jsonb_typeof(p_updates) <> 'array' then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_updates) > 180 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  for v_elem in select value from jsonb_array_elements(p_updates) loop
    v_id_raw := v_elem ->> 'id';
    if v_id_raw is null
       or v_id_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'validation' using errcode = 'P0001';
    end if;
    v_item_id := v_id_raw::uuid;

    v_target_raw := v_elem ->> 'item_date';
    if v_target_raw is null or v_target_raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'validation' using errcode = 'P0001';
    end if;
    v_target := v_target_raw::date;

    select i.item_date, i.done_at
      into v_current, v_done
      from public.plan_items i
     where i.plan_id = p_plan_id
       and i.id = v_item_id;

    if v_current is null then
      -- Not part of this plan (or vanished): a caller bug, not an oracle —
      -- the plan itself is already known to be ours.
      raise exception 'validation' using errcode = 'P0001';
    end if;

    if v_done is not null then
      v_skipped_done := v_skipped_done + 1;
      continue;
    end if;

    if v_current < p_from_date then
      raise exception 'validation' using errcode = 'P0001';
    end if;

    if v_target < v_current then
      raise exception 'validation' using errcode = 'P0001';
    end if;

    if v_target > v_row.exam_date then
      raise exception 'validation' using errcode = 'P0001';
    end if;

    if v_target = v_current then
      continue;
    end if;

    v_valid := v_valid || jsonb_build_array(
      jsonb_build_object('id', v_item_id, 'item_date', v_target)
    );
  end loop;

  if jsonb_array_length(v_valid) > 0 then
    update public.plan_items i
       set item_date = (u.value ->> 'item_date')::date
      from jsonb_array_elements(v_valid) as u (value)
     where i.plan_id = p_plan_id
       and i.id = (u.value ->> 'id')::uuid
       and i.done_at is null
       and i.item_date < (u.value ->> 'item_date')::date;
    get diagnostics v_moved = row_count;
  end if;

  return jsonb_build_object(
    'moved', v_moved,
    'skipped_done', v_skipped_done,
    'exam_date', v_row.exam_date
  );
end;
$$;

revoke execute on function public.shift_plan(uuid, date, jsonb)
  from public, anon;
grant execute on function public.shift_plan(uuid, date, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: archive_plan — any non-archived plan → archived (owner only)
-- ---------------------------------------------------------------------------
-- Also the cancel path for a pending generation (a `generating` row holds
-- no items, so nothing is lost). Idempotent on an already-archived row.
create or replace function public.archive_plan(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.study_plans;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_row
    from public.study_plans
   where id = p_plan_id
   for update;

  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.user_id <> auth.uid() then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.status = 'archived' then
    return jsonb_build_object(
      'id', v_row.id,
      'archived', true,
      'deduped', true
    );
  end if;

  update public.study_plans
     set status = 'archived',
         archived_at = now()
   where id = p_plan_id
   returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'archived', true,
    'deduped', false
  );
end;
$$;

revoke execute on function public.archive_plan(uuid) from public, anon;
grant execute on function public.archive_plan(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: plan_stats — totals + progress for one of the caller's plans
-- ---------------------------------------------------------------------------
create or replace function public.plan_stats(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.study_plans;
  v_item_count integer;
  v_days integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_row
    from public.study_plans
   where id = p_plan_id;

  if v_row.id is null or v_row.user_id <> auth.uid() then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select count(*), count(distinct i.item_date)
    into v_item_count, v_days
    from public.plan_items i
   where i.plan_id = p_plan_id;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'exam_date', v_row.exam_date,
    'hours_per_day', v_row.hours_per_day,
    'summary', to_jsonb(v_row.summary),
    'error_code', to_jsonb(v_row.error_code),
    'item_count', v_item_count,
    'days', v_days,
    'progress', public.plan_progress(p_plan_id)
  );
end;
$$;

revoke execute on function public.plan_stats(uuid) from public, anon;
grant execute on function public.plan_stats(uuid) to authenticated;

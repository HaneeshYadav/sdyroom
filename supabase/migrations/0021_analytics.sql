-- ---------------------------------------------------------------------------
-- PR 16 — Study analytics: personal and room aggregates as RPCs.
--
-- Why RPCs, not views (stated per spec): views with `security_invoker` run
-- every reader's RLS over base rows and still need per-table grants to say
-- anything, and the aggregate shapes here (zero-filled days, streak sources,
-- role checks) are record logic, not row filters. Two SECURITY DEFINER
-- functions keep every privilege decision inside the database — a future
-- route refactor cannot open a hole — and return exactly the contract the
-- API serves. Base-table grants are untouched: these functions only `select`
-- (acceptance: no new privilege on any base table; this migration contains
-- no `grant … on <table>` statement at all).
--
-- Migration number: the spec pre-assigned `0014_analytics_views.sql`, but
-- 0018/0019/0020 (ask history, quizzes/decks, study plans) took the numbers
-- this PR's inputs live under. Naming this file 0014 would apply it before
-- `quiz_attempts`/`flashcard_reviews`/`plan_items` exist on a fresh
-- `supabase db reset`, so index creation on those tables would fail and the
-- functions would be created before their tables. `0021` keeps strict
-- chronological order; the spec and roadmap rows are updated to match.
--
-- Timezone rule (documented once, used everywhere): every day bucket is the
-- UTC calendar date of the event timestamp — `(ts at time zone 'utc')::date`
-- — and every window is `[today_utc - (p_days - 1), today_utc]` inclusive,
-- built from UTC midnights. A session started at 23:30 UTC lands on that UTC
-- date. Nothing consults the machine's local zone, same posture as
-- `lib/planner/dates.ts`.
--
-- Personal focus attribution (documented seam, see also 0003):
-- `focus_sessions` deliberately carries no user_id and only the room owner
-- may drive the shared timer (`focus_room_check(p_room_id, true)`), so
-- personal focus time = sessions of rooms this caller owns, joined through
-- `rooms.owner_id`. Focus time spent in other people's rooms is therefore
-- not attributable to the student and is counted only in that room's
-- aggregate — no identity column is added to fix that, because 0003's
-- identity-hiding design forbids it.
--
-- Credit formula for a terminal session (running/paused sessions are
-- excluded — they are not finished time):
--   least(duration_seconds, greatest(0, ended_at - started_at - paused_seconds))
-- i.e. attended time, capped at the planned duration. Known edge case: a
-- session *ended while paused* overcounts the final pause (ending nulls
-- `paused_at` in 0003, so the pause is unrecoverable after the fact); the
-- end path is left untouched to keep its contract. `expired` is the normal
-- full-duration completion path (ended_at = ends_at) and credits exactly
-- duration_seconds.
--
-- Known data limitations, carried into the API docs rather than papered over:
--   * `flashcard_reviews` is per-card state, not an event log: a re-review
--     overwrites `last_reviewed_at`. Daily `cards_reviewed` therefore counts
--     each card's most recent review day — accurate for today, a lower bound
--     for past days as cards are re-reviewed.
--   * `cards_due` counts, across every ready deck the caller can open, cards
--     with no review row yet plus rows whose `next_review_at` is on or
--     before the end of today (UTC) — the same "never reviewed or overdue"
--     rule `review_card` uses per deck (0019).
--   * Room `active_members` cannot mean "members with ≥1 session" (spec's
--     wording) because sessions carry no member identity; it is the count of
--     distinct members with an attributable action in the window (quiz
--     attempt, card review, room upload, goal created/completed) plus the
--     room owner when ≥1 session ran in the window. Counts only — the
--     payload never contains a user id or alias.
--
-- Indexes added (both checked missing against the live schema first):
--   * study_goals_room_created_idx (room_id, created_at desc)
--       Room goal series filters `room_id = ? and created_at in window`;
--       every existing study_goals index leads with user_id, so the room
--       path had no usable index.
--   * quiz_attempts_artifact_created_idx (artifact_id, created_at desc)
--       Room quiz series joins attempts through study_artifacts and buckets
--       by created_at; the existing (artifact_id, user_id) index serves the
--       join but cannot order/filter the date range. Not added before 0019
--       existed (see the migration-number note above).
-- All other paths ride existing indexes: focus_sessions_room_started_idx +
-- rooms_owner_id_idx (personal focus), study_goals_user_room_idx +
-- study_resources_owner_created_idx (personal goals/uploads),
-- quiz_attempts_user_created_idx (personal accuracy), flashcard_reviews
-- user_next_idx (due cards), study_resources_room_created_idx (room
-- uploads), study_artifacts_room_kind_created_idx (room artifact joins).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- analytics_me — the personal panel (one round trip for days + summary).
-- ---------------------------------------------------------------------------
-- `p_user_id` is kept in the signature the spec fixes (and for the planner's
-- future consumption) but is deliberately NOT the subject: the aggregate is
-- always about `auth.uid()`, and a foreign id silently behaves as self, so
-- there is no parameter that can be pointed at anyone else. `auth.uid()` is
-- null (anon) → `unauthenticated`.
create or replace function public.analytics_me(p_user_id uuid, p_days integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_days integer;
  v_end date;
  v_start date;
  v_prev_start date;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_prev_start_ts timestamptz;
  v_days_json jsonb;
  v_summary jsonb;
  v_study_days jsonb;
  v_plan jsonb;
  v_by_difficulty jsonb;
  v_focus_minutes integer := 0;
  v_goals_completed integer := 0;
  v_goals_created integer := 0;
  v_goals_active integer := 0;
  v_quiz_correct integer := 0;
  v_quiz_total integer := 0;
  v_uploads integer := 0;
  v_upload_bytes bigint := 0;
  v_cards_due integer := 0;
  v_focus_seconds bigint := 0;
  v_prev_seconds bigint := 0;
  v_sessions integer := 0;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  v_days := p_days;
  v_end := (now() at time zone 'utc')::date;
  v_start := v_end - (v_days - 1);
  v_prev_start := v_start - v_days;
  v_start_ts := v_start::timestamp at time zone 'utc';
  v_end_ts := (v_end + 1)::timestamp at time zone 'utc';
  v_prev_start_ts := v_prev_start::timestamp at time zone 'utc';

  -- The zero-filled day series: one row per day, every metric coalesced to
  -- zero, so an empty range is an array of honest zeros, never a gap.
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(g.d, 'YYYY-MM-DD'),
           'focus_minutes', coalesce(f.minutes, 0),
           'goals_completed', coalesce(gc.n, 0),
           'quizzes_taken', coalesce(q.n, 0),
           'cards_reviewed', coalesce(cr.n, 0),
           'uploads', coalesce(u.n, 0),
           'quiz_correct', coalesce(q.correct, 0),
           'quiz_total', coalesce(q.total, 0)
         ) order by g.d), '[]'::jsonb)
    into v_days_json
    from generate_series(v_start, v_end, interval '1 day') as g(d)
    left join (
      select (fs.started_at at time zone 'utc')::date as day,
             round(sum(least(
               fs.duration_seconds,
               greatest(0,
                 extract(epoch from (fs.ended_at - fs.started_at)) - fs.paused_seconds)
             )) / 60.0)::int as minutes
        from public.focus_sessions fs
        join public.rooms r on r.id = fs.room_id
       where r.owner_id = v_uid
         and fs.state in ('completed', 'expired')
         and fs.ended_at is not null
         and fs.started_at >= v_start_ts
         and fs.started_at < v_end_ts
       group by 1
    ) f on f.day = g.d
    left join (
      select (completed_at at time zone 'utc')::date as day, count(*)::int as n
        from public.study_goals
       where user_id = v_uid
         and status = 'completed'
         and completed_at >= v_start_ts
         and completed_at < v_end_ts
       group by 1
    ) gc on gc.day = g.d
    left join (
      select (created_at at time zone 'utc')::date as day,
             count(*)::int as n,
             coalesce(sum(score), 0)::int as correct,
             coalesce(sum(total), 0)::int as total
        from public.quiz_attempts
       where user_id = v_uid
         and created_at >= v_start_ts
         and created_at < v_end_ts
       group by 1
    ) q on q.day = g.d
    left join (
      select (last_reviewed_at at time zone 'utc')::date as day, count(*)::int as n
        from public.flashcard_reviews
       where user_id = v_uid
         and last_reviewed_at >= v_start_ts
         and last_reviewed_at < v_end_ts
       group by 1
    ) cr on cr.day = g.d
    left join (
      select (created_at at time zone 'utc')::date as day, count(*)::int as n
        from public.study_resources
       where owner_id = v_uid
         and created_at >= v_start_ts
         and created_at < v_end_ts
       group by 1
    ) u on u.day = g.d;

  -- Range totals are the sum of the same day buckets the chart draws, so a
  -- summary card and its chart can never disagree.
  select coalesce(sum((d ->> 'focus_minutes')::int), 0)::int,
         coalesce(sum((d ->> 'goals_completed')::int), 0)::int,
         coalesce(sum((d ->> 'quiz_correct')::int), 0)::int,
         coalesce(sum((d ->> 'quiz_total')::int), 0)::int,
         coalesce(sum((d ->> 'uploads')::int), 0)::int
    into v_focus_minutes, v_goals_completed, v_quiz_correct, v_quiz_total, v_uploads
    from jsonb_array_elements(v_days_json) as d;

  -- Session count and the raw credited seconds behind the average (raw, not
  -- the per-day rounded values, so avg is not skewed by rounding).
  select coalesce(sum(least(
           fs.duration_seconds,
           greatest(0,
             extract(epoch from (fs.ended_at - fs.started_at)) - fs.paused_seconds)
         )), 0)::bigint,
         count(*)::int
    into v_focus_seconds, v_sessions
    from public.focus_sessions fs
    join public.rooms r on r.id = fs.room_id
   where r.owner_id = v_uid
     and fs.state in ('completed', 'expired')
     and fs.ended_at is not null
     and fs.started_at >= v_start_ts
     and fs.started_at < v_end_ts;

  -- Previous equal-length window: "this week versus last" on the strip.
  select coalesce(sum(least(
           fs.duration_seconds,
           greatest(0,
             extract(epoch from (fs.ended_at - fs.started_at)) - fs.paused_seconds)
         )), 0)::bigint
    into v_prev_seconds
    from public.focus_sessions fs
    join public.rooms r on r.id = fs.room_id
   where r.owner_id = v_uid
     and fs.state in ('completed', 'expired')
     and fs.ended_at is not null
     and fs.started_at >= v_prev_start_ts
     and fs.started_at < v_start_ts;

  select count(*)::int
    into v_goals_created
    from public.study_goals
   where user_id = v_uid
     and created_at >= v_start_ts
     and created_at < v_end_ts;

  select count(*)::int
    into v_goals_active
    from public.study_goals
   where user_id = v_uid
     and status = 'active';

  select coalesce(sum(size_bytes), 0)::bigint
    into v_upload_bytes
    from public.study_resources
   where owner_id = v_uid
     and created_at >= v_start_ts
     and created_at < v_end_ts;

  -- Due cards: every ready deck the caller can open counts as
  -- (never reviewed) + (reviewed rows due by end of today UTC) — the rule
  -- review_card applies per deck, generalized across accessible decks.
  select coalesce(sum(
           greatest(coalesce(a.card_count, 0) - coalesce(t.reviewed, 0), 0)
           + coalesce(t.due, 0)
         ), 0)::int
    into v_cards_due
    from public.study_artifacts a
    join public.room_members m
      on m.room_id = a.room_id
     and m.user_id = v_uid
    left join (
      select artifact_id,
             count(*)::int as reviewed,
             (count(*) filter (
               where next_review_at < v_end_ts
             ))::int as due
        from public.flashcard_reviews
       where user_id = v_uid
       group by artifact_id
    ) t on t.artifact_id = a.id
   where a.kind = 'deck'
     and a.status = 'ready';

  -- Accuracy by artifact difficulty: the spec's "subject-ish proxy".
  select coalesce(jsonb_agg(jsonb_build_object(
           'difficulty', s.difficulty,
           'correct', s.correct,
           'total', s.total
         ) order by s.difficulty), '[]'::jsonb)
    into v_by_difficulty
    from (
      select a.difficulty as difficulty,
             coalesce(sum(qa.score), 0)::int as correct,
             coalesce(sum(qa.total), 0)::int as total
        from public.quiz_attempts qa
        join public.study_artifacts a on a.id = qa.artifact_id
       where qa.user_id = v_uid
         and qa.created_at >= v_start_ts
         and qa.created_at < v_end_ts
       group by 1
    ) s;

  -- Streak source: UTC days with credited focus in the last 365 days. The
  -- route turns this into current/longest streaks in TypeScript, where the
  -- boundary rules are unit-testable; the cap keeps the array bounded and
  -- is the documented streak lookback.
  select coalesce(jsonb_agg(to_char(s.day, 'YYYY-MM-DD') order by s.day), '[]'::jsonb)
    into v_study_days
    from (
      select (fs.started_at at time zone 'utc')::date as day
        from public.focus_sessions fs
        join public.rooms r on r.id = fs.room_id
       where r.owner_id = v_uid
         and fs.state in ('completed', 'expired')
         and fs.ended_at is not null
         and fs.started_at >= ((v_end - 365)::timestamp at time zone 'utc')
         and fs.started_at < v_end_ts
       group by 1
      having sum(least(
        fs.duration_seconds,
        greatest(0,
          extract(epoch from (fs.ended_at - fs.started_at)) - fs.paused_seconds)
      )) > 0
    ) s;

  -- The caller's active plan over the same window (additive: the planner's
  -- "planned vs actual" contract). Null when no plan is active.
  select jsonb_build_object(
           'planned_minutes', coalesce(sum(pi.estimated_minutes), 0)::int,
           'items_total', count(pi.id)::int,
           'items_done', (count(pi.id) filter (where pi.done_at is not null))::int,
           'items_overdue', (count(pi.id) filter (
             where pi.done_at is null and pi.item_date < v_end
           ))::int
         )
    into v_plan
    from (
      select sp.id
        from public.study_plans sp
       where sp.user_id = v_uid
         and sp.status = 'active'
       limit 1
    ) sp
    left join public.plan_items pi
      on pi.plan_id = sp.id
     and pi.item_date >= v_start
     and pi.item_date <= v_end
    group by sp.id;

  v_summary := jsonb_build_object(
    'focus_minutes', v_focus_minutes,
    'goals_completed', v_goals_completed,
    'goals_created', v_goals_created,
    'goals_active', v_goals_active,
    'quiz_correct', v_quiz_correct,
    'quiz_total', v_quiz_total,
    'accuracy', case
      when v_quiz_total > 0
        then round(v_quiz_correct::numeric / v_quiz_total, 2)
      else null
    end,
    'quiz_by_difficulty', v_by_difficulty,
    'cards_due', v_cards_due,
    'uploads', v_uploads,
    'upload_bytes', v_upload_bytes,
    'sessions', v_sessions,
    'avg_session_minutes', case
      when v_sessions > 0
        then round(v_focus_seconds / 60.0 / v_sessions)::int
      else 0
    end,
    'previous_focus_minutes',
      round(v_prev_seconds / 60.0)::int
  );

  return jsonb_build_object(
    'days', v_days_json,
    'summary', v_summary,
    'study_days', v_study_days,
    'plan', v_plan
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- analytics_room — the owner/moderator panel (aggregates only).
-- ---------------------------------------------------------------------------
-- Authorization lives here, not in the route: the caller must be the room's
-- owner or hold a room_moderators row, else the same `not_found` a stranger
-- gets (indistinguishable 404s for missing room, plain member and outsider).
-- The payload carries counts and minutes only — never a user id, alias or
-- any content — so small-room re-identification has nothing to read.
create or replace function public.analytics_room(p_room_id uuid, p_days integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_days integer;
  v_end date;
  v_start date;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_payload jsonb;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_room_id is null
     or (
       not exists (
         select 1 from public.rooms r
          where r.id = p_room_id and r.owner_id = v_uid
       )
       and not exists (
         select 1 from public.room_moderators m
          where m.room_id = p_room_id and m.user_id = v_uid
       )
     ) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  v_days := p_days;
  v_end := (now() at time zone 'utc')::date;
  v_start := v_end - (v_days - 1);
  v_start_ts := v_start::timestamp at time zone 'utc';
  v_end_ts := (v_end + 1)::timestamp at time zone 'utc';

  with focus as (
    select (fs.started_at at time zone 'utc')::date as day,
           round(sum(least(
             fs.duration_seconds,
             greatest(0,
               extract(epoch from (fs.ended_at - fs.started_at)) - fs.paused_seconds)
           )) / 60.0)::int as minutes
      from public.focus_sessions fs
     where fs.room_id = p_room_id
       and fs.state in ('completed', 'expired')
       and fs.ended_at is not null
       and fs.started_at >= v_start_ts
       and fs.started_at < v_end_ts
     group by 1
  ),
  attempts as (
    select (qa.created_at at time zone 'utc')::date as day,
           count(*)::int as n,
           coalesce(sum(qa.score), 0)::int as correct,
           coalesce(sum(qa.total), 0)::int as total
      from public.quiz_attempts qa
      join public.study_artifacts a on a.id = qa.artifact_id
     where a.room_id = p_room_id
       and qa.created_at >= v_start_ts
       and qa.created_at < v_end_ts
     group by 1
  ),
  goals_created as (
    select (created_at at time zone 'utc')::date as day, count(*)::int as n
      from public.study_goals
     where room_id = p_room_id
       and created_at >= v_start_ts
       and created_at < v_end_ts
     group by 1
  ),
  goals_done as (
    select (completed_at at time zone 'utc')::date as day, count(*)::int as n
      from public.study_goals
     where room_id = p_room_id
       and status = 'completed'
       and completed_at >= v_start_ts
       and completed_at < v_end_ts
     group by 1
  ),
  uploads as (
    select (created_at at time zone 'utc')::date as day, count(*)::int as n
      from public.study_resources
     where room_id = p_room_id
       and created_at >= v_start_ts
       and created_at < v_end_ts
     group by 1
  ),
  -- "Who did something in this room today" — every attributable action a
  -- member can take, deduplicated per (day, actor), counted immediately and
  -- never returned as rows. Sessions attribute to the room owner (0003:
  -- only the owner drives the timer).
  actions as (
    select (qa.created_at at time zone 'utc')::date as day, qa.user_id as actor
      from public.quiz_attempts qa
      join public.study_artifacts a on a.id = qa.artifact_id
     where a.room_id = p_room_id
       and qa.created_at >= v_start_ts
       and qa.created_at < v_end_ts
    union
    select (fr.last_reviewed_at at time zone 'utc')::date, fr.user_id
      from public.flashcard_reviews fr
      join public.study_artifacts a on a.id = fr.artifact_id
     where a.room_id = p_room_id
       and fr.last_reviewed_at >= v_start_ts
       and fr.last_reviewed_at < v_end_ts
    union
    select (sr.created_at at time zone 'utc')::date, sr.owner_id
      from public.study_resources sr
     where sr.room_id = p_room_id
       and sr.created_at >= v_start_ts
       and sr.created_at < v_end_ts
    union
    select (sg.created_at at time zone 'utc')::date, sg.user_id
      from public.study_goals sg
     where sg.room_id = p_room_id
       and sg.created_at >= v_start_ts
       and sg.created_at < v_end_ts
    union
    select (sg.completed_at at time zone 'utc')::date, sg.user_id
      from public.study_goals sg
     where sg.room_id = p_room_id
       and sg.status = 'completed'
       and sg.completed_at >= v_start_ts
       and sg.completed_at < v_end_ts
    union
    select (fs.started_at at time zone 'utc')::date, r.owner_id
      from public.focus_sessions fs
      join public.rooms r on r.id = fs.room_id
     where fs.room_id = p_room_id
       and fs.state in ('completed', 'expired')
       and fs.ended_at is not null
       and fs.started_at >= v_start_ts
       and fs.started_at < v_end_ts
  ),
  active as (
    select day, count(distinct actor)::int as n
      from actions
     group by 1
  )
  select jsonb_build_object(
    'days', coalesce(jsonb_agg(jsonb_build_object(
      'date', to_char(g.d, 'YYYY-MM-DD'),
      'focus_minutes', coalesce(f.minutes, 0),
      'active_members', coalesce(ac.n, 0),
      'quiz_attempts', coalesce(att.n, 0)
    ) order by g.d), '[]'::jsonb),
    'summary', jsonb_build_object(
      'focus_minutes_total', coalesce(sum(coalesce(f.minutes, 0)), 0)::int,
      'active_members', (select count(distinct actor) from actions)::int,
      'goals_created', (select coalesce(sum(n), 0) from goals_created)::int,
      'goals_completed', (select coalesce(sum(n), 0) from goals_done)::int,
      'quiz_attempts', (select coalesce(sum(n), 0) from attempts)::int,
      'quiz_correct', (select coalesce(sum(correct), 0) from attempts)::int,
      'quiz_total', (select coalesce(sum(total), 0) from attempts)::int,
      'uploads', (select coalesce(sum(n), 0) from uploads)::int
    )
  )
    into v_payload
    from generate_series(v_start, v_end, interval '1 day') as g(d)
    left join focus f on f.day = g.d
    left join attempts att on att.day = g.d
    left join active ac on ac.day = g.d;

  return v_payload;
end;
$$;

-- ---------------------------------------------------------------------------
-- Indexes (justified in the file header; every one checked missing first).
-- ---------------------------------------------------------------------------
create index if not exists study_goals_room_created_idx
  on public.study_goals (room_id, created_at desc);

create index if not exists quiz_attempts_artifact_created_idx
  on public.quiz_attempts (artifact_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Grants: revoke-first, read-only surface, authenticated only. No base-table
-- grant appears in this file — the functions select through their definer.
-- ---------------------------------------------------------------------------
revoke execute on function public.analytics_me(uuid, integer) from public, anon;
revoke execute on function public.analytics_room(uuid, integer) from public, anon;
grant execute on function public.analytics_me(uuid, integer) to authenticated;
grant execute on function public.analytics_room(uuid, integer) to authenticated;

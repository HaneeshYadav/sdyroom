-- ---------------------------------------------------------------------------
-- PR 17 — Advanced room discovery: ranked listing, preview and filter options
-- as SECURITY DEFINER RPCs, plus the indexes their access paths need.
--
-- Why RPCs, not PostgREST table reads (same posture as 0002/0021): the
-- listing must (a) hard-code `visibility = 'public'` where the caller cannot
-- reach it, (b) compute `member_count` and the caller's own role across
-- `room_members` rows RLS would hide (`room_members_select_own`), and (c)
-- rank + keyset-paginate in SQL so a popular subject cannot stream the whole
-- table into the app. Each of those is a record/ranking decision, not a row
-- filter a policy can express. Base-table grants and policies are untouched:
-- this migration contains no `grant … on <table>` and no `create policy`.
--
-- Migration number: the spec pre-assigned `0016_discovery_indexes.sql`, but
-- 0018/0019/0020/0021 (ask history, quizzes, plans, analytics) took the
-- numbers after the 0013→0018 gap, so naming this file 0016 would apply it
-- *after* them on an existing database and *before* them on a fresh reset.
-- `0022` keeps strict chronological order; the spec and roadmap rows are
-- updated to match.
--
-- last_activity_at decision (spec required stating it): DERIVED, not
-- maintained. `greatest(max(focus_sessions.started_at),
-- max(room_messages.created_at))` per candidate room — no new column, no
-- trigger, no drift, and the cost is bounded by the rooms the filters select
-- (per-room maxima ride focus_sessions_room_started_idx and the new
-- room_messages_room_created_idx; a maintained column would add two write
-- triggers on hot tables to save work we have not measured). If discovery
-- latency ever demands it, a maintained column is the documented next step.
--
-- Ranking (only when a query is present and no explicit sort overrides it):
--   0 = exact name match (lower(name) = lower(q))
--   1 = prefix name match (lower(name) like lower(q)%)
--   2 = everything else that matched the q filter (name/subject/exam_track
--       contains) — then member_count desc, id desc.
-- The "shared subject/exam_track" leg of the spec's ranking sentence lives in
-- the WHERE clause: only matching rooms enter the set at all.
--
-- q matching is `ilike` contains over name/subject/exam_track with `%`, `_`
-- and `\` escaped in the parameter, so user input can never widen the match
-- or inject a pattern. Fuzzy/typo tolerance (trigram) is deliberately not
-- adopted — it needs an extension and invites content-scoring questions;
-- recorded as a standing question in the PR rather than half-shipped here.
--
-- Cursor: opaque base64(jsonb) at the API layer; the RPC receives the parsed
-- object and validates it per sort before use. Keyset only — no offset — so
-- pages cannot skip or duplicate rows under concurrent inserts, and nobody
-- can enumerate the table by walking offsets. Every sort appends `id` as the
-- tiebreaker (recent/active/largest/relevance desc, name asc). A malformed
-- cursor raises `22023`, which the route maps to 400 `validation`.
-- Sort keys:
--   recent    { c: created_at, i: id }        order (created_at, id) desc
--   active    { c: last_activity|null, i }    order (coalesce(last_activity,
--             '-infinity'), id) desc — JSON null means "no activity yet"
--   largest   { m: member_count, i }          order (member_count, id) desc
--   name      { n: name, i }                  order (name, id) asc
--   relevance { r: rank, m: member_count, i } order rank asc, then
--             (member_count, id) desc
--
-- Identity: `auth.uid()` is read inside each function and used ONLY to fill
-- `viewer_role`/`is_member` for the caller. No parameter can widen visibility
-- or point the aggregate at anyone else. anon executes nothing (revoke
-- first); the listing/preview/options are `authenticated`-only, and the
-- routes require a session before calling them.
--
-- Indexes (each checked missing against the live schema first):
--   * rooms_visibility_created_id_idx (visibility, created_at desc, id desc)
--       the `recent` sort and the default listing — the only rooms index that
--       leads with visibility, so public-only scans skip private rows early.
--   * rooms_visibility_subject_lower_idx / _exam_track_lower_ / _language_
--       (visibility, lower(col)) — the exact-lower filters and the q
--       contains path benefit from the leading visibility column; expression
--       indexes because the filters compare lower(col).
--   * room_messages_room_created_idx (room_id, created_at desc)
--       the derived last_activity max; the existing (room_id, seq desc)
--       index cannot order by created_at. focus_sessions already has
--       (room_id, started_at desc) from 0003, and room_members counts ride
--       the (room_id, user_id) primary key — neither is duplicated here.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- list_public_rooms — one round trip: filter, rank, keyset, enrich.
-- Returns at most p_limit + 1 rows so the caller can compute has_more
-- without a second count query. Never returns a private room.
-- ---------------------------------------------------------------------------
create or replace function public.list_public_rooms(
  p_q text default null,
  p_subject text default null,
  p_exam_track text default null,
  p_language text default null,
  p_min_members integer default 0,
  p_sort text default null,
  p_limit integer default 20,
  p_cursor jsonb default null
)
returns table (
  id uuid,
  name text,
  shared_goal text,
  subject text,
  exam_track text,
  language text,
  status text,
  capacity integer,
  member_count bigint,
  last_activity_at timestamptz,
  viewer_role text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_subject text := nullif(btrim(coalesce(p_subject, '')), '');
  v_exam_track text := nullif(btrim(coalesce(p_exam_track, '')), '');
  v_language text := nullif(btrim(coalesce(p_language, '')), '');
  v_min integer;
  v_limit integer;
  v_sort text;
  v_pattern text;
  v_prefix text;
  v_cursor_id uuid;
  v_c_created timestamptz;
  v_c_active timestamptz;
  v_c_name text;
  v_c_count bigint;
  v_c_rank integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'limit must be between 1 and 50' using errcode = '22023';
  end if;
  v_limit := p_limit;

  if p_min_members is null or p_min_members < 0 or p_min_members > 100 then
    raise exception 'min_members must be between 0 and 100' using errcode = '22023';
  end if;
  v_min := p_min_members;

  v_sort := nullif(btrim(coalesce(p_sort, '')), '');
  if v_sort is null then
    v_sort := case when v_q is not null then 'relevance' else 'recent' end;
  end if;
  if v_sort not in ('recent', 'active', 'largest', 'name', 'relevance') then
    raise exception 'invalid sort' using errcode = '22023';
  end if;
  if v_sort = 'relevance' and v_q is null then
    raise exception 'relevance sort requires a query' using errcode = '22023';
  end if;

  if v_q is not null then
    v_pattern := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_prefix := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    begin
      v_cursor_id := (p_cursor ->> 'i')::uuid;
    exception when others then
      raise exception 'invalid cursor' using errcode = '22023';
    end;
    if v_cursor_id is null then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
  end if;

  if v_sort = 'recent' then
    if p_cursor is not null then
      begin
        v_c_created := (p_cursor ->> 'c')::timestamptz;
      exception when others then
        raise exception 'invalid cursor' using errcode = '22023';
      end;
      if v_c_created is null then
        raise exception 'invalid cursor' using errcode = '22023';
      end if;
    end if;

    return query
    select
      r.id,
      r.name,
      r.shared_goal,
      r.subject,
      r.exam_track,
      r.language,
      r.status,
      r.capacity,
      (select count(*) from public.room_members m where m.room_id = r.id)::bigint,
      greatest(
        (select max(fs.started_at) from public.focus_sessions fs where fs.room_id = r.id),
        (select max(rm.created_at) from public.room_messages rm where rm.room_id = r.id)
      ),
      (select m2.role from public.room_members m2
        where m2.room_id = r.id and m2.user_id = v_uid),
      r.created_at
    from public.rooms r
    where r.visibility = 'public'
      and (v_q is null or r.name ilike v_pattern or r.subject ilike v_pattern or r.exam_track ilike v_pattern)
      and (v_subject is null or lower(r.subject) = lower(v_subject))
      and (v_exam_track is null or lower(r.exam_track) = lower(v_exam_track))
      and (v_language is null or lower(r.language) = lower(v_language))
      and (
        p_cursor is null
        or (r.created_at, r.id) < (v_c_created, v_cursor_id)
      )
      and (
        (select count(*) from public.room_members m where m.room_id = r.id) >= v_min
      )
    order by r.created_at desc, r.id desc
    limit v_limit + 1;

  elsif v_sort = 'active' then
    if p_cursor is not null then
      if p_cursor -> 'c' is null or jsonb_typeof(p_cursor -> 'c') = 'null' then
        v_c_active := '-infinity'::timestamptz;
      else
        begin
          v_c_active := (p_cursor ->> 'c')::timestamptz;
        exception when others then
          raise exception 'invalid cursor' using errcode = '22023';
        end;
        if v_c_active is null then
          raise exception 'invalid cursor' using errcode = '22023';
        end if;
      end if;
    end if;

    return query
    select
      r.id,
      r.name,
      r.shared_goal,
      r.subject,
      r.exam_track,
      r.language,
      r.status,
      r.capacity,
      (select count(*) from public.room_members m where m.room_id = r.id)::bigint,
      greatest(
        (select max(fs.started_at) from public.focus_sessions fs where fs.room_id = r.id),
        (select max(rm.created_at) from public.room_messages rm where rm.room_id = r.id)
      ),
      (select m2.role from public.room_members m2
        where m2.room_id = r.id and m2.user_id = v_uid),
      r.created_at
    from public.rooms r
    where r.visibility = 'public'
      and (v_q is null or r.name ilike v_pattern or r.subject ilike v_pattern or r.exam_track ilike v_pattern)
      and (v_subject is null or lower(r.subject) = lower(v_subject))
      and (v_exam_track is null or lower(r.exam_track) = lower(v_exam_track))
      and (v_language is null or lower(r.language) = lower(v_language))
      and (
        p_cursor is null
        or (
          coalesce(
            greatest(
              (select max(fs.started_at) from public.focus_sessions fs where fs.room_id = r.id),
              (select max(rm.created_at) from public.room_messages rm where rm.room_id = r.id)
            ),
            '-infinity'::timestamptz
          ),
          r.id
        ) < (v_c_active, v_cursor_id)
      )
      and (
        (select count(*) from public.room_members m where m.room_id = r.id) >= v_min
      )
    order by
      coalesce(
        greatest(
          (select max(fs.started_at) from public.focus_sessions fs where fs.room_id = r.id),
          (select max(rm.created_at) from public.room_messages rm where rm.room_id = r.id)
        ),
        '-infinity'::timestamptz
      ) desc,
      r.id desc
    limit v_limit + 1;

  elsif v_sort = 'largest' then
    if p_cursor is not null then
      begin
        v_c_count := (p_cursor ->> 'm')::bigint;
      exception when others then
        raise exception 'invalid cursor' using errcode = '22023';
      end;
      if v_c_count is null then
        raise exception 'invalid cursor' using errcode = '22023';
      end if;
    end if;

    return query
    select
      r.id,
      r.name,
      r.shared_goal,
      r.subject,
      r.exam_track,
      r.language,
      r.status,
      r.capacity,
      (select count(*) from public.room_members m where m.room_id = r.id)::bigint,
      greatest(
        (select max(fs.started_at) from public.focus_sessions fs where fs.room_id = r.id),
        (select max(rm.created_at) from public.room_messages rm where rm.room_id = r.id)
      ),
      (select m2.role from public.room_members m2
        where m2.room_id = r.id and m2.user_id = v_uid),
      r.created_at
    from public.rooms r
    where r.visibility = 'public'
      and (v_q is null or r.name ilike v_pattern or r.subject ilike v_pattern or r.exam_track ilike v_pattern)
      and (v_subject is null or lower(r.subject) = lower(v_subject))
      and (v_exam_track is null or lower(r.exam_track) = lower(v_exam_track))
      and (v_language is null or lower(r.language) = lower(v_language))
      and (
        p_cursor is null
        or (
          (select count(*) from public.room_members m where m.room_id = r.id)::bigint,
          r.id
        ) < (v_c_count, v_cursor_id)
      )
      and (
        (select count(*) from public.room_members m where m.room_id = r.id) >= v_min
      )
    order by
      (select count(*) from public.room_members m where m.room_id = r.id) desc,
      r.id desc
    limit v_limit + 1;

  elsif v_sort = 'name' then
    if p_cursor is not null then
      v_c_name := p_cursor ->> 'n';
      if v_c_name is null then
        raise exception 'invalid cursor' using errcode = '22023';
      end if;
    end if;

    return query
    select
      r.id,
      r.name,
      r.shared_goal,
      r.subject,
      r.exam_track,
      r.language,
      r.status,
      r.capacity,
      (select count(*) from public.room_members m where m.room_id = r.id)::bigint,
      greatest(
        (select max(fs.started_at) from public.focus_sessions fs where fs.room_id = r.id),
        (select max(rm.created_at) from public.room_messages rm where rm.room_id = r.id)
      ),
      (select m2.role from public.room_members m2
        where m2.room_id = r.id and m2.user_id = v_uid),
      r.created_at
    from public.rooms r
    where r.visibility = 'public'
      and (v_q is null or r.name ilike v_pattern or r.subject ilike v_pattern or r.exam_track ilike v_pattern)
      and (v_subject is null or lower(r.subject) = lower(v_subject))
      and (v_exam_track is null or lower(r.exam_track) = lower(v_exam_track))
      and (v_language is null or lower(r.language) = lower(v_language))
      and (
        p_cursor is null
        or (r.name, r.id) > (v_c_name, v_cursor_id)
      )
      and (
        (select count(*) from public.room_members m where m.room_id = r.id) >= v_min
      )
    order by r.name asc, r.id asc
    limit v_limit + 1;

  else -- relevance (v_q is not null; enforced above)
    if p_cursor is not null then
      begin
        v_c_rank := (p_cursor ->> 'r')::integer;
        v_c_count := (p_cursor ->> 'm')::bigint;
      exception when others then
        raise exception 'invalid cursor' using errcode = '22023';
      end;
      if v_c_rank is null or v_c_count is null then
        raise exception 'invalid cursor' using errcode = '22023';
      end if;
    end if;

    return query
    select
      r.id,
      r.name,
      r.shared_goal,
      r.subject,
      r.exam_track,
      r.language,
      r.status,
      r.capacity,
      mc.cnt,
      greatest(
        (select max(fs.started_at) from public.focus_sessions fs where fs.room_id = r.id),
        (select max(rm.created_at) from public.room_messages rm where rm.room_id = r.id)
      ),
      (select m2.role from public.room_members m2
        where m2.room_id = r.id and m2.user_id = v_uid),
      r.created_at
    from public.rooms r
    cross join lateral (
      select (select count(*) from public.room_members m where m.room_id = r.id)::bigint as cnt
    ) mc
    where r.visibility = 'public'
      and (r.name ilike v_pattern or r.subject ilike v_pattern or r.exam_track ilike v_pattern)
      and (v_subject is null or lower(r.subject) = lower(v_subject))
      and (v_exam_track is null or lower(r.exam_track) = lower(v_exam_track))
      and (v_language is null or lower(r.language) = lower(v_language))
      and mc.cnt >= v_min
      and (
        p_cursor is null
        or (
          case
            when lower(r.name) = lower(v_q) then 0
            when lower(r.name) like lower(v_prefix) then 1
            else 2
          end
        ) > v_c_rank
        or (
          (
            case
              when lower(r.name) = lower(v_q) then 0
              when lower(r.name) like lower(v_prefix) then 1
              else 2
            end
          ) = v_c_rank
          and (mc.cnt, r.id) < (v_c_count, v_cursor_id)
        )
      )
    order by
      case
        when lower(r.name) = lower(v_q) then 0
        when lower(r.name) like lower(v_prefix) then 1
        else 2
      end asc,
      mc.cnt desc,
      r.id desc
    limit v_limit + 1;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- room_preview — public-safe detail for one room. A member may preview their
-- own private room (the "Open room" path reuses this); everyone else gets the
-- same not_found a missing uuid gets, so the endpoint is not an existence
-- oracle. Member identities are never returned — counts only.
-- ---------------------------------------------------------------------------
create or replace function public.room_preview(p_room_id uuid)
returns table (
  id uuid,
  name text,
  shared_goal text,
  subject text,
  exam_track text,
  language text,
  visibility text,
  status text,
  capacity integer,
  member_count bigint,
  created_at timestamptz,
  is_member boolean,
  viewer_role text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_room record;
  v_role text;
begin
  if p_room_id is null then
    raise exception 'room not found' using errcode = 'P0002';
  end if;

  select
    r.id, r.name, r.shared_goal, r.subject, r.exam_track, r.language,
    r.visibility, r.status, r.capacity, r.created_at, r.owner_id
  into v_room
  from public.rooms r
  where r.id = p_room_id;

  if not found then
    raise exception 'room not found' using errcode = 'P0002';
  end if;

  if v_uid is not null and v_room.owner_id = v_uid then
    v_role := 'owner';
  else
    select m.role into v_role
    from public.room_members m
    where m.room_id = p_room_id and m.user_id = v_uid;
  end if;

  if v_room.visibility = 'private' and v_role is null then
    raise exception 'room not found' using errcode = 'P0002';
  end if;

  return query
  select
    v_room.id,
    v_room.name,
    v_room.shared_goal,
    v_room.subject,
    v_room.exam_track,
    v_room.language,
    v_room.visibility,
    v_room.status,
    v_room.capacity,
    (select count(*) from public.room_members m where m.room_id = p_room_id)::bigint,
    v_room.created_at,
    (v_role is not null),
    v_role;
end;
$$;

-- ---------------------------------------------------------------------------
-- room_filter_options — the distinct public values behind the subject /
-- exam-track / language selects. The columns are free text (0001), so the
-- UI cannot hard-code an enum; this reads distinct values from public rooms
-- only (private rooms contribute nothing, not even a value), capped at 100
-- each and ordered alphabetically so the options are deterministic.
-- ---------------------------------------------------------------------------
create or replace function public.room_filter_options()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'subjects', (
      select coalesce(jsonb_agg(x.val order by x.val), '[]'::jsonb)
      from (
        select distinct r.subject as val
        from public.rooms r
        where r.visibility = 'public'
          and r.subject is not null
          and btrim(r.subject) <> ''
        order by r.subject
        limit 100
      ) x
    ),
    'exam_tracks', (
      select coalesce(jsonb_agg(x.val order by x.val), '[]'::jsonb)
      from (
        select distinct r.exam_track as val
        from public.rooms r
        where r.visibility = 'public'
          and r.exam_track is not null
          and btrim(r.exam_track) <> ''
        order by r.exam_track
        limit 100
      ) x
    ),
    'languages', (
      select coalesce(jsonb_agg(x.val order by x.val), '[]'::jsonb)
      from (
        select distinct r.language as val
        from public.rooms r
        where r.visibility = 'public'
          and r.language is not null
          and btrim(r.language) <> ''
        order by r.language
        limit 100
      ) x
    )
  )
$$;

-- Indexes (see the header for the justification of each).
create index if not exists rooms_visibility_created_id_idx
  on public.rooms (visibility, created_at desc, id desc);

create index if not exists rooms_visibility_subject_lower_idx
  on public.rooms (visibility, lower(subject));

create index if not exists rooms_visibility_exam_track_lower_idx
  on public.rooms (visibility, lower(exam_track));

create index if not exists rooms_visibility_language_lower_idx
  on public.rooms (visibility, lower(language));

create index if not exists room_messages_room_created_idx
  on public.room_messages (room_id, created_at desc);

-- Grants: revoke-first, authenticated-only, exactly like 0002/0021. Nothing
-- executable is reachable by anon or by the public role.
revoke execute on function public.list_public_rooms(text, text, text, text, integer, text, integer, jsonb) from public, anon;
grant execute on function public.list_public_rooms(text, text, text, text, integer, text, integer, jsonb) to authenticated;

revoke execute on function public.room_preview(uuid) from public, anon;
grant execute on function public.room_preview(uuid) to authenticated;

revoke execute on function public.room_filter_options() from public, anon;
grant execute on function public.room_filter_options() to authenticated;

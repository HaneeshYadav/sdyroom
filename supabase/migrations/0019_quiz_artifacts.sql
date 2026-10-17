-- 0019_quiz_artifacts.sql — AI quizzes & flashcards (PR 14)
-- ---------------------------------------------------------------------------
-- Adds the artifact store for generated quizzes and flashcard decks, the
-- attempt/score ledger PR 16 will read, and the per-user flashcard review
-- schedule (SM-2-lite). Chunk storage, retrieval and the embed/chat ledgers
-- stay in 0013/0018; this migration never touches them.
--
-- Design notes (spec: docs/prs/PR-14-ai-quiz-flashcards.md):
--   1. `study_artifacts` is RPC-only for writes: no INSERT/UPDATE/DELETE
--      grant, no write policy. Rows appear through `create_artifact` (pins
--      `creator_id = auth.uid()`) and mutate only through `complete_artifact`
--      / `fail_artifact` / `delete_artifact`, each creator-checked. The
--      generated payload — including the answer key — lives server-side; a
--      client can never write or mutate it.
--   2. Scoring is server-side and deterministic: `record_attempt` pins
--      `user_id = auth.uid()`, re-checks membership and `status = 'ready'`,
--      and scores the submitted answers against `payload->questions` inside
--      the database. The client's answer array is advisory input only — a
--      tampered score field in the body is ignored because it is never read.
--      `quiz_attempts` columns (score, total, correct, created_at, user_id)
--      are PR 16's contract; get them right the first time.
--   3. Flashcard grading is one row per (artifact, user, card) via the
--      unique index and `review_card`'s upsert. The SM-2-lite schedule is
--      computed inside the RPC (server authority) from the fixed table that
--      `lib/ai/srs.ts` documents and unit-tests: `again` → streak 0,
--      interval 0, next review in 10 minutes, ease −0.2 (floor 1.3);
--      `got_it` → streak +1 and interval 1 / 3 / 7 / 14 / 30 days (capped)
--      by streak, ease unchanged.
--   4. Chat spend joins PR 12's ledger as `chat_tokens` through
--      `complete_artifact`, and the per-user daily cap (100 000 tokens, the
--      same set `record_qa` sums) is enforced inside the RPC, so a bypassed
--      route cannot spend unbounded tokens. The route pre-checks the same sum
--      through its own invoker-rights SELECT to answer 403 before any
--      provider call; both read identical sets. Retrieval (query-embedding)
--      spend is written as `embed_tokens`, mirroring `record_qa`.
--   5. Visibility: room members may read artifacts in their room (the quiz
--      runner needs the payload); attempt rows and review schedules are
--      own-row only, so no member can read another member's results or
--      spacing state. Deleting an artifact cascades attempts and reviews.

-- ---------------------------------------------------------------------------
-- Table: study_artifacts — one row per generated quiz or deck
-- ---------------------------------------------------------------------------
create table public.study_artifacts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  creator_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('quiz', 'deck')),
  status text not null default 'generating'
    check (status in ('generating', 'ready', 'failed')),
  error_code text check (
    error_code is null
    or error_code in ('no_documents_indexed', 'ai_provider_failed', 'ai_quota_exceeded')
  ),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  question_count integer check (
    question_count is null or question_count in (5, 10, 15, 20)
  ),
  card_count integer check (
    card_count is null or card_count in (10, 20, 40)
  ),
  resource_ids uuid[] not null default '{}'::uuid[]
    check (array_length(resource_ids, 1) between 1 and 25),
  payload jsonb check (payload is null or jsonb_typeof(payload) = 'object'),
  model text,
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- A ready artifact always carries a payload; a generating/failed one never does.
  constraint study_artifacts_ready_payload_check check (
    (status = 'ready') = (payload is not null)
  ),
  -- Quiz rows declare question_count; deck rows declare card_count.
  constraint study_artifacts_kind_counts_check check (
    (kind = 'quiz' and question_count is not null and card_count is null)
    or (kind = 'deck' and card_count is not null and question_count is null)
  )
);

create index study_artifacts_room_kind_created_idx
  on public.study_artifacts (room_id, kind, created_at desc);

create index study_artifacts_creator_created_idx
  on public.study_artifacts (creator_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Table: quiz_attempts — immutable score rows (PR 16's primary input)
-- ---------------------------------------------------------------------------
create table public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.study_artifacts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  answers jsonb not null default '[]'::jsonb
    check (jsonb_typeof(answers) = 'array'),
  score integer not null check (score >= 0),
  total integer not null check (total >= 0),
  correct jsonb not null default '[]'::jsonb
    check (jsonb_typeof(correct) = 'array'),
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 86400000),
  created_at timestamptz not null default now()
);

create index quiz_attempts_user_created_idx
  on public.quiz_attempts (user_id, created_at desc);

create index quiz_attempts_artifact_user_idx
  on public.quiz_attempts (artifact_id, user_id);

-- ---------------------------------------------------------------------------
-- Table: flashcard_reviews — one SM-2-lite row per (artifact, user, card)
-- ---------------------------------------------------------------------------
create table public.flashcard_reviews (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.study_artifacts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  card_ordinal integer not null check (card_ordinal >= 0),
  grade text not null check (grade in ('again', 'got_it')),
  streak integer not null default 0 check (streak >= 0),
  ease real not null default 2.5 check (ease >= 1.3),
  interval_days integer not null default 0 check (interval_days >= 0),
  last_reviewed_at timestamptz not null default now(),
  next_review_at timestamptz not null,
  unique (artifact_id, user_id, card_ordinal)
);

create index flashcard_reviews_user_next_idx
  on public.flashcard_reviews (user_id, next_review_at);

-- ---------------------------------------------------------------------------
-- Grants: revoke-first, then the narrowest surface that serves the API.
-- SELECT is column-scoped everywhere: token accounting never leaves the
-- server, and a wildcard SELECT fails outright (insufficient_privilege), the
-- same posture as 0013/0018. No INSERT/UPDATE/DELETE for any application
-- role on any of the three tables.
-- ---------------------------------------------------------------------------
revoke all on public.study_artifacts from anon, authenticated, service_role;
revoke all on public.quiz_attempts from anon, authenticated, service_role;
revoke all on public.flashcard_reviews from anon, authenticated, service_role;

grant select (
  id,
  room_id,
  creator_id,
  kind,
  status,
  error_code,
  difficulty,
  question_count,
  card_count,
  resource_ids,
  payload,
  model,
  created_at,
  completed_at
) on public.study_artifacts to authenticated;
-- prompt_tokens / completion_tokens are deliberately ungranted.

grant select (
  id,
  artifact_id,
  user_id,
  answers,
  score,
  total,
  correct,
  duration_ms,
  created_at
) on public.quiz_attempts to authenticated;

grant select (
  id,
  artifact_id,
  user_id,
  card_ordinal,
  grade,
  streak,
  ease,
  interval_days,
  last_reviewed_at,
  next_review_at
) on public.flashcard_reviews to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.study_artifacts enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.flashcard_reviews enable row level security;

-- Room members read the artifacts of their room (payload included — the quiz
-- runner needs it; the answer key is hidden by the UI until submit, and
-- scoring never trusts the client).
create policy "study_artifacts_select_member"
  on public.study_artifacts
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.room_members m
       where m.room_id = study_artifacts.room_id
         and m.user_id = auth.uid()
    )
  );

-- Own attempts only. Membership rides along as the second layer so a stale
-- row can never outlive access to the room.
create policy "quiz_attempts_select_own"
  on public.quiz_attempts
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1
        from public.study_artifacts a
        join public.room_members m on m.room_id = a.room_id
       where a.id = quiz_attempts.artifact_id
         and m.user_id = auth.uid()
    )
  );

-- Own review schedules only, same second layer.
create policy "flashcard_reviews_select_own"
  on public.flashcard_reviews
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1
        from public.study_artifacts a
        join public.room_members m on m.room_id = a.room_id
       where a.id = flashcard_reviews.artifact_id
         and m.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy exists on any of the three tables, and no
-- matching grant does either — two independent layers, every write travels
-- through the SECURITY DEFINER functions below.

-- ---------------------------------------------------------------------------
-- RPC: create_artifact — the table's only insert path
-- ---------------------------------------------------------------------------
-- Pins creator_id = auth.uid(), re-validates room membership, re-checks that
-- every requested resource is accessible to the caller (room-shared in this
-- room, or the caller's own personal file) and has a `ready` AI document, and
-- validates the kind/count/difficulty domain. A forged resource id can never
-- enter an artifact.
create or replace function public.create_artifact(
  p_room_id uuid,
  p_kind text,
  p_difficulty text,
  p_count integer,
  p_resource_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.study_artifacts;
  v_inaccessible uuid;
  v_not_ready uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_room_id is null or not exists (
    select 1
      from public.room_members m
     where m.room_id = p_room_id
       and m.user_id = auth.uid()
  ) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if p_kind not in ('quiz', 'deck') then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_difficulty not in ('easy', 'medium', 'hard') then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_kind = 'quiz' and coalesce(p_count, 0) not in (5, 10, 15, 20) then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_kind = 'deck' and coalesce(p_count, 0) not in (10, 20, 40) then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_resource_ids is null
     or coalesce(array_length(p_resource_ids, 1), 0) < 1
     or array_length(p_resource_ids, 1) > 25 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  -- Accessibility re-check (definer reads study_resources directly): every id
  -- must be a room file of THIS room, or the caller's own personal file.
  select s.id into v_inaccessible
    from unnest(p_resource_ids) r (id)
    left join public.study_resources s
      on s.id = r.id
     and (s.room_id = p_room_id or (s.room_id is null and s.owner_id = auth.uid()))
   where s.id is null
   limit 1;

  if v_inaccessible is not null then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  -- Every requested document must be indexed and ready.
  select r.id into v_not_ready
    from unnest(p_resource_ids) r (id)
   where not exists (
     select 1
       from public.study_ai_documents d
      where d.resource_id = r.id
        and d.status = 'ready'
   )
   limit 1;

  if v_not_ready is not null then
    raise exception 'no_documents_indexed' using errcode = 'P0001';
  end if;

  insert into public.study_artifacts (
    room_id,
    creator_id,
    kind,
    difficulty,
    question_count,
    card_count,
    resource_ids,
    status
  )
  values (
    p_room_id,
    auth.uid(),
    p_kind,
    p_difficulty,
    case when p_kind = 'quiz' then p_count end,
    case when p_kind = 'deck' then p_count end,
    p_resource_ids,
    'generating'
  )
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'kind', v_row.kind,
    'status', v_row.status,
    'difficulty', v_row.difficulty,
    'question_count', to_jsonb(v_row.question_count),
    'card_count', to_jsonb(v_row.card_count),
    'created_at', v_row.created_at
  );
end;
$$;

revoke execute on function public.create_artifact(uuid, text, text, integer, uuid[])
  from public, anon;
grant execute on function public.create_artifact(uuid, text, text, integer, uuid[])
  to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: complete_artifact — generating → ready (creator only, idempotent)
-- ---------------------------------------------------------------------------
-- Validates the payload against the row's declared counts (a ready artifact
-- always matches), enforces the per-user daily chat-token cap, writes the
-- chat/retrieval usage ledger in the same transaction, and only then flips
-- the row to ready. Malformed payloads raise `validation` and leave the row
-- in `generating` so `fail_artifact` (or a retry) decides its fate — a
-- half-parsed artifact can never become ready.
create or replace function public.complete_artifact(
  p_artifact_id uuid,
  p_payload jsonb,
  p_model text default null,
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
  v_row public.study_artifacts;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_row
    from public.study_artifacts
   where id = p_artifact_id
   for update;

  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.creator_id <> auth.uid() then
    raise exception 'not_creator' using errcode = 'P0001';
  end if;

  if v_row.status = 'ready' then
    return jsonb_build_object(
      'id', v_row.id,
      'status', v_row.status,
      'question_count', to_jsonb(v_row.question_count),
      'card_count', to_jsonb(v_row.card_count),
      'deduped', true
    );
  end if;

  if v_row.status <> 'generating' then
    raise exception 'artifact_failed' using errcode = 'P0001';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if v_row.kind = 'quiz' then
    if jsonb_typeof(p_payload->'questions') <> 'array'
       or jsonb_array_length(p_payload->'questions') <> v_row.question_count then
      raise exception 'validation' using errcode = 'P0001';
    end if;
  else
    if jsonb_typeof(p_payload->'cards') <> 'array'
       or jsonb_array_length(p_payload->'cards') <> v_row.card_count then
      raise exception 'validation' using errcode = 'P0001';
    end if;
  end if;

  if coalesce(p_prompt_tokens, 0) < 0
     or coalesce(p_completion_tokens, 0) < 0
     or coalesce(p_retrieval_tokens, 0) < 0 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0)
    into v_used
    from public.ai_usage
   where kind = 'chat_tokens'
     and user_id = auth.uid()
     and created_at >= v_day_start;

  if v_used + coalesce(p_prompt_tokens, 0) + coalesce(p_completion_tokens, 0)
       > v_chat_daily_limit then
    update public.study_artifacts
       set status = 'failed',
           error_code = 'ai_quota_exceeded',
           completed_at = now()
     where id = p_artifact_id;
    raise exception 'ai_quota_exceeded' using errcode = 'P0001';
  end if;

  update public.study_artifacts
     set status = 'ready',
         payload = p_payload,
         model = p_model,
         prompt_tokens = coalesce(p_prompt_tokens, 0),
         completion_tokens = coalesce(p_completion_tokens, 0),
         error_code = null,
         completed_at = now()
   where id = p_artifact_id
   returning * into v_row;

  insert into public.ai_usage (room_id, user_id, kind, amount)
  select v_row.room_id, auth.uid(), 'chat_tokens',
         coalesce(p_prompt_tokens, 0) + coalesce(p_completion_tokens, 0)
  where coalesce(p_prompt_tokens, 0) + coalesce(p_completion_tokens, 0) > 0;

  insert into public.ai_usage (room_id, user_id, kind, amount)
  select v_row.room_id, auth.uid(), 'embed_tokens', coalesce(p_retrieval_tokens, 0)
  where coalesce(p_retrieval_tokens, 0) > 0;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'question_count', to_jsonb(v_row.question_count),
    'card_count', to_jsonb(v_row.card_count),
    'model', v_row.model,
    'deduped', false,
    'chat_used_today', v_used
      + coalesce(p_prompt_tokens, 0) + coalesce(p_completion_tokens, 0),
    'chat_limit', v_chat_daily_limit
  );
end;
$$;

revoke execute on function public.complete_artifact(uuid, jsonb, text, integer, integer, integer)
  from public, anon;
grant execute on function public.complete_artifact(uuid, jsonb, text, integer, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: fail_artifact — generating → failed with an honest error code
-- ---------------------------------------------------------------------------
create or replace function public.fail_artifact(
  p_artifact_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.study_artifacts;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_error_code not in ('no_documents_indexed', 'ai_provider_failed', 'ai_quota_exceeded') then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  select * into v_row
    from public.study_artifacts
   where id = p_artifact_id
   for update;

  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.creator_id <> auth.uid() then
    raise exception 'not_creator' using errcode = 'P0001';
  end if;

  if v_row.status = 'ready' then
    return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'deduped', true);
  end if;

  if v_row.status = 'failed' then
    return jsonb_build_object(
      'id', v_row.id,
      'status', v_row.status,
      'error_code', v_row.error_code,
      'deduped', true
    );
  end if;

  update public.study_artifacts
     set status = 'failed',
         error_code = p_error_code,
         completed_at = now()
   where id = p_artifact_id
   returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'error_code', v_row.error_code,
    'deduped', false
  );
end;
$$;

revoke execute on function public.fail_artifact(uuid, text) from public, anon;
grant execute on function public.fail_artifact(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: delete_artifact — creator only; cascades attempts + reviews
-- ---------------------------------------------------------------------------
create or replace function public.delete_artifact(p_artifact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.study_artifacts;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_row
    from public.study_artifacts
   where id = p_artifact_id
   for update;

  -- Invisible (non-member or missing) is indistinguishable from missing.
  if v_row.id is null or not exists (
    select 1
      from public.room_members m
     where m.room_id = v_row.room_id
       and m.user_id = auth.uid()
  ) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_row.creator_id <> auth.uid() then
    raise exception 'not_creator' using errcode = 'P0001';
  end if;

  delete from public.study_artifacts where id = p_artifact_id;

  return jsonb_build_object('deleted', true, 'id', p_artifact_id);
end;
$$;

revoke execute on function public.delete_artifact(uuid) from public, anon;
grant execute on function public.delete_artifact(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: record_attempt — the only insert path into quiz_attempts
-- ---------------------------------------------------------------------------
-- Pins user_id = auth.uid(), re-checks membership and that the artifact is a
-- ready quiz, validates the answers array against the payload's question
-- count, and scores server-side against the stored answer key. The response
-- carries the per-question explanations and citations from the payload, so
-- the client never supplies any of it.
create or replace function public.record_attempt(
  p_artifact_id uuid,
  p_answers jsonb default '[]'::jsonb,
  p_duration_ms integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_art public.study_artifacts;
  v_row public.quiz_attempts;
  v_questions jsonb;
  v_total integer;
  v_score integer := 0;
  v_correct jsonb := '[]'::jsonb;
  v_results jsonb := '[]'::jsonb;
  v_chosen integer;
  v_expected integer;
  v_is_correct boolean;
  i integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_art
    from public.study_artifacts
   where id = p_artifact_id;

  if v_art.id is null or not exists (
    select 1
      from public.room_members m
     where m.room_id = v_art.room_id
       and m.user_id = auth.uid()
  ) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_art.kind <> 'quiz' or v_art.status <> 'ready' or v_art.payload is null then
    raise exception 'artifact_not_ready' using errcode = 'P0001';
  end if;

  if p_duration_ms is not null
     and (p_duration_ms < 0 or p_duration_ms > 86400000) then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  v_questions := v_art.payload->'questions';
  v_total := jsonb_array_length(v_questions);

  if p_answers is null or jsonb_typeof(p_answers) <> 'array'
     or jsonb_array_length(p_answers) <> v_total then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  for i in 0 .. v_total - 1 loop
    if jsonb_typeof(v_questions->i) <> 'object'
       or jsonb_typeof(v_questions->i->'options') <> 'array'
       or jsonb_typeof(v_questions->i->'correct_index') <> 'number' then
      raise exception 'validation' using errcode = 'P0001';
    end if;

    if jsonb_typeof(p_answers->i) = 'number' then
      v_chosen := (p_answers->>i)::integer;
      if v_chosen < 0 or v_chosen >= jsonb_array_length(v_questions->i->'options') then
        raise exception 'validation' using errcode = 'P0001';
      end if;
    elsif p_answers->i is null or jsonb_typeof(p_answers->i) = 'null' then
      v_chosen := null;
    else
      raise exception 'validation' using errcode = 'P0001';
    end if;

    v_expected := (v_questions->i->>'correct_index')::integer;
    v_is_correct := (v_chosen is not null and v_chosen = v_expected);

    if v_is_correct then
      v_score := v_score + 1;
    end if;

    v_correct := v_correct || to_jsonb(v_is_correct);
    v_results := v_results || jsonb_build_object(
      'ordinal', i,
      'chosen', to_jsonb(v_chosen),
      'correct_index', v_expected,
      'explanation', coalesce(v_questions->i->'explanation', '""'::jsonb),
      'citations', coalesce(v_questions->i->'citations', '[]'::jsonb)
    );
  end loop;

  insert into public.quiz_attempts (
    artifact_id,
    user_id,
    answers,
    score,
    total,
    correct,
    duration_ms
  )
  values (
    p_artifact_id,
    auth.uid(),
    p_answers,
    v_score,
    v_total,
    v_correct,
    p_duration_ms
  )
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'score', v_row.score,
    'total', v_row.total,
    'correct', v_row.correct,
    'results', v_results,
    'duration_ms', to_jsonb(v_row.duration_ms),
    'created_at', v_row.created_at
  );
end;
$$;

revoke execute on function public.record_attempt(uuid, jsonb, integer) from public, anon;
grant execute on function public.record_attempt(uuid, jsonb, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: review_card — the only write path into flashcard_reviews
-- ---------------------------------------------------------------------------
-- SM-2-lite, computed here as the authority (lib/ai/srs.ts documents the same
-- table for the UI and unit tests; an integration test freezes both):
--   again → streak 0, interval 0, next review now + 10 minutes,
--           ease − 0.2 (floor 1.3)
--   got_it → streak + 1, interval 1 / 3 / 7 / 14 / 30 days by streak
--            (capped at 30), ease unchanged, next review now + interval
-- Upserts on (artifact_id, user_id, card_ordinal), so grading a card twice
-- moves the schedule instead of stacking rows.
create or replace function public.review_card(
  p_artifact_id uuid,
  p_card_ordinal integer,
  p_grade text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_art public.study_artifacts;
  v_row public.flashcard_reviews;
  v_streak integer;
  v_ease real;
  v_interval integer;
  v_next timestamptz;
  v_due integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_art
    from public.study_artifacts
   where id = p_artifact_id;

  if v_art.id is null or not exists (
    select 1
      from public.room_members m
     where m.room_id = v_art.room_id
       and m.user_id = auth.uid()
  ) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_art.kind <> 'deck' or v_art.status <> 'ready' then
    raise exception 'artifact_not_ready' using errcode = 'P0001';
  end if;

  if p_card_ordinal is null or p_card_ordinal < 0
     or p_card_ordinal >= coalesce(v_art.card_count, 0) then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_grade not in ('again', 'got_it') then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  select * into v_row
    from public.flashcard_reviews
   where artifact_id = p_artifact_id
     and user_id = auth.uid()
     and card_ordinal = p_card_ordinal;

  if p_grade = 'again' then
    v_streak := 0;
    v_ease := greatest(1.3, coalesce(v_row.ease, 2.5) - 0.2);
    v_interval := 0;
    v_next := now() + interval '10 minutes';
  else
    v_streak := coalesce(v_row.streak, 0) + 1;
    v_ease := coalesce(v_row.ease, 2.5);
    v_interval := case
      when v_streak <= 1 then 1
      when v_streak = 2 then 3
      when v_streak = 3 then 7
      when v_streak = 4 then 14
      else 30
    end;
    v_next := now() + make_interval(days => v_interval);
  end if;

  insert into public.flashcard_reviews (
    artifact_id,
    user_id,
    card_ordinal,
    grade,
    streak,
    ease,
    interval_days,
    last_reviewed_at,
    next_review_at
  )
  values (
    p_artifact_id,
    auth.uid(),
    p_card_ordinal,
    p_grade,
    v_streak,
    v_ease,
    v_interval,
    now(),
    v_next
  )
  on conflict (artifact_id, user_id, card_ordinal)
  do update set
    grade = excluded.grade,
    streak = excluded.streak,
    ease = excluded.ease,
    interval_days = excluded.interval_days,
    last_reviewed_at = excluded.last_reviewed_at,
    next_review_at = excluded.next_review_at
  returning * into v_row;

  -- Due = never reviewed OR overdue. Counting only overdue review rows
  -- would report 0 due the moment a session starts (nothing has been
  -- reviewed yet), which is the opposite of what the deck UI shows.
  select count(*)::integer
    into v_due
    from generate_series(0, coalesce(v_art.card_count, 1) - 1) as s(ord)
   where not exists (
         select 1 from public.flashcard_reviews r
          where r.artifact_id = p_artifact_id
            and r.user_id = auth.uid()
            and r.card_ordinal = ord
       )
       or exists (
         select 1 from public.flashcard_reviews r
          where r.artifact_id = p_artifact_id
            and r.user_id = auth.uid()
            and r.card_ordinal = ord
            and r.next_review_at <= now()
       );

  return jsonb_build_object(
    'next_review_at', v_row.next_review_at,
    'interval_days', v_row.interval_days,
    'streak', v_row.streak,
    'due_count', v_due
  );
end;
$$;

revoke execute on function public.review_card(uuid, integer, text) from public, anon;
grant execute on function public.review_card(uuid, integer, text) to authenticated;

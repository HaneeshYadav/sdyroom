-- 0018_qa_history.sql — "Ask my notes" conversation history (PR 13)
-- ---------------------------------------------------------------------------
-- Adds the append-only Q/A ledger the ask pipeline writes after each completed
-- answer, plus the SECURITY DEFINER writer that is the table's only insert
-- path. Chunk storage, retrieval and the embed ledger stay in 0013; this
-- migration never touches them.
--
-- Design notes (spec: docs/prs/PR-13-ask-my-notes.md):
--   1. `study_qa` is append-only for application roles: no UPDATE or DELETE
--      grant, no write policy. Rows appear only through `record_qa`, which
--      pins `user_id = auth.uid()` — a caller can never attribute a question
--      or an answer to someone else, and never spend another user's quota.
--   2. v1 visibility is the asker's own rows (policy below), plus room
--      membership as a second layer so a stale row can never outlive access
--      to the room. A room-wide shared history is deliberately out of scope.
--   3. Chat spend joins PR 12's ledger as `chat_tokens` (the kind already
--      existed in 0013's CHECK). The daily cap is per user per UTC day and is
--      enforced inside `record_qa`, so a bypassed route cannot spend
--      unbounded tokens. The route pre-checks the same sum through its own
--      invoker-rights SELECT (own rows only) to answer 403 before any provider
--      call; both read identical sets, so the numbers cannot diverge.
--   4. Double-submit: `record_qa` looks for the same (user, conversation,
--      question) row inside a 60-second window and answers with the existing
--      row instead of inserting a duplicate — the provider call is skipped by
--      the route before it ever reaches here, and this check closes the
--      concurrent-race hole for two in-flight submits.
--   5. `retrieval_tokens` records the query-embedding spend of the ask that
--      produced the row (kind `embed_tokens`), so ask retrieval is accounted
--      for like every other embedding call.

create table public.study_qa (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  conversation_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  question text not null check (length(btrim(question)) between 1 and 2000),
  answer text not null check (length(btrim(answer)) >= 1),
  citations jsonb not null default '[]'::jsonb
    check (jsonb_typeof(citations) = 'array'),
  model text,
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  retrieval_tokens integer not null default 0 check (retrieval_tokens >= 0),
  retrieved_chunks integer not null default 0 check (retrieved_chunks >= 0),
  created_at timestamptz not null default now()
);

create index study_qa_room_created_idx
  on public.study_qa (room_id, created_at desc);

create index study_qa_conversation_created_idx
  on public.study_qa (conversation_id, created_at);

-- The duplicate-window lookup (same user + conversation + question, last
-- minute) is a sequential scan over a user's recent rows; bounded by the
-- per-user rate limit and the tiny window, so no extra index is warranted.

-- ---------------------------------------------------------------------------
-- Grants: revoke-first, then the narrowest surface that serves the API.
-- SELECT is column-scoped (the history contract returns id, question, answer,
-- citations, conversation_id, created_at — token accounting never leaves the
-- server). No INSERT/UPDATE/DELETE for any application role.
-- ---------------------------------------------------------------------------
revoke all on public.study_qa from anon, authenticated, service_role;

grant select (
  id,
  room_id,
  conversation_id,
  user_id,
  question,
  answer,
  citations,
  created_at
) on public.study_qa to authenticated;
-- Token accounting and model fields are deliberately ungranted: the history
-- contract never returns them, and withholding them makes a wildcard SELECT
-- fail outright (insufficient_privilege), the same posture as 0013's
-- document_chunks.

alter table public.study_qa enable row level security;

-- v1: own rows only. Membership is the second layer — history for a room the
-- caller has left disappears even if a row somehow survived.
create policy "study_qa_select_own"
  on public.study_qa
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1
        from public.room_members m
       where m.room_id = study_qa.room_id
         and m.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy exists, and no matching grant does either —
-- two independent layers, the same posture as 0013's AI tables.

-- ---------------------------------------------------------------------------
-- RPC: record_qa — the table's only insert path
-- ---------------------------------------------------------------------------
-- Pins user_id = auth.uid(), re-validates room membership, enforces the
-- per-user daily chat-token cap, deduplicates a same-question double-submit
-- inside a 60-second window, and writes the chat/retrieval usage ledger in
-- the same transaction as the row. Returns the stored row's identity plus the
-- day's totals so a route can surface quota state without a second query.
create or replace function public.record_qa(
  p_room_id uuid,
  p_conversation_id uuid,
  p_question text,
  p_answer text,
  p_citations jsonb default '[]'::jsonb,
  p_model text default null,
  p_prompt_tokens integer default 0,
  p_completion_tokens integer default 0,
  p_retrieval_tokens integer default 0,
  p_retrieved_chunks integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chat_daily_limit constant integer := 100000; -- chat tokens / user / UTC day
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_used integer := 0;
  v_row public.study_qa;
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

  if p_conversation_id is null then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_question is null or length(btrim(p_question)) < 1 or length(p_question) > 2000 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_answer is null or length(btrim(p_answer)) < 1 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if p_citations is null or jsonb_typeof(p_citations) <> 'array' then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  if coalesce(p_prompt_tokens, 0) < 0
     or coalesce(p_completion_tokens, 0) < 0
     or coalesce(p_retrieval_tokens, 0) < 0
     or coalesce(p_retrieved_chunks, 0) < 0 then
    raise exception 'validation' using errcode = 'P0001';
  end if;

  -- Double-submit window: the same question in the same conversation within
  -- the last minute answers with the existing row instead of a duplicate.
  select * into v_row
    from public.study_qa
   where user_id = auth.uid()
     and conversation_id = p_conversation_id
     and question = p_question
     and created_at > now() - interval '60 seconds'
   order by created_at desc
   limit 1;

  if found then
    return jsonb_build_object(
      'qa_id', v_row.id,
      'conversation_id', v_row.conversation_id,
      'created_at', v_row.created_at,
      'deduped', true,
      'chat_used_today', (
        select coalesce(sum(amount), 0)
          from public.ai_usage
         where kind = 'chat_tokens'
           and user_id = auth.uid()
           and created_at >= v_day_start
      ),
      'chat_limit', v_chat_daily_limit
    );
  end if;

  select coalesce(sum(amount), 0)
    into v_used
    from public.ai_usage
   where kind = 'chat_tokens'
     and user_id = auth.uid()
     and created_at >= v_day_start;

  if v_used + coalesce(p_prompt_tokens, 0) + coalesce(p_completion_tokens, 0)
       > v_chat_daily_limit then
    raise exception 'ai_quota_exceeded' using errcode = 'P0001';
  end if;

  insert into public.study_qa (
    room_id,
    conversation_id,
    user_id,
    question,
    answer,
    citations,
    model,
    prompt_tokens,
    completion_tokens,
    retrieval_tokens,
    retrieved_chunks
  )
  values (
    p_room_id,
    p_conversation_id,
    auth.uid(),
    btrim(p_question),
    p_answer,
    p_citations,
    p_model,
    coalesce(p_prompt_tokens, 0),
    coalesce(p_completion_tokens, 0),
    coalesce(p_retrieval_tokens, 0),
    coalesce(p_retrieved_chunks, 0)
  )
  returning * into v_row;

  insert into public.ai_usage (room_id, user_id, kind, amount)
  select p_room_id, auth.uid(), 'chat_tokens',
         coalesce(p_prompt_tokens, 0) + coalesce(p_completion_tokens, 0)
  where coalesce(p_prompt_tokens, 0) + coalesce(p_completion_tokens, 0) > 0;

  insert into public.ai_usage (room_id, user_id, kind, amount)
  select p_room_id, auth.uid(), 'embed_tokens', coalesce(p_retrieval_tokens, 0)
  where coalesce(p_retrieval_tokens, 0) > 0;

  return jsonb_build_object(
    'qa_id', v_row.id,
    'conversation_id', v_row.conversation_id,
    'created_at', v_row.created_at,
    'deduped', false,
    'chat_used_today', v_used
      + coalesce(p_prompt_tokens, 0) + coalesce(p_completion_tokens, 0),
    'chat_limit', v_chat_daily_limit
  );
end;
$$;

revoke execute on function public.record_qa(uuid, uuid, text, text, jsonb, text, integer, integer, integer, integer)
  from public, anon;
grant execute on function public.record_qa(uuid, uuid, text, text, jsonb, text, integer, integer, integer, integer)
  to authenticated;

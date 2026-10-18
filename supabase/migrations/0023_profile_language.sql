-- PR 20: preferred-language column on profiles.
--
-- profiles carried exam_targets from 0001 but never a language, so the
-- settings page had nowhere to record the student's preferred language.
-- The column is nullable: "no preference" is the default state, which keeps
-- every existing row valid and lets the settings form clear the field.
--
-- Value rules mirror rooms.language (0001's free-text column): trimmed, at
-- most 40 characters. The *vocabulary* itself is enforced at the API
-- boundary — lib/validation/profile.ts and the room-create form share one
-- constant — so widening that list later never needs a migration. The
-- database only keeps the structural checks.
alter table public.profiles add column language text;

alter table public.profiles
  add constraint profiles_language_len
  check (language is null or char_length(language) between 1 and 40);

alter table public.profiles
  add constraint profiles_language_trimmed
  check (language is null or language = btrim(language));

-- Grant discipline (0001/0012 pattern): column privileges on profiles are
-- explicit and additive, so a new column starts out ungranted until it is
-- handed to exactly the roles that need it. anon has never held profiles
-- privileges (0001 granted it none) — the revoke re-asserts that floor so a
-- stray default privilege can never widen the table's exposure. This PR
-- does not widen any existing privilege: it adds one column to the three
-- grants authenticated already holds.
revoke all on table public.profiles from anon;

grant select (language) on public.profiles to authenticated;
grant insert (language) on public.profiles to authenticated;
grant update (language) on public.profiles to authenticated;

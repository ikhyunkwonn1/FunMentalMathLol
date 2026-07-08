-- Login-free global leaderboard for Numberline.
-- Run this in the Supabase SQL editor.

create table if not exists public.leaderboard_scores (
  id bigint generated always as identity primary key,
  username text,
  streak integer not null check (streak >= 0),
  score integer not null check (score >= 0),
  starting_time_seconds numeric(4, 1) not null,
  time_multiplier numeric(5, 3) not null,
  operator_mode text not null default 'both',
  played_at_utc timestamptz not null default (
    date_trunc('minute', statement_timestamp() at time zone 'UTC') at time zone 'UTC'
  ),
  created_at timestamptz not null default statement_timestamp(),
  constraint leaderboard_default_settings_check check (
    starting_time_seconds = 10.0
    and time_multiplier = 0.925
    and operator_mode = 'both'
  )
);

alter table public.leaderboard_scores
  add column if not exists operator_mode text not null default 'both';

alter table public.leaderboard_scores
  drop constraint if exists leaderboard_default_settings_check;

alter table public.leaderboard_scores
  add constraint leaderboard_default_settings_check check (
    starting_time_seconds = 10.0
    and time_multiplier = 0.925
    and operator_mode = 'both'
  );

create index if not exists leaderboard_scores_rank_idx
  on public.leaderboard_scores (score desc, streak desc, played_at_utc asc, id asc);

alter table public.leaderboard_scores enable row level security;

revoke all on public.leaderboard_scores from anon, authenticated;

drop function if exists public.submit_leaderboard_score(integer, integer, numeric, numeric, text, text);
drop function if exists public.get_leaderboard();
drop view if exists public.leaderboard;

create view public.leaderboard as
select
  ranked.rank,
  ranked.id,
  ranked.streak,
  ranked.score,
  ranked."time"
from (
  select
    (row_number() over (
      order by leaderboard_scores.score desc,
        leaderboard_scores.streak desc,
        leaderboard_scores.played_at_utc asc,
        leaderboard_scores.id asc
    ))::integer as rank,
    coalesce(nullif(leaderboard_scores.username, ''), 'Player') as id,
    leaderboard_scores.streak,
    leaderboard_scores.score,
    to_char(leaderboard_scores.played_at_utc at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as "time"
  from public.leaderboard_scores
) ranked
order by ranked.rank;

create or replace function public.get_leaderboard()
returns table (
  rank integer,
  id text,
  streak integer,
  score integer,
  "time" text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    leaderboard.rank,
    leaderboard.id,
    leaderboard.streak,
    leaderboard.score,
    leaderboard."time"
  from public.leaderboard
  order by leaderboard.rank asc;
$$;

create or replace function public.qualifies_for_leaderboard(
  p_streak integer,
  p_score integer,
  p_starting_time_seconds numeric,
  p_time_multiplier numeric,
  p_operator_mode text default 'both'
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_starting_time numeric(4, 1) := round(p_starting_time_seconds, 1);
  normalized_time_multiplier numeric(5, 3) := round(p_time_multiplier, 3);
  normalized_operator_mode text := coalesce(p_operator_mode, '');
  score_count integer;
  tenth_score integer;
begin
  if p_streak is null or p_score is null or p_streak < 0 or p_score < 0 then
    return false;
  end if;

  if normalized_starting_time is distinct from 10.0
    or normalized_time_multiplier is distinct from 0.925
    or normalized_operator_mode is distinct from 'both' then
    return false;
  end if;

  select count(*) into score_count
  from public.leaderboard_scores;

  if score_count < 10 then
    return true;
  end if;

  select min(leaderboard_scores.score) into tenth_score
  from public.leaderboard_scores;

  return p_score > tenth_score;
end;
$$;

create or replace function public.submit_leaderboard_score(
  p_streak integer,
  p_score integer,
  p_starting_time_seconds numeric,
  p_time_multiplier numeric,
  p_operator_mode text default 'both',
  p_username text default null
)
returns table (
  rank integer,
  id text,
  streak integer,
  score integer,
  "time" text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_starting_time numeric(4, 1) := round(p_starting_time_seconds, 1);
  normalized_time_multiplier numeric(5, 3) := round(p_time_multiplier, 3);
  normalized_operator_mode text := coalesce(p_operator_mode, '');
  score_count integer;
  tenth_score integer;
begin
  if p_streak is null or p_score is null or p_streak < 0 or p_score < 0 then
    raise exception 'streak and score must be non-negative'
      using errcode = '22023';
  end if;

  -- Custom settings are valid game results, but not eligible for this leaderboard.
  if not public.qualifies_for_leaderboard(
    p_streak,
    p_score,
    normalized_starting_time,
    normalized_time_multiplier,
    normalized_operator_mode
  ) then
    return query select * from public.get_leaderboard();
    return;
  end if;

  lock table public.leaderboard_scores in exclusive mode;

  if not public.qualifies_for_leaderboard(
    p_streak,
    p_score,
    normalized_starting_time,
    normalized_time_multiplier,
    normalized_operator_mode
  ) then
    return query select * from public.get_leaderboard();
    return;
  end if;

  select count(*) into score_count from public.leaderboard_scores;
  select min(leaderboard_scores.score) into tenth_score from public.leaderboard_scores;

  if score_count < 10 or p_score > tenth_score then
    insert into public.leaderboard_scores (
      username,
      streak,
      score,
      starting_time_seconds,
      time_multiplier,
      operator_mode
    )
    values (
      nullif(btrim(left(p_username, 80)), ''),
      p_streak,
      p_score,
      10.0,
      0.925,
      'both'
    );
  end if;

  delete from public.leaderboard_scores
  using (
    select
      leaderboard_scores.id,
      row_number() over (
        order by
          leaderboard_scores.score desc,
          leaderboard_scores.streak desc,
          leaderboard_scores.played_at_utc asc,
          leaderboard_scores.id asc
      ) as rank
    from public.leaderboard_scores
  ) ranked
  where leaderboard_scores.id = ranked.id
    and ranked.rank > 10;

  return query select * from public.get_leaderboard();
end;
$$;

grant usage on schema public to anon, authenticated;
grant select on public.leaderboard to anon, authenticated;
grant execute on function public.get_leaderboard() to anon, authenticated;
grant execute on function public.qualifies_for_leaderboard(integer, integer, numeric, numeric, text) to anon, authenticated;
grant execute on function public.submit_leaderboard_score(integer, integer, numeric, numeric, text, text) to anon, authenticated;

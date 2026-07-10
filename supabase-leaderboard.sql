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

  -- Plausibility bound, derived from the real client scoring: every correct
  -- answer adds +1 streak and +(100..200) points, so an honest run ALWAYS
  -- satisfies 100*streak <= score <= 200*streak. The streak cap is far beyond
  -- any human run and (checked first) keeps 200*streak from overflowing int,
  -- which also defuses INT_MAX leaderboard-brick submissions.
  if p_streak > 1000 then
    return false;
  end if;
  if p_score > 200 * p_streak or p_score < 100 * p_streak then
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

-- Cleans a submitted Player ID: NFKC-normalize, strip control/soft-hyphen/
-- Latin-combining(zalgo)/zero-width/bidi/BOM characters, collapse whitespace,
-- reject profanity (-> NULL, which the view renders as 'Player'), cap at 24.
-- Allows real names in any script (letters, non-Latin marks, digits, spaces,
-- and . ' - punctuation). Keep the blocklist in sync with app.js.
create or replace function public.sanitize_username(p_username text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  with stripped as (
    select btrim(
      regexp_replace(
        regexp_replace(
          normalize(coalesce(p_username, ''), NFKC),
          '[' || chr(1)  || '-' || chr(31)
              || chr(127) || '-' || chr(159)
              || chr(173)
              || chr(768) || '-' || chr(879)
              || chr(8203) || '-' || chr(8207)
              || chr(8232) || '-' || chr(8238)
              || chr(8288) || '-' || chr(8303)
              || chr(65279)
              || ']',
          '', 'g'
        ),
        '\s+', ' ', 'g'
      )
    ) as name
  )
  select case
    when name = '' then null
    when name ~* ('\m(fuck|fuk|fucker|fucking|motherfucker|shit|bullshit|cunt|bitch|bastard|asshole|arsehole|dumbass|jackass|dickhead|whore|wanker|bollocks|nigger|nigga|faggot|retard|retarded)|\y(prick|slut|twat|pussy|fag|spic|chink|kike|wetback|tranny|gook|paki)\y')
      then null
    else left(name, 24)
  end
  from stripped;
$fn$;

-- Per-key sliding-window counter used to throttle score submissions.
create table if not exists public.leaderboard_rate_limit (
  key text primary key,
  window_start timestamptz not null default now(),
  hits integer not null default 0
);
alter table public.leaderboard_rate_limit enable row level security;
revoke all on public.leaderboard_rate_limit from anon, authenticated;

-- Atomically bumps the counter for p_key and returns true if the caller is
-- still within p_limit per p_window, false if it should be throttled.
-- Fails OPEN when p_key is empty/unknown so real play is never blocked.
create or replace function public.leaderboard_rate_limit_ok(
  p_key text,
  p_limit integer,
  p_window interval
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_hits integer;
begin
  if p_key is null or p_key = '' then
    return true;
  end if;

  insert into public.leaderboard_rate_limit as r (key, window_start, hits)
    values (p_key, now(), 1)
  on conflict (key) do update
    set hits = case when r.window_start < now() - p_window then 1 else r.hits + 1 end,
        window_start = case when r.window_start < now() - p_window then now() else r.window_start end
  returning hits into current_hits;

  return current_hits <= p_limit;
end;
$$;

revoke execute on function public.leaderboard_rate_limit_ok(text, integer, interval) from anon, authenticated, public;

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
  req_headers json := nullif(current_setting('request.headers', true), '')::json;
  client_ip text := coalesce(
    req_headers ->> 'cf-connecting-ip',
    req_headers ->> 'sb-forwarded-for',
    nullif(split_part(coalesce(req_headers ->> 'x-forwarded-for', ''), ',', 1), '')
  );
begin
  if p_streak is null or p_score is null or p_streak < 0 or p_score < 0 then
    raise exception 'streak and score must be non-negative'
      using errcode = '22023';
  end if;

  -- Throttle abusive floods/replay per client IP. Real players save at most one
  -- qualifying run at a time, so this only ever trips automated abuse; a
  -- throttled call simply returns the current board (like a non-qualifying one).
  if not public.leaderboard_rate_limit_ok(client_ip, 20, interval '1 minute') then
    return query select * from public.get_leaderboard();
    return;
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
      public.sanitize_username(p_username),
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

-- sanitize_username is an internal helper called by submit_leaderboard_score
-- (SECURITY DEFINER runs as owner, so it can call this without a grant).
-- Keep it off the public RPC surface. Supabase grants EXECUTE to anon and
-- authenticated by default, so revoke from those roles too (not just public).
revoke execute on function public.sanitize_username(text) from anon, authenticated, public;

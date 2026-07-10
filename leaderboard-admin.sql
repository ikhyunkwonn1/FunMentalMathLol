-- Leaderboard admin / cleanup snippets ("the broom").
-- Run these in the Supabase SQL editor (as the table owner they bypass RLS).
-- A login-free board can't be made un-grief-proof, so keep this handy: the
-- plausibility bound keeps fakes to human-plausible numbers, and these queries
-- remove anything that slips through.

-- 1. See the current board, worst offenders first.
select id, username, streak, score, played_at_utc
from public.leaderboard_scores
order by score desc, streak desc;

-- 2. Delete one specific row (get the id from query 1).
-- delete from public.leaderboard_scores where id = 42;

-- 3. Sweep anything that violates the plausibility bound
--    (honest runs always satisfy 100*streak <= score <= 200*streak).
-- delete from public.leaderboard_scores
-- where score > 200 * streak or score < 100 * streak or streak > 1000;

-- 4. Remove a bad display name (case-insensitive match).
-- delete from public.leaderboard_scores where username ilike '%somebadword%';

-- 5. Full reset after a raid (wipes the whole board).
-- truncate public.leaderboard_scores;

-- 6. Rate limiter: submissions are capped at 20/minute per IP
--    (public.submit_leaderboard_score -> public.leaderboard_rate_limit_ok).
--    Inspect who is currently hitting the limit:
-- select key as ip, hits, window_start from public.leaderboard_rate_limit
-- where hits >= 20 order by hits desc;
--    The counter table only ever holds one row per IP and resets itself each
--    window, but you can clear old rows any time:
-- delete from public.leaderboard_rate_limit where window_start < now() - interval '1 day';

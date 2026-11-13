-- ───────────────────────────────────────
-- The stored counters and the config version go — step 2 of 2.
--
-- threads.comment_count / comment_count_public and reviewers.thread_count /
-- comment_count were totals that every write had to keep up to date by hand.
-- They drifted (0005 already had to backfill the reviewer pair once), and a
-- drifted thread count numbered a reply onto a seq that was already taken,
-- which was a 500 in production. Since 0.1.32 the reply count is counted from
-- the comments on read and the assignee pool asks threads/comments with
-- EXISTS, so nothing reads or writes these four any more.
--
-- projects.config_version fed a response header no client ever read, and
-- projects.config_etag a /config ETag that is gone; both lost their last
-- reader in 0.1.32. attachment_shares.fetch_count / last_fetched_at were
-- never written by any route (05 §17 open question 9, now closed by removal).
--
-- What goes with them, without being named: Postgres drops a CHECK that
-- mentions a dropped column, so both threads CHECKs on comment_count_public
-- (the range check and NOT private OR comment_count_public = 0) leave with
-- the column. reviewers_pool_idx is dropped by name first, because its
-- predicate names the reviewer counters; it is not recreated — the pool's
-- predicate is EXISTS now, which no partial index can express, and its
-- ORDER BY leads with is_team, so reviewers_project_idx (project_id,
-- last_seen_at DESC) is what the planner uses either way.
--
-- DDL only: no rows are read or written, so no maintenance claim. Each ALTER
-- is a catalogue change, not a table rewrite (the space comes back as rows
-- are updated), and takes a brief ACCESS EXCLUSIVE lock under the runner's
-- lock_timeout. IF EXISTS throughout, so a hand-applied partial run can be
-- finished by the runner.
--
-- DEPLOY ORDER: 0.1.32 still writes config_etag on project create and
-- comment_count_public on every thread PATCH, so this runs AFTER the release
-- that stops those writes is live, never before.
--
-- Under D71, §3's tables lose the columns, the CHECKs and the index in the
-- same commit and pnpm schema:diff:check asserts the two agree.
DROP INDEX IF EXISTS reviewers_pool_idx;

ALTER TABLE threads
  DROP COLUMN IF EXISTS comment_count_public,
  DROP COLUMN IF EXISTS comment_count;

ALTER TABLE reviewers
  DROP COLUMN IF EXISTS thread_count,
  DROP COLUMN IF EXISTS comment_count;

ALTER TABLE projects
  DROP COLUMN IF EXISTS config_version,
  DROP COLUMN IF EXISTS config_etag;

ALTER TABLE attachment_shares
  DROP COLUMN IF EXISTS fetch_count,
  DROP COLUMN IF EXISTS last_fetched_at;

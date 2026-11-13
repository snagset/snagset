-- ───────────────────────────────────────
-- Studio people become reviewers — 05 §3.4 / §6.4b, FOLDBACK §A3, D90.
--
-- A thread's assignee is a `reviewers` row, and the pool it is picked from is
-- "studio people ∪ everyone who has commented in the project". The second
-- half always had rows; the first half is a `kind='verified'` row per member
-- per project with `user_id` set, which §6.4b says is materialised on project
-- create and on membership create. Both writes now do that
-- (`studioReviewers.ts`); this file is the one-time catch-up for every
-- instance that was claimed before they did.
--
-- NO SCHEMA CHANGE. `threads.assignee_id`, `reviewers.user_id` and
-- `reviewers_user_uniq` have been in 0001 since the freeze — this is data, so
-- `schema:diff:check` sees nothing and §3 needs no edit.
--
-- THE MAINTENANCE CLAIM. Every table here is FORCE ROW LEVEL SECURITY, and a
-- migration runs with no `app.org_id` — under the policies alone this INSERT
-- … SELECT would see no memberships and insert nothing, silently. 0002 (D56)
-- added the claim for exactly this shape of write; SET LOCAL scopes it to the
-- migration's own transaction and it is gone at commit.
--
-- IDEMPOTENT by `reviewers_user_uniq`: run against a database where the
-- routes already materialised some rows, it adds only the missing ones.
-- Soft-deleted users are skipped — somebody who left the studio is not
-- somebody to hand work to.
SET LOCAL app.maintenance = 'on';

INSERT INTO reviewers (id, org_id, project_id, kind, name, email, user_id)
SELECT gen_random_uuid(), p.org_id, p.id, 'verified',
       COALESCE(NULLIF(u.name, ''), u.email), u.email, u.id
FROM memberships m
JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
JOIN projects p ON p.org_id = m.org_id AND p.deleted_at IS NULL
ON CONFLICT (project_id, user_id) WHERE user_id IS NOT NULL DO NOTHING;

-- THE COUNTERS THE POOL READS. §6.4b's predicate is thread_count > 0 OR
-- comment_count > 0, and neither had ever been maintained: thread_count was
-- untouched since 0001 and comment_count moved only on the thread row. Both
-- move on every write from D90 on (threads.ts, comments.ts); this is their
-- one-time catch-up, so a client who left a pin last month is assignable
-- today. Every comment row counts, the thread's first one included -- the
-- same rule the live writes apply.
UPDATE reviewers r
   SET thread_count  = (SELECT count(*)::int FROM threads  t WHERE t.created_by = r.id AND t.deleted_at IS NULL),
       comment_count = (SELECT count(*)::int FROM comments c WHERE c.author_id  = r.id AND c.deleted_at IS NULL);

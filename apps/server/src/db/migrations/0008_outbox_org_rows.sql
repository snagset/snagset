-- ───────────────────────────────────────
-- An outbox row may belong to the STUDIO rather than to a site — D120.
--
-- The owner's daily digest lists comments from every site in the studio, and
-- `outbox.project_id` was NOT NULL with ON DELETE CASCADE. The first version
-- filled it with the site of the oldest comment it listed, which meant that
-- removing that one site took the whole pending digest with it: every other
-- site's comments, already folded and marked done, never mailed. The row was
-- never about that site, and the honest value for "which site" is none.
--
-- NULL is allowed for ONE kind of row, named by provider and topic, rather
-- than for any row: every other reader of the outbox — the tracker push above
-- all, which looks up the integration and writes external_refs by
-- project_id — is written for a site, and a CHECK that says which rows may
-- omit it keeps a future writer from producing a site-less tracker event that
-- only fails at push time. Provider AND topic, because topics are 07's open
-- vocabulary and a tracker topic could one day share a name; 'email' is the
-- one provider whose job never reads project_id.
--
-- 'email' was added to snag_provider by 0003, in its own transaction, so using
-- it in this one is safe. The CHECK scans the table once under the ALTER's
-- lock; the outbox is small by construction (rows complete and stay small),
-- so a NOT VALID / VALIDATE split would buy nothing.
--
-- Under D71, §3's outbox table is amended in the same commit and
-- `pnpm schema:diff:check` asserts the two agree.
ALTER TABLE outbox ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE outbox ADD CONSTRAINT outbox_project_scope
  CHECK (project_id IS NOT NULL OR (provider = 'email' AND topic = 'comment.digest'));

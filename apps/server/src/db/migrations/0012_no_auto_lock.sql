-- ───────────────────────────────────────
-- Sites stay open until the studio locks them — D127.
--
-- Until now a new site started `open` and switched itself to `link-required`
-- after SNAGSET_WRITE_MODE_GRACE_HOURS (24 by default). A studio running
-- QA with designers who have no accounts found its client site locked a day
-- later, and since 0.1.23 a link-only site also hides its comments from
-- anyone without a link — so the switch silently took the review away.
-- Link-required is an option a studio chooses in a site's settings now; the
-- grace window is opt-in (a number of hours) and defaults to never.
--
-- This clears the switches already scheduled on open sites. A site already
-- set to link-required, by hand or by an earlier switch, is left as it is.
--
-- No column changes, so §3 needs no edit and schema:diff:check sees nothing.
-- THE MAINTENANCE CLAIM: projects is FORCE ROW LEVEL SECURITY and a migration
-- runs with no app.org_id, so without it this UPDATE would match no rows,
-- silently. SET LOCAL ends with the migration's transaction.
SET LOCAL app.maintenance = 'on';

UPDATE projects
   SET write_mode_downgrade_at = NULL
 WHERE write_mode = 'open'
   AND write_mode_downgrade_at IS NOT NULL;

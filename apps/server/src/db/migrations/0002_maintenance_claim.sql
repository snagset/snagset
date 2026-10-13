-- ─────────────────────────────────────────────────────────────────────────
-- 08 §9.2's MAINTENANCE CLAIM (D56) — the second disjunct every org policy
-- needs before scheduled work can see a single row.
--
-- THE BUG THIS FIXES, measured rather than reasoned:
--
--   0001 writes  USING (org_id = current_setting('app.org_id', true)::uuid)
--
-- The reaper (05 §3.11) is cross-tenant by definition: it expires every org's
-- nonces, downgrades every project past its grace window, reaps every orphaned
-- blob. It therefore runs with no app.org_id set — and with nothing set,
-- current_setting(..., true) returns NULL, org_id = NULL evaluates to NULL,
-- NULL is not true, and every row is filtered out. The job commits, reports
-- success, and has done nothing.
--
-- On the test database: as the owner, one project. As a role without
-- BYPASSRLS and no app.org_id, zero. The failure is INVISIBLE wherever the
-- connecting role bypasses RLS, which includes every Neon connection string
-- (D50) — so it works in development and silently stops working on every
-- correctly configured self-host. That is the worst shape a bug can have.
--
-- WHY THIS IS A SEPARATE FILE AND NOT A REGENERATED 0001.
--
-- The policies are not in 05 §3 — the generator adds them (see its header), so
-- changing them means changing the generator, which changes 0001, which
-- changes its checksum, which makes migrate.ts refuse to start against any
-- database that already applied it. By the time this was written that included
-- a dogfood instance holding real review data. A migration is exactly the tool
-- for "the schema needs to change and the old one is already out there", and
-- reaching for the generator instead would have traded somebody's data for a
-- tidier diff.
--
-- THE SECOND BUG IN THE SAME PREDICATE, found while testing the first.
--
-- After a transaction that did set_config('app.org_id', ..., true) commits,
-- current_setting('app.org_id', true) does NOT go back to NULL — it returns
-- the EMPTY STRING. So the next query on that pooled connection evaluates
-- ''::uuid and raises "invalid input syntax for type uuid". Not zero rows: an
-- error. Every request the server serves sets that variable, and every
-- connection is reused, so on a deployment where the policy is actually
-- evaluated this is not an edge case — it is the second request onwards.
--
-- Invisible for the same reason as the first bug: a role with BYPASSRLS never
-- evaluates the predicate, so the whole class of defect is undetectable on the
-- database this was developed against. Both are fixed here, because both are
-- the same sentence written wrong, and a migration that fixed only the one we
-- went looking for would leave the worse one in place.
--
-- WHY A LOOP AND NOT 31 HAND-WRITTEN STATEMENTS.
--
-- The predicate differs per table (orgs matches on id, users through
-- memberships, everything else on org_id), so hand-writing them means
-- transcribing three variants across 31 tables — the transcription error this
-- repo generates its migration to avoid. Reading each policy's CURRENT
-- expression back out of the catalogue and appending one disjunct is both
-- shorter and incapable of getting a predicate wrong.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  p        record;
  existing text;
BEGIN
  FOR p IN
    SELECT c.relname AS table_name, pol.polname AS policy_name,
           pg_get_expr(pol.polqual, pol.polrelid) AS qual
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND pol.polname = c.relname || '_org'
    ORDER BY c.relname
  LOOP
    existing := p.qual;

    -- Fix one: an unset variable reads as '' rather than NULL, and ''::uuid
    -- raises. NULLIF turns it back into the NULL the predicate was written
    -- assuming, which compares as unknown and filters the row out quietly —
    -- which is what "no tenant context" should do.
    existing := replace(
      existing,
      'current_setting(''app.org_id''::text, true)',
      'NULLIF(current_setting(''app.org_id''::text, true), ''''::text)'
    );

    -- Fix two: the maintenance claim. Idempotent by inspection rather than by
    -- IF NOT EXISTS: re-running this migration is not the case that matters
    -- (the ledger stops that), but a database that reached this shape another
    -- way must not end up with the disjunct twice.
    IF existing NOT LIKE '%app.maintenance%' THEN
      existing := existing ||
        ' OR current_setting(''app.maintenance'', true) = ''on''';
    END IF;

    IF existing = p.qual THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'DROP POLICY %I ON public.%I',
      p.policy_name, p.table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (%s)',
      p.policy_name, p.table_name, existing
    );
  END LOOP;
END
$$;

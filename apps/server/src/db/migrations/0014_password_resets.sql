-- ───────────────────────────────────────
-- Password resets — D131: a forgotten password comes back by a mailed link.
--
-- The sign-in page told a person who had forgotten their password to run
-- `snagset passwd` on the server. That is right for whoever runs the server
-- and no help to anybody else in the studio: a member has no shell. Where
-- the instance can send mail, a single-use link sent to the account's own
-- address now does it, and this table is where those links live.
--
-- THE TOKEN IS NEVER STORED, as with invites (0009), review links (§3.4) and
-- dashboard sessions: `token_hash` is sha256 of 32 random bytes, and the raw
-- value exists once, in the mail. UNIQUE because a link is found by it
-- before the caller is known to be anybody.
--
-- ONE ROW, THREE STATES, no status column: live is `used_at` NULL and
-- `expires_at` in the future. The confirm consumes the row with one
-- conditional UPDATE on exactly that predicate, so two browsers racing one
-- link serialise on the row lock and the second matches nothing.
--
-- `org_id` is the person's HOME org (§3.0), as on `user_sessions`. `email`
-- is what the link was mailed to, lower-cased by CHECK for the reason
-- `users.email` is; it is a record, and the account is found by `user_id`.
--
-- Under D71, §3.2 gains the table in the same commit and
-- `pnpm schema:diff:check` asserts the two agree.
--
-- THE POLICY, TWICE — 0006's pattern, for 0006's reason (see 0009). The
-- maintenance claim is the only way these rows are ever read: a link is found
-- by its hash before the caller knows whose it is (D56).
CREATE TABLE password_resets (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  email       text NOT NULL CHECK (email = lower(email)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX password_resets_expiry ON password_resets (expires_at);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY password_resets_org ON password_resets
  USING (org_id = current_setting('app.org_id', true)::uuid);

DO $$
DECLARE
  existing text;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO existing
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'password_resets' AND pol.polname = 'password_resets_org';
  IF existing IS NULL OR existing LIKE '%NULLIF%' THEN
    RETURN;
  END IF;
  existing := replace(
    existing,
    'current_setting(''app.org_id''::text, true)',
    'NULLIF(current_setting(''app.org_id''::text, true), ''''::text)'
  );
  IF existing NOT LIKE '%app.maintenance%' THEN
    existing := existing || ' OR current_setting(''app.maintenance'', true) = ''on''';
  END IF;
  EXECUTE 'DROP POLICY password_resets_org ON public.password_resets';
  EXECUTE format('CREATE POLICY password_resets_org ON public.password_resets USING (%s)', existing);
END
$$;

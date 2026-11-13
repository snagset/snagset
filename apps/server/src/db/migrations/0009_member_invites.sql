-- ───────────────────────────────────────
-- Member invites — D121: a person joins a studio through a link.
--
-- "To add a member needs an initial password — is there a better way? Like
-- Strapi has an invite link." D85 had the owner choose a password for
-- somebody else and hand it over out of band; this table replaces that with
-- a single-use link the invitee opens to choose their own.
--
-- THE TOKEN IS NEVER STORED. `token_hash` is sha256 of 32 random bytes, the
-- shape review links (§3.4) and dashboard sessions already use: the raw value
-- exists once, in the create response, and nothing can produce it again.
-- UNIQUE because the accept looks the row up by it, before any tenant is
-- known.
--
-- ONE ROW, FOUR STATES, no status column: pending is accepted_at, revoked_at
-- both NULL and expires_at in the future; the other three are whichever of
-- those says otherwise. The accept consumes the row with one conditional
-- UPDATE on exactly that predicate, which is what makes a token unusable
-- twice even when two browsers press the button in the same millisecond —
-- the second UPDATE waits on the first's row lock, re-reads the row, and
-- matches nothing.
--
-- `email` is optional: given, the invite is for that address and the accept
-- refuses any other; absent, the invitee types their own. Lower-cased by
-- CHECK for the reason `users.email` is — users_email_uniq compares lower().
-- `role` is the enum, not a narrower CHECK: member and viewer are refused by
-- the API with a sentence (D85), and a CHECK would cost a migration the day
-- they are wired.
--
-- Under D71, §3.2 gains the table in the same commit and
-- `pnpm schema:diff:check` asserts the two agree.
--
-- THE POLICY, TWICE — 0006's pattern, for 0006's reason. The generator
-- renders every policy in 0001's shape and 0002's rewrite (NULLIF and the
-- maintenance claim) only ever ran over `public`; so this file creates the
-- policy in 0001's shape and then rewrites it in place, scoped to this table
-- and to `public`. On a real database the rewrite lands; in the diff tool's
-- scratch schema it is inert and both sides compare in 0001's shape. The
-- maintenance claim is not decoration here: the accept finds an invite by
-- its hash before it knows the org, which is the claim's whole job (D56).
CREATE TABLE member_invites (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  role         snag_member_role NOT NULL,
  email        text CHECK (email = lower(email)),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   timestamptz
);
CREATE INDEX member_invites_pending ON member_invites (org_id, created_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE member_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY member_invites_org ON member_invites
  USING (org_id = current_setting('app.org_id', true)::uuid);

DO $$
DECLARE
  existing text;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO existing
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'member_invites' AND pol.polname = 'member_invites_org';
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
  EXECUTE 'DROP POLICY member_invites_org ON public.member_invites';
  EXECUTE format('CREATE POLICY member_invites_org ON public.member_invites USING (%s)', existing);
END
$$;

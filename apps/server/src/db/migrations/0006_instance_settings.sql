-- ───────────────────────────────────────
-- Instance settings — D89, plan/08 §5b: what the dashboard connected.
--
-- "If added via the environment variables it takes those and doesn't allow
-- to change in the dashboard, but if no env variables then we can add and
-- connect via the general settings." The environment wins and locks; this
-- table is where the dashboard's half lives. One row per key per org, the
-- non-secret half in `value` and the secret sealed exactly as
-- `orgs.storage_credentials` and `integrations.credentials` are — AES-256-GCM
-- under HKDF(SNAGSET_SECRET_KEY, 'credential-enc') — so there is one way to
-- hold a secret at rest rather than three.
--
-- Mail is the first key (`mail`: the transport URL sealed, the From address
-- and the transport's shape in `value`); the trackers' credentials follow
-- with phase 7. Storage stays on the `orgs.storage_*` columns it had before
-- this table existed: moving it would be a migration of secrets for no gain.
--
-- Under D71, §3 describes the CURRENT schema, so the table is added there in
-- the same commit and `pnpm schema:diff:check` asserts the two agree.
--
-- THE POLICY, TWICE. The generator renders every policy in 0001's shape, and
-- 0002's rewrite (NULLIF and the maintenance claim) runs only over the
-- `public` schema — in the diff tool's scratch schema it touches nothing, so
-- both sides compare policies in 0001's shape. This file does the same as
-- 0002 did for every earlier table: create the policy in 0001's shape, then
-- rewrite it in place, scoped to this table and to `public`. On a real
-- database the second step lands; in the diff's scratch schema it is inert,
-- and the two agree. Guarded against running twice, unlike 0002, because a
-- double NULLIF is what a re-run produced while this was being written.
CREATE TABLE instance_settings (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret      bytea,
  secret_iv   bytea,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key),
  CHECK ((secret IS NULL) = (secret_iv IS NULL))
);
ALTER TABLE instance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY instance_settings_org ON instance_settings
  USING (org_id = current_setting('app.org_id', true)::uuid);

DO $$
DECLARE
  existing text;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO existing
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'instance_settings' AND pol.polname = 'instance_settings_org';
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
  EXECUTE 'DROP POLICY instance_settings_org ON public.instance_settings';
  EXECUTE format('CREATE POLICY instance_settings_org ON public.instance_settings USING (%s)', existing);
END
$$;

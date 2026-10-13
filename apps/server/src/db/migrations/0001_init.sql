-- ─────────────────────────────────────────────────────────────────────────
-- GENERATED FILE — DO NOT EDIT BY HAND.
-- Source of truth: specs/05-api-data.md §3 (the schema itself, not prose
-- about one). Regenerate: pnpm gen:migration   (CI runs gen:migration:check)
--
-- Edit the SPEC to change the database. That is the whole point: 05 §3
-- carries the reasoning for every column beside the column, and a migration
-- transcribed by hand is a second source of truth that is wrong by the
-- second edit.
--
-- 32 tables · 15 enums · 58 indexes
--
-- 1 statement(s) in §3 are gated to a later release and are NOT here:
--   v2: CREATE INDEX threads_anchor_text_trgm ON threads
-- ─────────────────────────────────────────────────────────────────────────

-- 08 §2.3: zero extensions. UUIDs are minted by the CLIENT (UUIDv7, ordered
-- by time), so there is no pgcrypto, no uuid-ossp, and nothing to install
-- on a managed Postgres that may not permit installing anything.

CREATE TYPE snag_project_status   AS ENUM ('active','paused','disabled','deleting');
CREATE TYPE snag_write_mode       AS ENUM ('open','link-required','verified-only');
CREATE TYPE snag_thread_status    AS ENUM ('open','progress','review','resolved');
CREATE TYPE snag_anchor_state     AS ENUM ('anchored','approximate','orphaned');
CREATE TYPE snag_reviewer_kind    AS ENUM ('guest','link','verified');
CREATE TYPE snag_attachment_kind  AS ENUM ('screenshot','image','file','dom-snapshot');  -- 'file' added by D18
CREATE TYPE snag_attachment_state AS ENUM ('pending','bound','orphaned');
CREATE TYPE snag_moderation       AS ENUM ('visible','held','spam');
CREATE TYPE snag_provider         AS ENUM ('github','linear','slack','webhook');
CREATE TYPE snag_ref_kind         AS ENUM ('issue','pr','message','attachment','delivery');
CREATE TYPE snag_ref_status       AS ENUM ('synced','pending','failed','detached');
CREATE TYPE snag_member_role      AS ENUM ('owner','admin','member','viewer');
CREATE TYPE snag_outbox_status    AS ENUM ('pending','inflight','done','failed','dropped');
CREATE TYPE snag_sync_direction   AS ENUM ('inbound','outbound');
CREATE TYPE snag_sync_entity      AS ENUM ('thread','comment','status');

CREATE TABLE orgs (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  plan        text NOT NULL DEFAULT 'selfhost',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- ── The pixel tier's bucket (A9b, LOCK L2/L3, D18) ──────────────────────
  --
  -- INSTANCE-level, not per project: one bucket serves every project, and a
  -- v1 self-host has exactly one org. `features: {screenshots, uploads}` in
  -- the bootstrap config is derived from `storage_connected_at IS NOT NULL`
  -- — server-side, because A9b is explicit that "the widget never probes
  -- storage".
  --
  -- These columns exist because nothing else could hold them. Sweep R4
  -- deleted every `SNAGSET_STORAGE_S3_*` variable on the grounds that "the
  -- bucket is connected in the admin UI and stored encrypted under
  -- credential-enc" — but no table had a column for it, and `integrations`
  -- is per-project with a `provider` enum that has no storage member. So the
  -- credentials had nowhere to live at all, on any deployment, which made
  -- the pixel tier unreachable rather than merely un-built.
  --
  -- Endpoint, bucket, region, and the public base URL if one is configured.
  -- Non-secret by construction; the keys are in the encrypted pair below.
  storage_config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- AES-256-GCM under HKDF(SNAGSET_SECRET_KEY, 'credential-enc') — the same
  -- purpose and the same shape as `integrations.credentials`, deliberately,
  -- so there is one way to hold a secret at rest rather than two.
  storage_credentials    bytea,
  storage_credentials_iv bytea,
  -- NULL = annotation mode. Disconnecting nulls this and leaves the
  -- attachment rows' `storage_key`s intact (LOCK L2), so reconnecting the
  -- same bucket restores the pictures rather than orphaning them.
  storage_connected_at   timestamptz,
  CHECK ((storage_credentials IS NULL) = (storage_credentials_iv IS NULL)),
  CHECK (storage_connected_at IS NULL OR storage_credentials IS NOT NULL),
  deleted_at  timestamptz
);

CREATE TABLE users (                       -- dashboard/owner identity. NOT reviewers.
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,  -- HOME org (§3.0)
  email          text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  name           text NOT NULL DEFAULT '',
  avatar_url     text,
  password_hash  text,                      -- argon2id; NULL when OAuth-only
  totp_secret    text,                      -- v2
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_uniq ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE user_identities (             -- OAuth links (v1: github, google)
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  subject      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE memberships (
  org_id     uuid NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       snag_member_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE user_sessions (               -- opaque server-side sessions, NOT JWT
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,     -- sha256 of the cookie value
  user_agent    text,
  ip_hash       bytea,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE setup_tokens (                -- first-run claim, §6.10. 08 §3.4 prints it.
  id          uuid PRIMARY KEY,
  token_hash  bytea NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  consumed_at timestamptz
);

CREATE TABLE projects (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  uid            text NOT NULL UNIQUE,      -- PUBLIC site UID, 'prj_' + 12 (foundations §2.10)
  name           text NOT NULL,
  status         snag_project_status NOT NULL DEFAULT 'active',
  kind           text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','demo')),

  -- write gating (§4.2). New projects start 'open' and auto-downgrade after
  -- SNAGSET_WRITE_MODE_GRACE_HOURS (default 24).
  write_mode     snag_write_mode NOT NULL DEFAULT 'open',
  write_mode_downgrade_at timestamptz,
  read_mode      snag_write_mode,             -- NULL = follow write_mode

  -- human thread ids (foundations §2.10: Thread.key = 'SN-14')
  -- 'SN', from names.ts's THREAD_REF_PREFIX. 'CD' was rename residue from the
  -- cedilla era and contradicted this spec's own sentence six sections up
  -- ('reads SN-14'); a project created under it would have minted CD-1.
  key_prefix     text NOT NULL DEFAULT 'SN' CHECK (key_prefix ~ '^[A-Z][A-Z0-9]{0,7}$'),
  thread_seq     integer NOT NULL DEFAULT 0,

  -- IP hashing salt (§9.2, §13.1). Present from migration 0001, per §14.2b:
  -- retrofitting it means every historical ip_hash was computed under a different
  -- salt, which breaks erasure and comparability. 32 random bytes, per project.
  -- The 'ip-hash' HKDF purpose stays deleted (foundations §7) -- this is data.
  ip_salt        bytea NOT NULL,

  -- JSONB config blobs, all validated in the app layer (§3.10)
  capture        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- categories + masking (04 owns the vocabulary)
  routing        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- significant query params, normalisers (03)
  branding       jsonb NOT NULL DEFAULT '{}'::jsonb,
  flags          jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- limits overrides, moderation, retiredUids

  -- identity handshake (§4.6). Verification needs the PLAINTEXT secret, so it is
  -- stored encrypted under HKDF(SNAGSET_SECRET_KEY,'credential-enc'), never only hashed.
  identity_secret_enc      bytea,           -- NULL = HMAC identity disabled
  identity_secret_enc_iv   bytea,
  identity_secret_prev_enc      bytea,      -- 24 h rotation overlap
  identity_secret_prev_enc_iv   bytea,
  identity_secret_prev_expires_at timestamptz,
  identity_secret_hint     text,            -- last 4 chars, for the dashboard only

  -- cache control for the bootstrap (§7)
  config_version integer NOT NULL DEFAULT 1,
  config_etag    text NOT NULL,
  -- session invalidation epoch (§4.4)
  session_epoch  integer NOT NULL DEFAULT 1,
  -- abuse
  shared_suffix_origin boolean NOT NULL DEFAULT false,
  paused_reason  text,
  -- retention & storage quota
  retention_days integer CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
  storage_bytes_limit bigint NOT NULL DEFAULT 268435456,    -- 256 MB (A9b); 0 = unlimited
  storage_bytes_used  bigint NOT NULL DEFAULT 0,
  purge_after    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CHECK (uid ~ '^prj_[0-9abcdefghjkmnpqrstvwxyz]{12}$'),
  CHECK (octet_length(ip_salt) = 32),
  -- a project whose allow-list contains a shared public suffix (*.vercel.app)
  -- may never be in 'open' write mode. See §4.9.
  CHECK (NOT shared_suffix_origin OR write_mode <> 'open'),
  CHECK (kind <> 'demo' OR retention_days IS NOT NULL),
  CHECK ((identity_secret_enc IS NULL) = (identity_secret_enc_iv IS NULL))
);
CREATE INDEX projects_org_idx   ON projects (org_id) WHERE deleted_at IS NULL;
CREATE INDEX projects_purge_idx ON projects (purge_after) WHERE purge_after IS NOT NULL;
CREATE INDEX projects_downgrade_idx ON projects (write_mode_downgrade_at)
  WHERE write_mode_downgrade_at IS NOT NULL;

CREATE TABLE api_keys (                    -- CI, relay, scripts. NOT the MCP server (§9.6).
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   uuid REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-wide
  name         text NOT NULL,
  prefix       text NOT NULL,              -- first 8 chars after API_KEY_PREFIX, shown in UI
  token_hash   bytea NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  last_used_ip bytea,                      -- hashed, never raw (§9.2)
  expires_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id) WHERE revoked_at IS NULL;

-- foundations §14.2 assigns MCP credentials to 07's scoped token + this table;
-- 05 writes the DDL, 07 owns the scope vocabulary and the transports. Shape is
-- 07 §8.2's, verbatim, plus the remote-write gate §9.6 requires.
-- Ships in migration 0001; no route accepts an MCP token before v2 (§6.1 #42).
CREATE TABLE mcp_tokens (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   uuid REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-wide
  name         text NOT NULL,
  prefix       text NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT '{}',    -- vocabulary owned by 07
  environments text[] NOT NULL DEFAULT '{*}',   -- 07 §8.2
  -- 07 §8.2's human-in-the-loop flag: the agent must confirm before writing.
  confirm_writes boolean NOT NULL DEFAULT true,
  -- §9.6: write scopes are refused over a remote (non-loopback) MCP transport
  -- unless this is explicitly true. Distinct from confirm_writes: that one is a
  -- UX obligation on the agent, this one is a server-enforced transport gate.
  allow_remote_writes boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  last_used_ip bytea,                            -- hashed (07 F29 reads it)
  expires_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX mcp_tokens_org_idx ON mcp_tokens (org_id) WHERE revoked_at IS NULL;

CREATE TABLE project_origins (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Exact origin ('https://staging.acme.com') or single-level wildcard host
  -- ('https://*.acme.com'). Scheme is mandatory. Port is part of the origin.
  pattern     text NOT NULL,
  is_wildcard boolean NOT NULL DEFAULT false,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, pattern),
  CHECK (pattern ~ '^https?://[a-z0-9*.\-]+(:[0-9]{1,5})?$'),
  CHECK (pattern = lower(pattern))
);
CREATE INDEX project_origins_project_idx ON project_origins (project_id);

CREATE TABLE environments (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         text NOT NULL,               -- 'preview','staging','production'
  label       text NOT NULL,
  -- origin/branch matchers used to auto-classify an incoming page (§6.5)
  matchers    jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (project_id, key),
  CHECK (key ~ '^[a-z0-9][a-z0-9._-]{0,62}$')
);
CREATE UNIQUE INDEX environments_one_default ON environments (project_id) WHERE is_default;

CREATE TABLE rounds (
  id           uuid PRIMARY KEY,                    -- wire form 'rnd_…' (foundations §2.10)
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Display order and the default: the latest round is the one you land in.
  -- A per-project sequence, minted at creation, never recomputed.
  number       integer NOT NULL,
  -- "Round 1" is the generated name; the studio may rename it "Pre-launch".
  name         text NOT NULL,
  -- Per-round thread numbering (01 §5.2, AC-1-12): "the round number is a
  -- per-round sequence minted at creation and never recomputed; a deleted
  -- thread leaves a gap". The counter lives here rather than being computed
  -- from the threads, because computing it is what makes numbers move.
  thread_seq   integer NOT NULL DEFAULT 0,
  -- A closed round still shows its unresolved count (D2's one safeguard) and
  -- is still selectable; closing only means new threads go elsewhere.
  closed_at    timestamptz,
  -- A STUDIO act, so `users`, not `reviewers`: a reviewer comments, a round is
  -- opened and closed from the dashboard. It is also the only workable
  -- reference at setup, where the first round is created inside the claim
  -- transaction and no reviewer exists yet (§6.10 step 2) — a reviewers FK
  -- there is unsatisfiable, which is how this was caught.
  -- NULLable with SET NULL: the round outlives whoever opened it.
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (project_id, number),
  CHECK (number > 0),
  CHECK (thread_seq >= 0)
);

-- The selector reads this: rounds of a project, newest first.
CREATE INDEX rounds_project_idx ON rounds (project_id, number DESC) WHERE deleted_at IS NULL;

CREATE TABLE review_links (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_hash     bytea NOT NULL UNIQUE,     -- sha256(raw token). Raw is never stored.
  -- The link's LABEL, not an invitee's name: "Client review — round 2".
  -- D3 removed per-person minting, and a field that asks for a person's name
  -- reintroduces invite management through the back door. The dashboard shows
  -- ONE current link per project (M2-27) and offers revoke-and-replace; the
  -- table stays many-rowed so an outgoing link can stay live through a
  -- handover, which M2-27's own DoD requires ("minting a replacement link does
  -- not revoke the old one").
  name           text NOT NULL,
  -- Optional, and only so §6.4b's placeholder attach can match on lower(email)
  -- when the studio happens to know it. Never required to mint.
  email          text,
  environments   text[] NOT NULL DEFAULT '{*}',
  -- D2/M2-18: a link may be PINNED to a round, so a client invited for round 2
  -- lands in round 2 rather than in whatever is active when they open it.
  -- NULL = every round, which is the default and the common case.
  --
  -- Present from 0001 rather than added later: §3 IS the migration
  -- (apps/server/scripts/gen-migration.mjs generates it from these blocks, and
  -- CI runs gen:migration:check), so a column added afterwards is a second
  -- migration on a table this feature owns. The plan asserted round pinning in
  -- M2-18's DoD while no column existed to carry it — caught by reading the
  -- DoD against the DDL.
  --
  -- SET NULL, not CASCADE: deleting a round must not silently delete the link
  -- a client is holding. It widens to every round instead, which is visible.
  round_id       uuid REFERENCES rounds(id) ON DELETE SET NULL,
  -- The DEFAULT is the client link. A "team link" -- the studio reviewing its
  -- own work through the widget rather than the dashboard -- additionally
  -- carries 'thread:private' and 'thread:assign' (§6.4a, §6.4b). Those two are
  -- the ONLY route by which a widget session sees or writes team-only content.
  permissions    text[] NOT NULL DEFAULT '{thread:create,comment:create,thread:resolve}',
  allow_name_override boolean NOT NULL DEFAULT true,
  max_uses       integer,                   -- NULL = unlimited. Counts PEOPLE (§4.5).
  use_count      integer NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- default now() + SNAGSET_REVIEW_LINK_TTL_DAYS (14), clamped by
  -- SNAGSET_REVIEW_LINK_MAX_TTL_DAYS (90). Foundations §7's two numbers.
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  last_used_at   timestamptz,
  CHECK (expires_at > created_at),
  CHECK (max_uses IS NULL OR max_uses > 0)
);
CREATE INDEX review_links_project_idx ON review_links (project_id, created_at DESC);
CREATE INDEX review_links_expiry_idx  ON review_links (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE reviewers (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind           snag_reviewer_kind NOT NULL,
  name           text NOT NULL,
  email          text,
  avatar_url     text,
  external_id    text,                      -- host-app user id, kind='verified' only
  review_link_id uuid REFERENCES review_links(id) ON DELETE SET NULL,
  -- STUDIO IDENTITY (FOLDBACK §A3). A dashboard user's reviewer row in this
  -- project. Set => this person is team: they are in the assignee pool without
  -- having commented, and they are the half of §6.4b's union that is not
  -- "everyone who has commented". It is also the structural answer to "is this
  -- person studio?", which §6.4a's private predicate needs.
  --
  -- RESTRICT, not SET NULL, and the CHECKs below are why. `user_id` is not a
  -- decoration on a verified row, it IS the verification — "vouched for by the
  -- host app (external_id) OR one of our own dashboard users (user_id)". Null
  -- it and the row asserts a verification nothing backs, which is exactly what
  -- `CHECK (kind <> 'verified' OR external_id IS NOT NULL OR user_id IS NOT
  -- NULL)` forbids. Draft 4 had SET NULL here, and the two rules contradicted
  -- for one reachable combination: a studio member replies from the dashboard
  -- (kind='verified', user_id set, external_id null), then somebody deletes
  -- that member — the FK nulls the column, the CHECK rejects the row, and the
  -- DELETE fails with a constraint violation instead of a sentence. Found on
  -- 2026-08-21 by deleting a throwaway owner after a test.
  --
  -- So a person who has authored work cannot be HARD-deleted, which is the
  -- honest rule: `users.deleted_at` exists, `ownerAuth` already filters on it,
  -- and soft delete is how somebody leaves a studio without their replies
  -- losing their name.
  user_id        uuid REFERENCES users(id) ON DELETE RESTRICT,
  -- PLACEHOLDER (DESIGN.md Q4's '+ Add person'). A named person who has not yet
  -- written anything and holds no credential: assignable, not authenticable.
  -- Attaches to a real identity on a later 'link'/'verified' exchange (§6.4b).
  --
  -- RESTRICT for the same reason one line up, via the SECOND check: a
  -- placeholder's only claim to existing is `invited_by`, so nulling it leaves
  -- a row with no credential, no user and no inviter — which
  -- `CHECK (kind = 'verified' OR holder_secret_hash IS NOT NULL OR user_id IS
  -- NOT NULL OR invited_by IS NOT NULL)` forbids. Same shape, same fix, found
  -- by reading rather than by breaking.
  invited_by     uuid REFERENCES users(id) ON DELETE RESTRICT,
  -- One row per PERSON. For kind='guest' and kind='link' this is sha256 of a
  -- 32-byte secret the holder keeps in localStorage 'snag:identity' (§4.4.1, §4.5).
  holder_secret_hash bytea,
  -- MCP/agent authorship (§9.6, v2 feature; columns exist from 0001 so the
  -- behaviour and its CHECK ship together rather than as a later ALTER).
  is_agent       boolean NOT NULL DEFAULT false,
  agent_mcp_token_id uuid REFERENCES mcp_tokens(id) ON DELETE SET NULL,
  -- per-identity revocation without nuking the project epoch (§4.6)
  identity_valid_after timestamptz,
  blocked_at     timestamptz,
  erased_at      timestamptz,               -- §13 subject erasure
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  thread_count   integer NOT NULL DEFAULT 0,
  comment_count  integer NOT NULL DEFAULT 0,
  -- A verified reviewer is vouched for by the host app (external_id) OR is one
  -- of our own dashboard users (user_id). Draft 4 required external_id, which
  -- left a studio member with no representable reviewer identity at all.
  CHECK (kind <> 'verified' OR external_id IS NOT NULL OR user_id IS NOT NULL),
  -- Every non-verified row is one of: a credential holder, a studio member, or
  -- a placeholder somebody named. Nothing else may exist.
  CHECK (kind = 'verified' OR holder_secret_hash IS NOT NULL
                           OR user_id IS NOT NULL
                           OR invited_by IS NOT NULL),
  CHECK (kind <> 'link'     OR review_link_id IS NOT NULL),
  CHECK (NOT is_agent OR kind = 'guest'),
  -- A studio identity is never an agent and never a placeholder.
  CHECK (user_id IS NULL OR (NOT is_agent AND invited_by IS NULL))
);
CREATE UNIQUE INDEX reviewers_verified_uniq ON reviewers (project_id, external_id)
  WHERE kind = 'verified' AND external_id IS NOT NULL;
-- One studio reviewer row per user per project (FOLDBACK §A3).
CREATE UNIQUE INDEX reviewers_user_uniq ON reviewers (project_id, user_id)
  WHERE user_id IS NOT NULL;
-- ONE ROW PER PERSON PER LINK, not one row per link. See §4.5.
CREATE UNIQUE INDEX reviewers_link_holder_uniq
  ON reviewers (project_id, review_link_id, holder_secret_hash) WHERE kind = 'link';
CREATE UNIQUE INDEX reviewers_guest_holder_uniq
  ON reviewers (project_id, holder_secret_hash)
  WHERE kind = 'guest' AND holder_secret_hash IS NOT NULL;
CREATE INDEX reviewers_project_idx ON reviewers (project_id, last_seen_at DESC);
CREATE INDEX reviewers_link_idx    ON reviewers (review_link_id) WHERE kind = 'link';
-- The assignee pool query (§6.4b): studio people first, then anyone who wrote.
CREATE INDEX reviewers_pool_idx ON reviewers (project_id, last_seen_at DESC)
  WHERE blocked_at IS NULL AND erased_at IS NULL
    AND (user_id IS NOT NULL OR invited_by IS NOT NULL
         OR thread_count > 0 OR comment_count > 0);
-- Attaching a placeholder to the person it was created for (§6.4b), by an email
-- the SERVER supplied -- never one a guest typed about themselves.
CREATE INDEX reviewers_email_idx ON reviewers (project_id, lower(email))
  WHERE email IS NOT NULL AND erased_at IS NULL;



CREATE TABLE threads (
  id              uuid PRIMARY KEY,                  -- client-minted UUIDv7; wire form 'thr_…'
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key             text NOT NULL,                     -- 'SN-14' (foundations §2.10)
  -- Monotonic revision, bumped in the same transaction as ANY mutation of this
  -- thread or of its comments (§14.2b; 07 §2.5 builds its outbox dedupe_key from
  -- it). Also the ETag source for If-Match (§6.4).
  version         integer NOT NULL DEFAULT 1,
  environment_id  uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  -- Thread.scope.round (foundations §5, D2). NOT NULL and RESTRICT: a thread
  -- belongs to exactly one round and threads never move, so there is no
  -- reassignment path and deleting a round with threads in it is refused
  -- rather than silently orphaning them.
  round_id        uuid NOT NULL REFERENCES rounds(id) ON DELETE RESTRICT,
  -- Creation order WITHIN the round (01 §5.2) — the number on the pin. Minted
  -- from rounds.thread_seq at creation, never recomputed: AC-1-12 requires
  -- that deleting comment 4 leaves comment 5 called 5, everywhere.
  round_number    integer NOT NULL,
  branch          text,
  -- AnchorRecord (foundations §5), stored verbatim, upcast on read (§11.3)
  anchor          jsonb NOT NULL,
  anchor_schema   text NOT NULL DEFAULT 'snagset.v1',
  anchor_state    snag_anchor_state NOT NULL DEFAULT 'anchored',
  -- monotonic-merge scope for anchor_state (§6.7). NULL = no build reported yet.
  anchor_state_build text,
  last_anchor_check  timestamptz,
  -- CaptureContext (foundations §5), already redacted client-side (04/A11)
  context         jsonb NOT NULL,
  context_schema  text NOT NULL DEFAULT 'snagset.v1',
  status          snag_thread_status NOT NULL DEFAULT 'open',
  moderation      snag_moderation NOT NULL DEFAULT 'visible',
  -- TEAM-ONLY (foundations §5, FOLDBACK §A4). Excluded for a client AT THE DATA
  -- LAYER by §6.4a's predicate, never rendered-then-hidden. Studio-only to set.
  private         boolean NOT NULL DEFAULT false,
  created_by      uuid NOT NULL REFERENCES reviewers(id) ON DELETE RESTRICT,
  -- Pool is studio people ∪ everyone who has commented (FOLDBACK §A3, §6.4b).
  assignee_id     uuid REFERENCES reviewers(id) ON DELETE SET NULL,   -- foundations §5
  -- DEFERRED to v2 (FOLDBACK §A2). The column, the CHECK and foundations §5's
  -- field all survive so that re-adding is additive; NO v1 route reads or
  -- writes it, and no v1 request body may carry it (§6.2, §6.4, §11.1 rule 3).
  labels          text[] NOT NULL DEFAULT '{}',                       -- foundations §5
  resolved_by     uuid REFERENCES reviewers(id) ON DELETE SET NULL,
  comment_count   integer NOT NULL DEFAULT 0,
  -- The same count under §6.4a's predicate. Maintained in the same transaction
  -- as comment_count; it is what a client is told, so that a client can never
  -- count replies it is not allowed to read (§6.4a).
  comment_count_public integer NOT NULL DEFAULT 0,
  -- derived, indexable projections of the anchor. Generated → always consistent.
  route           text GENERATED ALWAYS AS (anchor #>> '{page,route}')    STORED,
  pathname        text GENERATED ALWAYS AS (anchor #>> '{page,pathname}') STORED,
  origin          text GENERATED ALWAYS AS (anchor #>> '{page,origin}')   STORED,
  -- AnchorRecord.label (foundations §5, FOLDBACK §A7): '"Browse the autumn
  -- range"', 'an image', 'the h1'. Projected because the orphan list, the
  -- export and v2 search all read it AFTER the element it describes is gone.
  -- DISPLAY ONLY. Never a re-anchor input -- matching is 03's, and this string
  -- is a human description, not a selector.
  anchor_label    text GENERATED ALWAYS AS (anchor #>> '{label}')          STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  deleted_at      timestamptz,
  UNIQUE (project_id, key),
  UNIQUE (round_id, round_number),
  CHECK (version > 0),
  CHECK (round_number > 0),
  CHECK (jsonb_typeof(anchor)  = 'object' AND anchor ? 'offset' AND anchor ? 'page'),
  CHECK (jsonb_typeof(context) = 'object'),
  CHECK (octet_length(anchor::text)  <= 32768),
  CHECK (octet_length(context::text) <= 262144),
  CHECK (array_length(labels, 1) IS NULL OR array_length(labels, 1) <= 32),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (comment_count_public >= 0 AND comment_count_public <= comment_count),
  -- A team-only thread's replies are all team-only by construction, so its
  -- public count is zero. Cheap, and it makes the leak in §6.4a impossible
  -- rather than merely unlikely.
  CHECK (NOT private OR comment_count_public = 0)
);

CREATE TABLE comments (
  id           uuid PRIMARY KEY,            -- wire form 'cmt_…'
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- denormalised for RLS + rate accounting
  body         text,                        -- NULL when soft-deleted (tombstone)
  body_hash    bytea,                       -- sha256, duplicate detection (§9.4)
  -- parsed at write time from @[Name](snag:user/<reviewerId>) in the body, so
  -- notification fan-out never re-parses markdown (foundations §5, §2.11)
  mentions     uuid[] NOT NULL DEFAULT '{}',
  author_id    uuid NOT NULL REFERENCES reviewers(id) ON DELETE RESTRICT,
  moderation   snag_moderation NOT NULL DEFAULT 'visible',
  -- TEAM-ONLY REPLY (foundations §5, FOLDBACK §A5). A private reply on a PUBLIC
  -- thread is studio-only; the thread itself stays visible to the client. Same
  -- data-layer exclusion as threads (§6.4a).
  private      boolean NOT NULL DEFAULT false,
  seq          integer NOT NULL,            -- 1-based position inside the thread
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  edited_at    timestamptz,
  deleted_at   timestamptz,
  UNIQUE (thread_id, seq),
  CHECK (body IS NULL OR char_length(body) <= 10000),   -- foundations §6 budget
  CHECK ((body IS NULL) = (deleted_at IS NOT NULL))
);

CREATE TABLE attachments (
  id           uuid PRIMARY KEY,            -- client-minted; wire form 'att_…'
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id    uuid REFERENCES threads(id)  ON DELETE CASCADE,
  comment_id   uuid REFERENCES comments(id) ON DELETE CASCADE,
  kind         snag_attachment_kind NOT NULL,
  state        snag_attachment_state NOT NULL DEFAULT 'pending',
  storage_key  text NOT NULL UNIQUE,
  content_type text NOT NULL,
  original_filename text,                    -- L3: downloads need a name; keys are hashes
  storage_backend text NOT NULL DEFAULT 's3'
                 CHECK (storage_backend = 's3'),                        -- D18: bytes never live in Postgres
  bytes        bigint NOT NULL CHECK (bytes > 0),                       -- per-kind ceilings below
  width        integer,
  height       integer,
  sha256       bytea NOT NULL,
  uploaded_by  uuid REFERENCES reviewers(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  bound_at     timestamptz,
  deleted_at   timestamptz,
  CHECK ((state = 'bound') = (bound_at IS NOT NULL)),
  -- FOLDBACK §A6: an attachment hangs off EXACTLY ONE of a thread or a comment.
  -- Draft 4 left both nullable with nothing enforcing the choice, which is how
  -- a screenshot ends up counted twice and rendered in two places.
  CHECK (state <> 'bound' OR ((thread_id IS NOT NULL) <> (comment_id IS NOT NULL))),
  CHECK (state =  'bound' OR (thread_id IS NULL AND comment_id IS NULL)),
  -- D18: image kinds keep the closed type list and the 256 KB encode budget.
  -- kind='file' stores as application/octet-stream in the bucket (content_type here
  -- is an icon hint only, never a serving header) and carries the operator cap,
  -- enforced at presign + complete time rather than in DDL.
  CHECK (kind NOT IN ('screenshot','image') OR content_type IN ('image/webp','image/png','image/jpeg')),
  CHECK (kind NOT IN ('screenshot','image') OR bytes <= 262144),
  CHECK (kind <> 'file' OR original_filename IS NOT NULL),               -- L3: the download filename
  CHECK (kind <> 'dom-snapshot')            -- dropped by the v2 migration that ships dom-snapshot
);
CREATE INDEX attachments_reap_idx   ON attachments (created_at) WHERE state = 'pending';
CREATE INDEX attachments_dedupe_idx ON attachments (project_id, sha256);
-- Enforcing "max 3 per item" (FOLDBACK §A6) at bind time; see §6.6's bind rules.
CREATE INDEX attachments_thread_idx  ON attachments (thread_id)  WHERE deleted_at IS NULL;
CREATE INDEX attachments_comment_idx ON attachments (comment_id) WHERE deleted_at IS NULL;

-- Revocable, per-consumer references to an attachment (§6.6, §6.8). Foundations
-- §14.2: ONE mechanism for embedding a screenshot in an external system.
-- 05 owns the table and the routes; 07 and 08 consume and define nothing.
CREATE TABLE attachment_shares (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  provider      snag_provider NOT NULL,
  external_ref_id uuid,                     -- the issue/message this was embedded in
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,                -- NULL = until revoked (SNAGSET_ATTACHMENT_SHARE_TTL_DAYS=0)
  revoked_at    timestamptz,
  last_fetched_at timestamptz,
  fetch_count   integer NOT NULL DEFAULT 0,
  UNIQUE (attachment_id, provider, external_ref_id)
);
CREATE INDEX attachment_shares_att_idx ON attachment_shares (attachment_id)
  WHERE revoked_at IS NULL;

CREATE TABLE integrations (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider      snag_provider NOT NULL,
  -- Non-secret config (repo, labels, channel id, attachment share TTL,
  -- includeScreenshot). 07 owns the shape; §3.10 validates per provider.
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  credentials   bytea,                      -- AES-256-GCM, HKDF(SNAGSET_SECRET_KEY,'credential-enc')
  credentials_iv bytea,
  enabled       boolean NOT NULL DEFAULT true,
  install_state text NOT NULL DEFAULT 'ok', -- ok | needs_reauth | error
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (project_id, provider)
);

CREATE TABLE external_refs (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  provider     snag_provider NOT NULL,
  kind         snag_ref_kind NOT NULL,        -- foundations §5, five members
  status       snag_ref_status NOT NULL DEFAULT 'synced',
  external_id  text NOT NULL,
  url          text NOT NULL,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  -- §14.2b: the compound unique is the idempotency key for "we already recorded
  -- THIS remote object". It permits a thread to carry a GitHub issue AND several
  -- PR links AND attachment backlinks.
  UNIQUE (thread_id, provider, kind, external_id)
);
-- …and exactly one canonical issue and one canonical message per (thread, provider),
-- because "which issue is this thread's issue?" must have one answer. Draft 3's
-- blanket UNIQUE (thread_id, provider, kind) forbade an issue AND a PR; this pair
-- is 07's shape and permits it.
CREATE UNIQUE INDEX external_refs_canonical
  ON external_refs (thread_id, provider, kind)
  WHERE kind IN ('issue','message');
CREATE INDEX external_refs_lookup ON external_refs (provider, external_id);

-- Transactional outbox (v1), 07 §2.5's shape verbatim. Rows are inserted in the
-- SAME transaction as the thread/comment mutation -- that transactionality plus
-- the unique below IS the idempotency guarantee. §6.2 step 10 does it.
CREATE TABLE outbox (
  id              uuid PRIMARY KEY,         -- UUIDv7. NOT bigserial (foundations §2.10).
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  integration_id  uuid REFERENCES integrations(id) ON DELETE CASCADE,
  thread_id       uuid REFERENCES threads(id) ON DELETE CASCADE,
  provider        snag_provider NOT NULL,
  topic           text NOT NULL,            -- vocabulary owned by 07
  -- 07's dedupe key: '<topic>:<entityId>:<threads.version>'. Its COMPOSITION is
  -- 07's; its uniqueness is enforced here.
  dedupe_key      text NOT NULL,
  event           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the raw DomainEvent, sanitised at push time
  status          snag_outbox_status NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  -- THE idempotency guarantee against duplicate issue creation (§14.2b).
  -- Draft 3 dropped it while still calling the outbox "the idempotency guarantee".
  UNIQUE (provider, dedupe_key),
  CHECK (octet_length(event::text) <= 65536)
);
CREATE INDEX outbox_due ON outbox (status, next_attempt_at) WHERE status = 'pending';

-- Sync ledger, 07 §2.5's shape. OUTBOUND half is v1 (it is what makes v2's loop
-- prevention a pure addition rather than a retrofit); the INBOUND half ships with
-- two-way sync in v2 (foundations §14.2).
CREATE TABLE sync_ledger (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider      snag_provider NOT NULL,
  direction     snag_sync_direction NOT NULL,
  delivery_id   text NOT NULL,              -- provider delivery id (outbound: our outbox id)
  entity_kind   snag_sync_entity NOT NULL,
  entity_id     uuid,                       -- thread or comment row id
  external_id   text,
  -- THE loop-prevention key (§14.2b): sha256 of the normalised body. Without it
  -- a comment synced out and read back in is re-applied, and echoes forever.
  content_hash  bytea NOT NULL,
  thread_id     uuid REFERENCES threads(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, direction, delivery_id)
);
CREATE INDEX sync_ledger_content
  ON sync_ledger (provider, entity_kind, content_hash, created_at DESC);

-- 07's name (draft 3 called this 'webhooks'), §14.2b. The ROUTE stays
-- /projects/{uid}/webhooks (endpoint 26) because that is the resource name 07
-- cites and customers type; the table is the endpoint record.
CREATE TABLE webhook_endpoints (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url         text NOT NULL,
  secret      bytea NOT NULL,               -- encrypted under 'credential-enc'
  secret_iv   bytea NOT NULL,
  event_types text[] NOT NULL DEFAULT '{*}',
  enabled     boolean NOT NULL DEFAULT true,
  failure_streak integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  disabled_reason text,
  -- http:// is permitted AT THE DB LEVEL so that SNAGSET_WEBHOOKS_ALLOW_HTTP
  -- (foundations §2.9, registered in 08 §4.6, default false) is not dead
  -- configuration. The scheme rule is enforced in the app (§6.12) together with
  -- the SSRF address-space guard, which is a separate switch.
  CHECK (url ~ '^https?://')
);
CREATE INDEX webhook_endpoints_project_idx ON webhook_endpoints (project_id)
  WHERE disabled_at IS NULL;

CREATE TABLE events (
  id             uuid PRIMARY KEY,          -- UUIDv7; the row's identity
  seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,  -- total-order cursor (webhook replay, audit paging); pre-R6 it also fed SSE
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  type           text NOT NULL,             -- see §8.2
  actor_kind     text NOT NULL,             -- reviewer|user|system|integration
  actor_id       uuid,
  subject_type   text NOT NULL,             -- thread|comment|project|review_link|attachment
  subject_id     uuid,
  route          text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash        bytea,                     -- sha256(ip || projects.ip_salt); never raw IP
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(payload::text) <= 16384)
);
CREATE INDEX events_project_seq  ON events (project_id, seq);

-- 07 §7.4's delivery log, verbatim.
CREATE TABLE webhook_deliveries (
  id            uuid PRIMARY KEY,           -- this IS the Standard Webhooks 'webhook-id'
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  endpoint_id   uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id      uuid REFERENCES events(id) ON DELETE SET NULL,
  event_type    text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'pending',  -- pending|delivered|failed|dropped
  request_headers jsonb NOT NULL DEFAULT '{}'::jsonb,   -- secret-free by construction
  request_body_hash bytea NOT NULL,
  request_body_excerpt text,                -- first 8 KB of the ALREADY-SANITISED payload
  response_code integer,
  response_body_excerpt text,               -- first 2 KB
  duration_ms   integer,
  error_class   text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  replay_of     uuid REFERENCES webhook_deliveries(id) ON DELETE SET NULL,
  CHECK (octet_length(coalesce(request_body_excerpt,'')) <= 8192),
  CHECK (octet_length(coalesce(response_body_excerpt,'')) <= 2048)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at DESC);

CREATE INDEX events_env_seq      ON events (project_id, environment_id, seq);
CREATE INDEX events_subject      ON events (subject_type, subject_id, seq DESC);
CREATE INDEX events_created      ON events (created_at);

-- Append-only re-anchor outcomes. Backs Thread.anchorHistory (foundations §5),
-- 03's re-anchor reporting, and 08 §6's cedilla_anchor_resolutions_total metric.
CREATE TABLE anchor_events (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  state        snag_anchor_state NOT NULL,    -- settled only; 'pending' is rejected upstream
  confidence   real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  strategy     text NOT NULL,               -- validated against 03's AnchorStrategy enum
  actor_kind   text NOT NULL,               -- 'runtime' (automatic) | 'reviewer' (repair, v2)
  actor_id     uuid REFERENCES reviewers(id) ON DELETE SET NULL,
  build        text,                        -- CaptureContext.build.commit when supplied
  ms           integer,                     -- cascade wall-clock, for 03's telemetry
  applied      boolean NOT NULL DEFAULT true,  -- false when the monotonic merge declined it
  previous_anchor jsonb                     -- only on 'manual' repair, so a bad repair is undoable
);
CREATE INDEX anchor_events_thread_idx ON anchor_events (thread_id, at DESC);
CREATE INDEX anchor_events_applied_idx ON anchor_events (thread_id, at DESC) WHERE applied;
CREATE INDEX anchor_events_project_idx ON anchor_events (project_id, at DESC);

CREATE TABLE idempotency_keys (
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key           text NOT NULL,
  method        text NOT NULL,
  path          text NOT NULL,
  request_hash  bytea NOT NULL,            -- sha256(body) — detects key reuse with a different body
  status_code   integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (project_id, key)
);
CREATE INDEX idempotency_expiry ON idempotency_keys (expires_at);

CREATE TABLE identity_nonces (              -- HMAC handshake replay protection (§4.6)
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  nonce      text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, nonce)
);
CREATE INDEX identity_nonces_expiry ON identity_nonces (expires_at);

-- stream_tickets: DELETED with the SSE fan-out (sweep R6). The DDL that stood
-- here is preserved in §8.3's history note; migration 0001 does not create it.

CREATE TABLE export_jobs (                  -- endpoint 28b (async export)
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  format       text NOT NULL CHECK (format IN ('json','md','csv','zip')),
  status       text NOT NULL DEFAULT 'queued',   -- queued|running|ready|failed|expired
  storage_key  text,
  bytes        bigint,
  sha256       bytea,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  expires_at   timestamptz NOT NULL          -- artefact deleted after this; default +24 h
);
CREATE INDEX export_jobs_project_idx ON export_jobs (project_id, created_at DESC);
CREATE INDEX export_jobs_expiry_idx  ON export_jobs (expires_at);

-- v2, shipped by the v2 migration with endpoint 41. Declared here because
-- [01](01-product.md) §6.4 renders reactions and reported that 05 carried
-- neither a table nor a route; the route is endpoint 41 and this is the table.
CREATE TABLE reactions (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  emoji      text NOT NULL CHECK (char_length(emoji) <= 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, reviewer_id, emoji)
);
CREATE INDEX reactions_comment_idx ON reactions (comment_id);

CREATE TABLE rate_counters (                -- durable tier only (§9.2). Org-scoped by §3.0.
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  bucket_key   text NOT NULL,
  window_start timestamptz NOT NULL,
  count        bigint NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (org_id, bucket_key)
);
CREATE INDEX rate_counters_expiry ON rate_counters (expires_at);

-- "Someone pasted your UID elsewhere" AND "we saw your widget on an origin you
-- have not allowed — add it?" are the same fact, so they are one table
-- (foundations §14.2b deletes the separate origin_suggestions). CAP 5 PER
-- PROJECT, which also bounds what a forged-Origin flood can write (§4.9).
CREATE TABLE origin_violations (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin      text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  hits        bigint NOT NULL DEFAULT 1,
  -- false = it only ever fetched /config (the "add this origin?" suggestion case)
  -- true  = it attempted a write (the "your UID is in use elsewhere" case)
  write_attempted boolean NOT NULL DEFAULT false,
  notified_at timestamptz,
  PRIMARY KEY (project_id, origin)
);

CREATE INDEX threads_hot ON threads (project_id, environment_id, route, status, updated_at DESC)
  WHERE deleted_at IS NULL AND moderation = 'visible';

-- The client-role hot path (§6.4a). A partial index rather than widening
-- threads_hot with a boolean: `private` is overwhelmingly false, so the partial
-- index is smaller than the base one and the predicate is free at plan time.
CREATE INDEX threads_hot_public ON threads (project_id, environment_id, route, status, updated_at DESC)
  WHERE deleted_at IS NULL AND moderation = 'visible' AND private = false;

CREATE INDEX threads_sync ON threads (project_id, environment_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Delta polling for a CLIENT session: the same window, public rows only. A
-- client's `since` poll must never touch a private row, including to discover
-- that its updated_at moved.
CREATE INDEX threads_sync_public ON threads (project_id, environment_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL AND private = false;

-- Comments under the visibility predicate (§6.4a). comments_thread stays for
-- the studio read; this one serves the client read without a filter step.
CREATE INDEX comments_thread_public ON comments (thread_id, seq)
  WHERE deleted_at IS NULL AND private = false;

CREATE INDEX threads_env_recent ON threads (project_id, environment_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX threads_anchor_testid ON threads (project_id, (anchor->>'testId'))
  WHERE deleted_at IS NULL AND anchor ? 'testId';

CREATE INDEX threads_anchor_domid  ON threads (project_id, (anchor->>'domId'))
  WHERE deleted_at IS NULL AND anchor ? 'domId';

CREATE INDEX threads_orphans ON threads (project_id, environment_id, updated_at DESC)
  WHERE deleted_at IS NULL AND anchor_state = 'orphaned';

CREATE INDEX threads_author  ON threads (created_by, created_at DESC);
CREATE INDEX comments_author ON comments (author_id, created_at DESC);

CREATE INDEX comments_thread ON comments (thread_id, seq)
  WHERE deleted_at IS NULL;

CREATE INDEX comments_dupe ON comments (author_id, body_hash, created_at DESC);


-- ── Row-level security ───────────────────────────────────────────────────
--
-- 08 §9.2: defence in depth BEHIND the application's own scoping, possible
-- only because the tenant key was there from the first migration rather
-- than retrofitted. A32's smoke test is the acceptance criterion: with
-- app.org_id set to org A, a query for org B's threads returns zero rows.

ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;
CREATE POLICY orgs_org ON orgs USING (id = current_setting('app.org_id', true)::uuid);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_org ON users USING (id IN (SELECT user_id FROM memberships WHERE org_id = current_setting('app.org_id', true)::uuid));
ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY user_identities_org ON user_identities USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_org ON memberships USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_org ON user_sessions USING (org_id = current_setting('app.org_id', true)::uuid);
-- setup_tokens: no RLS. It is pre-tenant (05 §3.2 — "the ONE table with
-- no org_id, because it exists precisely when no org does"), so there is
-- nothing to scope by. Its safety is the token hash and single use.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_org ON projects USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY api_keys_org ON api_keys USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_tokens_org ON mcp_tokens USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE project_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY project_origins_org ON project_origins USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments FORCE ROW LEVEL SECURITY;
CREATE POLICY environments_org ON environments USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounds FORCE ROW LEVEL SECURITY;
CREATE POLICY rounds_org ON rounds USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE review_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_links FORCE ROW LEVEL SECURITY;
CREATE POLICY review_links_org ON review_links USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE reviewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviewers FORCE ROW LEVEL SECURITY;
CREATE POLICY reviewers_org ON reviewers USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
CREATE POLICY threads_org ON threads USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;
CREATE POLICY comments_org ON comments USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachments_org ON attachments USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE attachment_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY attachment_shares_org ON attachment_shares USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY integrations_org ON integrations USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE external_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY external_refs_org ON external_refs USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_org ON outbox USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE sync_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY sync_ledger_org ON sync_ledger USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_endpoints_org ON webhook_endpoints USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
CREATE POLICY events_org ON events USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_deliveries_org ON webhook_deliveries USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE anchor_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE anchor_events FORCE ROW LEVEL SECURITY;
CREATE POLICY anchor_events_org ON anchor_events USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_org ON idempotency_keys USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE identity_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_nonces FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_nonces_org ON identity_nonces USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY export_jobs_org ON export_jobs USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reactions FORCE ROW LEVEL SECURITY;
CREATE POLICY reactions_org ON reactions USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE rate_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_counters_org ON rate_counters USING (org_id = current_setting('app.org_id', true)::uuid);
ALTER TABLE origin_violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE origin_violations FORCE ROW LEVEL SECURITY;
CREATE POLICY origin_violations_org ON origin_violations USING (org_id = current_setting('app.org_id', true)::uuid);

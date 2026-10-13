# `snagset` — the server

One npm package: the API, the widget assets, the dashboard statics and the
migrations, with two entry points on the same `createApp(deps)`.

## Run it

```bash
DATABASE_URL=postgres://… npx snagset
```

That is the whole install. The bin migrates its own schema under an advisory
lock, generates a signing key if it has none, and serves. An instance with no
owner shows a setup screen; the first person to fill it in becomes the owner.
Postgres is the only requirement:
no Redis, no S3, no queue, no extensions.

| Command | What it does |
|---|---|
| `snagset` | migrate, then serve (the default) |
| `snagset migrate` | migrate and exit — for a deploy step |
| `snagset bootstrap` | claim the instance headlessly, from `SNAGSET_BOOTSTRAP_*` |
| `snagset origins <uid>` | what may write to a project, and what has asked to |
| `snagset allow-origin <uid> <origin>` | approve one |

Exit codes: `2` bad config, `3` database unreachable, `4` a migration refused
(a checksum changed, or the database is ahead of this build).

## First run

`orgs` is empty, so the instance is **CLAIMABLE**: every route but `/healthz`,
`/readyz`, `/api/v1/meta` and `/api/v1/setup` answers `409 instance_unclaimed`,
and `<data>/secret.key` is the only thing written there — back it up.

409 and not 503 is deliberate: a 503
tells every proxy in the path that a healthy instance is unhealthy, and a
fresh container behind one would restart-loop before anyone read the URL.

Opening the URL and posting to `/api/v1/setup` creates the org, the owner, the
first project, its `production` and `preview` environments, **Round 1**, and a
session — in one transaction. The gate lifts without a restart.

Lost the URL? It is stored as a hash and cannot be re-printed. `snagset
bootstrap` mints a new one.

## Two things an operator should know

**The signing key.** Generated to `<data>/secret.key` at mode 0600 on first
boot, or supplied as `SNAGSET_SECRET_KEY`. Back it up and treat it as a
password: without it, stored integration credentials are unrecoverable
ciphertext and every reviewer session is dead. On serverless it is **required**
— the filesystem is ephemeral, so a generated key would differ on every cold
start.

**Row-level security may not be in force.** Migration 0001 enables and `FORCE`s
RLS on all 31 tenanted tables. A role with the `BYPASSRLS` attribute overrides
all of it — and managed Postgres often grants it to the role in the connection
string it hands you (Supabase's `postgres` and Neon's `neondb_owner` both do,
and neither can drop it from itself). Boot says so, and `/readyz` reports it.
Requests are still scoped by `org_id` in the application, so this is a lost
safety net rather than an open door; to get it back, create a role without
`BYPASSRLS`, grant it the tables, and point `DATABASE_URL` at that — the
recipe, for Supabase and for any other provider, is in
[docs/self-hosting.md](../../docs/self-hosting.md).

## Origins

A project starts with an empty allow-list, and nothing is ever allow-listed
automatically: `Origin` is attacker-controllable, so auto-allowing would be an
attacker-controlled header granting access. Origins that fetch `/config` are
*recorded* — `snagset origins <uid>` shows them — and `snagset allow-origin`
is the human decision.

## Where the schema comes from

`src/db/migrations/` holds the schema as numbered SQL files: `0001_init.sql`
(32 tables, 15 enums, 58 indexes, plus the RLS block) and every change since.
They are applied in order, once each, and each file's checksum is recorded —
an applied migration is never edited, so every schema change is a new file.

## Tests

`pnpm test` runs everything that needs no database. Set
`SNAGSET_TEST_DATABASE_URL` to also run the claim-flow tests — they **drop and
recreate the public schema**, which is why they refuse to read `DATABASE_URL`.

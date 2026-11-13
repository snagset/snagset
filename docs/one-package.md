# One-package quickstart (Vercel)

A deployed instance, on a free plan, in about five minutes. Everything here is
in the repository `npx create-snagset` writes for you.

## 1. Scaffold and push

```bash
pnpm create snagset my-review
cd my-review
git init && git add . && git commit -m "Snagset"
```

Push it to GitHub. **Check `.env` is not in the commit** — the scaffold's
`.gitignore` covers it, and it holds your signing key.

## 2. Import it into Vercel

Add the project from your GitHub repository. Vercel finds `vercel.json` and
`api/index.js`; there is no framework preset to choose and no build command to
set.

## 3. Add a Postgres

From the Vercel marketplace — Supabase and Neon both work, and both have a free
tier. Either integration writes the pooled connection string into the
project's environment: Neon as `DATABASE_URL`, Supabase as `POSTGRES_URL`,
and the server reads either (it prefers `DATABASE_URL` when both exist).

Bringing your own Supabase project instead? Set `DATABASE_URL` to its
**transaction pooler** string (port 6543) — serverless functions open a
connection per instance, and the pooler is what stops that exhausting the
database's limit. Not the direct string: it is IPv6-only. [Self-hosting](self-hosting)
has the Supabase details, including the role without `BYPASSRLS` and the Data
API switch.

## 4. Set the signing key

Copy `SNAGSET_SECRET_KEY` from your local `.env` into the project's environment
variables. That is the only one: Vercel names the deployment itself
(`VERCEL_PROJECT_PRODUCTION_URL`, which is your custom domain once one is
attached), and the server reads it, so there is no address to type. Set
`SNAGSET_BASE_URL` only if you want links built from some other address.

**The key is required here, unlike locally.** Running on your own machine, the
server generates one to `.snagset/secret.key` on first boot. A serverless
filesystem is ephemeral, so each instance would invent a different key — a
session minted by one would fail to verify on the next, and an encrypted
credential written by one would be unreadable by all the others. The server
refuses to start without it and says so.

## 5. Migrate when you upgrade

A function has no startup to migrate at — migrating on a cold request would put
every instance behind the one applying DDL, on somebody's first page load. So on
Vercel the schema is yours to bring along: after installing a new version, run
this from the project, with the deployment's `DATABASE_URL` in your `.env`:

```
npx snagset migrate
```

It applies only what is new and is safe to run when there is nothing to do.
Before or after the deploy both work; a release says when its migration must
come first.

**Not as the build command.** It looks like the natural place, and this page
said so until 0.1.12 — but Vercel refuses a build that leaves no static output,
and an empty `public/` too, so the deploy fails before it starts. If you forget,
the dashboard says so: every page shows a banner while the database is behind
the code, and the server log names the missing migrations.

## 6. Claim it

Open your deployment and create the first owner. An instance with no owner
shows a setup screen instead of a sign-in form, and the first person to fill it
in becomes the owner — so **do this immediately after the deploy finishes**,
before you share the URL.

That is the whole of it, anywhere. **There is no claim URL** — nothing mints
one now, on any deployment. This page told you to hunt the logs for one until
2026-09-01, which was doubly wrong on a platform: a serverless function never
minted a token in the first place, so the line could not have been there.

Prefer to claim it from a terminal instead? `snagset bootstrap` still works, and
so do the bootstrap variables — see [self-hosting](self-hosting).

## What you get

Notifications to reviewers and tracker updates go out as soon as the comment
or status change that caused them is saved. There is nothing to schedule for
that.

`vercel.json` schedules the rest, once a day:

```json
{ "crons": [{ "path": "/api/jobs/run", "schedule": "0 3 * * *" }] }
```

That run sends the owner's daily digest of new comments (see
[who gets email](self-hosting#who-gets-email-and-how-often)), and tidies up:
it retries a notification that failed to send, deletes
expired one-time tokens and rate-limit counters, and removes uploads nobody
attached. If you set `SNAGSET_WRITE_MODE_GRACE_HOURS`, a new site's open window
closes on time whether it has run or not. Once a day is all Vercel's Hobby plan
allows.
On Pro you can make it hourly with `"0 * * * *"`, so a failed send is retried
sooner.

Set `CRON_SECRET` in the environment. The route returns 503 until you do,
rather than running unauthenticated.

## Costs, honestly

| | Free tier | When you outgrow it |
|---|---|---|
| Vercel | Hobby, for non-commercial use | Pro, if you are billing clients |
| Supabase / Neon | ~0.5 GB | A few euros a month |
| Screenshots | — | An S3-compatible bucket, cents per month |

Vercel's Hobby plan forbids commercial use. If you are billing clients for this
work, that is a Pro plan — or any Node host, since the same package runs with
`npm start`.

A free Postgres that sleeps when nobody uses it, as Neon's does, gets to sleep:
the server only queries the database when someone is using Snagset, and for the
daily run.

## Or anywhere else

Nothing here is Vercel-specific except `vercel.json`. Railway, Render, Fly and a
plain VPS all take the same repository with `npm start` — against Supabase,
with the **session pooler** string there. [Self-hosting](self-hosting) walks a
studio instance through end to end.

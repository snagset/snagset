# Self-hosting

This is the product. Not a generous edge of a hosted service — the thing itself.
There is no crippled open-source edition, no licence key, and no feature that
exists only in a paid tier's binary.

## Requirements

**Node 22 or newer, and a Postgres database.** That is the list.

A bucket and a mailer are optional and the product is complete without them:
with no bucket you get *annotation mode* — comments, pins, replies, statuses,
rounds, and an element description on every pin — and the widget is *told*
screenshots are unavailable rather than offering one that fails. With no mailer,
notifications are off and the dashboard says so; nothing queues up waiting.

Any Postgres 14+ works: Supabase, Neon, RDS, or one you run yourself. If your
provider offers a **pooled** connection string, use it. Supabase and Neon
each have a short section below, because each has one or two things worth
knowing before the first boot.

## Install

```bash pnpm
pnpm create snagset my-review
cd my-review
pnpm install && pnpm start
```
```bash npm
npm create snagset@latest my-review
cd my-review
npm install && npm start
```
```bash yarn
yarn create snagset my-review
cd my-review
yarn install && yarn start
```
```bash bun
bun create snagset my-review
cd my-review
bun install && bun start
```

Already in the folder you want it in — a fresh `git init`, say? Pass `.`
instead of a name (`pnpm create snagset .`) and skip the `cd`. A `.git`, a
`.DS_Store` or an editor folder is fine; anything the scaffold would
overwrite is refused.

Put your `DATABASE_URL` in `.env` first — that is the only required variable.
Open http://localhost:8080 and create the first owner (if 8080 was taken, the
boot line says which port it took instead). An instance nobody
has claimed shows a setup screen rather than a sign-in form, and the first
person to fill it in becomes the owner — so do that before you share the
address.

**There is no Docker here, on purpose.** No Dockerfile, no compose file, no
container to build. Snagset is a Node process and a Postgres URL. That means
one less thing to install, and a database your laptop, your CI and your deploy
can all reach — which a compose-local Postgres cannot.

You get a small repository **you own** — your `.env`, your Vercel config — that
depends on `@snagset/server` like any other package. Upgrading is one
command — see [Upgrade](#upgrade) below. There is no build step, and our
source is not in your tree unless you want it there.

## Configure

One variable is required:

```bash
DATABASE_URL=postgres://user:password@host:5432/snagset
```

Everything else is optional. Put them in a `.env` or `.env.local` next to where
you run it — the server reads both, and a real environment variable always wins
over a file. `.env.example` in the repo lists every option with its default.

The two you are most likely to want:

```bash
# Screenshots and uploads. Any S3-compatible bucket.
SNAGSET_STORAGE_S3_ENDPOINT=https://ams3.digitaloceanspaces.com
SNAGSET_STORAGE_S3_BUCKET=my-bucket
SNAGSET_STORAGE_S3_REGION=ams3
SNAGSET_STORAGE_S3_ACCESS_KEY_ID=DO00XXXXXXXX
SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY=…

# Email notifications. The scheme picks the transport.
SNAGSET_MAIL_URL=resend://re_your_api_key
SNAGSET_MAIL_FROM=snagset@example.com
```

Storage credentials are **probed at boot** — one write, read and delete of a
small object — and a failure is a loud warning rather than a crash, because
credentials that are merely well-formed are the ones that fail on the first
screenshot, in front of a reviewer, an hour later.

Both can also be connected later, from **Studio › General**, without a
restart. The environment wins if both are set.

### Who gets email, and how often

The studio's owner hears about new comments in **one email a day**: a digest,
grouped by site, with who wrote each comment, the start of it, the page, and a
link that opens the thread in the dashboard. It goes out with the first job run
after midnight UTC (03:00 UTC with the scaffold's daily cron, shortly after
midnight on the bin) and covers everything up to that midnight. A day with no
new comments sends nothing.

```bash
# One email per comment, as soon as it is saved, instead of the digest.
SNAGSET_MAIL_NOTIFY=each
```

Reviewers who took part in a thread still hear about each reply on it, and when
it is resolved, as it happens.

Whoever a snag is **assigned** to — a colleague, or a client with an email
address — hears about it an hour after the assignment, in one email for
everything assigned to them in that time, and only for snags that are still
theirs, still open, and that they have not already answered. On a platform
where jobs run on writes and once a day (Vercel), that email goes at the first
activity on the instance after the hour, or at the daily run. The hour is
`SNAGSET_ASSIGN_MAIL_DELAY_S` (seconds, default `3600`). Nobody is emailed about a comment they wrote,
including the owner testing the widget on their own site under another name
with their own email address.

### The database connection is encrypted by default

`SNAGSET_DATABASE_SSL` is `auto`: TLS for any host that is not local
(loopback, a private range, `localhost`, a bare service name like `db`),
plaintext for those. A connection string that carries its own `?sslmode=`
is honoured as written. Set `require` to insist, or `disable` for a private
network whose Postgres has no certificate. The certificate is not verified
in the default mode — that is libpq's `require` too, and it is what a
managed provider's own certificate authority needs; write
`?sslmode=verify-full` into the URL if you have the root certificate
installed and want it checked.

### Supabase

Supabase is more than a Postgres, so a few of its defaults need changing, and
its dashboard offers several connection strings of which one is right. In
order, because each step produces something the next one wants:

1. **Create the project** in the region nearest your clients, which should
   also be where Snagset runs: on Vercel, set `regions` in `vercel.json` to
   the same city (see [Run the server next to the database](#run-the-server-next-to-the-database)). Generate the database password and keep it. It is the
   database's admin password; Snagset connects with its own (step 3).
2. **Turn the Data API off** — Integrations › Data API, *Enable Data API*
   (on older dashboards it is under Project Settings › API). Supabase's REST
   layer serves every table in `public` to anyone holding the project's anon
   key. The policies the server installs deny that key every row, but Snagset
   is this database's only client and needs no second door into its tables.
3. **Give Snagset its own role.** SQL Editor › New query, and run the three
   `snagset_app` lines from [the row-level security section](#read-the-boot-banner-especially-about-row-level-security)
   (the database is called `postgres` here). Supabase's own `postgres` role
   bypasses row-level security; this one does not, and made before the first
   boot it owns its tables from the start. Optional on an instance with one
   studio — skip it and the boot log says the second layer is off.
4. **Copy the connection string.** Click **Connect** at the top of the
   project. It opens on **Framework**, which is for app code — choose
   **Direct** (*Connection string*) instead, then the method from the table
   below.

| Method | Looks like | Use it for |
|---|---|---|
| **Session pooler** | `…pooler.supabase.com:5432` | `pnpm start` — a Node process on Railway, Render, Fly, a VPS, your laptop |
| **Transaction pooler** | `…pooler.supabase.com:6543` | Vercel and other serverless hosts |
| Direct connection | `db.<ref>.supabase.co:5432` | Avoid: IPv6-only unless you buy the IPv4 add-on |

In the string the user is written `postgres.<ref>`. Change it to
`snagset_app.<ref>`, and `[YOUR-PASSWORD]` to that role's password (if you
skipped step 3, put in the database password instead). That is
`DATABASE_URL`. **Quote it in `.env`**: a password with `&`, `#` or `$` in it
otherwise ends the line early. In a platform's environment-variable form,
paste it without quotes.

A "network unreachable" or a hang at boot almost always means the direct
string was pasted on a host without IPv6. The pooler strings carry no
`?sslmode=`; the server encrypts them anyway (above).

**A free project pauses after a week without activity, and stays down.** It
does not wake for the next visitor: the database is unreachable, so every
page and every review link errors, until someone opens the Supabase
dashboard and clicks **Resume project**, which takes up to a few minutes.
Supabase emails a warning first. The smallest paid tier never pauses, and a
studio showing work to clients should be on it.

### Neon

Use the **pooled** string — the host carries `-pooler` — for every kind of
host; it already ends in `?sslmode=require&channel_binding=require`, which
is honoured as written, and which is why the string must be quoted in a
`.env`. The role in it, `neondb_owner`, bypasses row-level security like
Supabase's `postgres`; the same three-line recipe below gives you one that
does not, and a role made in SQL there (not in the console) is the one
without the bypass. Neon's free tier scales to zero after five minutes idle,
so the first reviewer of a quiet day pays the wake; the smallest paid tier
can keep it warm.

### The address every link is built from

You do not set it. When you claim the instance, the address your browser is at
is kept as the instance's address, and every review link, issue, Slack message
and email is built from it; Studio › General shows it and an owner can change
it there. On Vercel, Railway, Render and Fly the platform's own variable names
the deployment and is used before the claim. `SNAGSET_BASE_URL` exists to say
otherwise — set it and it wins and locks the row.

## A studio instance, end to end

One shape that works for a studio showing work to clients, and the one
our own instance runs: **Supabase** for the database (Neon or any other
Postgres slots in the same way), a **DigitalOcean Space** for screenshots,
**Resend** for mail, and any host that runs Node. Nothing below is required
except the database; the rest can be added later from Studio › General. In
order, because each step produces a value the next one wants:

1. **Supabase.** New project, in the region nearest your clients, on a paid
   tier if it must never pause. SQL Editor: the three `snagset_app` lines
   from [the row-level security section](#read-the-boot-banner-especially-about-row-level-security).
   Integrations › Data API: turn it off. Connect › **Direct**: copy the
   **session pooler** string (or the transaction pooler for Vercel), change
   the user to `snagset_app.<ref>` and the password to the one you chose.
   That is `DATABASE_URL`. [Supabase](#supabase) has each step in full.
2. **Spaces.** Create a Space (private — the server serves every image
   itself, and a public bucket would serve them to anyone with the key).
   API › Spaces Keys › Generate. The endpoint is
   `https://<region>.digitaloceanspaces.com`, the region is that same
   `<region>` (`ams3`, `fra1`, `nyc3` — `auto` is for R2), the access key is
   the short `DO00…` value and the secret the long one. Five variables:
   `SNAGSET_STORAGE_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`,
   `_SECRET_ACCESS_KEY`. A DigitalOcean API token is a different credential
   and cannot sign S3 requests — the boot probe says so if one is pasted.
3. **Resend.** Add a domain and verify its records — a subdomain such as
   `send.yourstudio.com` keeps review mail's reputation apart from your own.
   Create an API key with sending access to it. `SNAGSET_MAIL_URL=resend://re_…`
   and `SNAGSET_MAIL_FROM="Snagset <review@send.yourstudio.com>"` — the
   From address must be on the verified domain, or every send is refused.
4. **The host.** Scaffold with `pnpm create snagset`, commit it, and deploy
   the repository to anything that runs `pnpm start` — Railway, Render, Fly,
   a VPS. Set the variables above plus `SNAGSET_SECRET_KEY` (the scaffold
   generated one into `.env`; copy it, since a platform's disk may not
   persist) and `SNAGSET_TRUST_PROXY=1` behind the platform's own proxy, or
   the rate limiter sees one address for everybody. `PORT` and the public
   address are read from the platform. On Vercel instead: the transaction
   pooler string, `CRON_SECRET`, and `npx snagset migrate` run by you after
   each upgrade (not as the build command — Vercel fails a build with no
   static output) — see [the Vercel quickstart](one-package); its Hobby plan is
   non-commercial by contract, so a studio is on Pro there.
5. **Claim it** before sharing the address — the next section. Then add the
   first client site and paste its tag.
6. **Verify the three services** from the host, or anywhere with the same
   variables: `npx snagset storage status` runs a real write-read-delete
   against the Space; the boot log names the mail transport; `/readyz`
   reports row-level security as `effective: true` on the `snagset_app`
   role. Send yourself a review link and leave one comment from your phone.

The two things to keep somewhere safe are at the end of this page: the
signing key, and a database dump.

## Claim

Open the instance and create the first owner. Until someone does, it shows a
setup screen rather than a sign-in form — and **the first person to fill that in
becomes the owner**, so claim it before you hand the URL to anyone.

**Or skip the browser entirely.** Set these and the instance claims itself:

```bash
SNAGSET_BOOTSTRAP_OWNER_EMAIL=you@example.com
SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE=/run/secrets/owner-password
SNAGSET_BOOTSTRAP_PROJECT_NAME=Acme redesign
SNAGSET_BOOTSTRAP_PROJECT_ORIGINS=https://staging.acme.com,http://localhost:3000
```

The password is a **file**, not a variable: an environment variable is visible
in `/proc`, in `docker inspect`, and in any crash report that dumps the
environment. All four are ignored once the instance has an owner, so they are
safe to leave in place across redeploys.

`snagset serve` claims on boot. To claim without starting the server — a release
step, or a one-shot container — run:

```bash
npx snagset bootstrap
```

With those variables set it claims and says so. Without them it mints a claim
URL to open instead.


## Open sign-up

By default the claim is the only way in, and members join through an invite
link an owner makes on Studio › Members. An instance that should take sign-ups — a studio hosting
Snagset for several teams, each with its own studio — opens the door with one
variable:

```bash
SNAGSET_SIGNUP_OPEN=true
```

The sign-in page then offers **Create a studio**, and the studio menu at the top
of the sidebar offers **New studio…** to anyone signed in. Each studio has its
own sites, members and settings; a person in more than one switches from that
menu. Sign-ups are limited to ten an hour per address. Leave it unset and
nothing changes.

## Every setting

```bash
npx snagset env
```

Prints every variable this build accepts, grouped, with what each is currently
set to and what it defaults to. It needs no database, so it works before you
have provisioned anything — and it is the answer when a typo'd variable stops
the server, since the error names the closest real one and points here.

```bash
npx snagset env MAIL     # just the ones matching MAIL
```

## Add a site — as many as you like

Sign in, open **Sites**, and add one. Give it a name and the addresses it runs
on. You get the tag back immediately:

```html
<script src="https://review.example.com/snag.js" data-snag-site="prj_…" defer></script>
```

Paste it into that site, immediately before `</body>`. Or from a shell:

```bash
snagset projects add "Acme redesign" https://staging.acme.com
```

One instance holds as many sites as you have clients. Each gets its own uid, its
own rounds, its own review links, and its own allow-list.

### Or install it from npm

Same widget, same behaviour — this writes the tag for you:

```bash
pnpm add snagset
```

```js
import snagset from "snagset";
snagset.init({ host: "https://review.example.com", site: "prj_…" });
```

`snagset/react` and `snagset/vue` give you `<Snagset host="…" site="…" />`.
`snagset/next` renders the tag as a server component (or from
`NEXT_PUBLIC_SNAGSET_*` env). `snagset/vite` is a one-line config plugin — and
covers Nuxt, SvelteKit and everything else built on Vite. `snagset/astro`
gives you the tag as data for a layout. Nothing is behind the
pnpm add — if a script tag suits your stack better, use it. It works on
WordPress, Webflow, Shopify and Rails, where a React-only tool cannot go.

### The allow-list is not optional

**Only the addresses you list can talk to the site.** A tag on any other address
loads and is ignored — which is the hardest failure here to spot from the
outside, because nothing is broken and nothing appears. Add them when you create
the site, or later from the same screen:

```bash
snagset allow-origin prj_… https://www.acme.com
```

`https://*.acme.com` covers subdomains. The scheme is required and the port is
part of the address.

### Where the widget comes from

**Your own instance**, at the same version as the server — there is no
third-party CDN in the path, which is the answer to a security team that will
not allow one. `/widget/manifest.json` lists a `sha384` for every file if you
need an integrity hash.

**How it is cached.** The tag you pasted always loads `snag.js` from the same
address, so browsers keep that one file for a minute. Everything it loads
after that carries the build's id in the address (`snag.runtime.js?cv=…`), so
those files are kept for a year and never fetched twice — and a new release
changes every one of those addresses at once.

| Path | `Cache-Control` |
|---|---|
| `/snag.js`, `/widget/snag.js`, `/widget/v{major}/snag.js`, `/widget/manifest.json` | `public, max-age=60, s-maxage=300` |
| `/widget/<this version>/snag.js` | `public, max-age=31536000, s-maxage=31536000, immutable` |
| any chunk, `?cv=` this build's id | `public, max-age=31536000, s-maxage=31536000, immutable` |
| any chunk with another build's `cv` or none; anything under another version's path | `no-store` |

**If you put a CDN in front of your instance**, it has to keep the query
string in its cache key (most do; check yours), and it can keep `snag.js` for
up to the five minutes `s-maxage` allows. Purge it on a deploy if you want
reviewers to see a release sooner. Vercel needs nothing: each deployment
starts its edge cache empty.

## Upgrade

```bash
pnpm update @snagset/server --latest
```

Then restart (`pnpm start`), or redeploy on Vercel. Migrations run on boot,
and there is no build step to redo.

Reviewers get the new widget on their next page load **once a minute has
passed since their last one** — the time a browser keeps `snag.js`. No hard
refresh, nothing to clear. A reviewer with a page already open keeps the
widget they loaded until they reload it.

`--latest` is not optional. The scaffold pins `@snagset/server` to an exact
version deliberately — so that `create-snagset@X` gives everyone a repository
on `@snagset/server@X`, and a fresh checkout of yours installs the version you
last ran — and a plain `pnpm update` respects that pin, which means it does
nothing and says nothing. `--latest` moves the pin and installs the new
version in one step.

**Before a version that carries migrations, take a backup or a branch of the
database.** Most migrations run inside a transaction and roll back if they
fail; a few cannot (adding a value to a Postgres enum must run outside one),
and those are named in the release notes. The boot log lists every migration
it applies.

## Verify

Open the site and press **Alt + C**. The toolbar appears in the bottom corner.
Press **+**, click anything, type a comment, send it. Reload the page — the pin
comes back.

Two commands worth knowing:

```bash
npx snagset storage status   # is the bucket reachable? runs a real probe
npx snagset projects         # ids, snippets, and what is allowed to load them
```

### Read the boot banner, especially about row-level security

The server checks, at every boot, whether row-level security is actually in
force — and says so plainly when it is not. **Read that line rather than
assuming**, because there is one very common case where it is not:

> row-level security is NOT in force: the role "postgres" has BYPASSRLS

Supabase (`postgres`), Neon (`neondb_owner`) and some other hosted Postgres
providers hand you a connection string for a role carrying the `BYPASSRLS`
attribute. The policies are installed, enabled and correct; the role simply
outranks them. The role cannot remove the attribute from itself either
(`permission denied to alter role`), so no migration can fix it on your
behalf.

**This does not make your instance unsafe.** RLS sits *behind* the
application's own scoping, and every query the server issues is scoped by
organisation regardless. It means you have one safety net rather than two — a
defence-in-depth layer you were told you had. If you want it, create a database
role without `BYPASSRLS`, grant it the schema, and point `DATABASE_URL` at that
role instead of the provider's default one. The server is tested on exactly such
a role: every request runs under its studio's claim, and a role that cannot
bypass sees the same product.

**On a fresh database — before the first boot — it is three lines.** In the
provider's SQL editor (Supabase: SQL Editor; the database is called
`postgres` there):

```sql
CREATE ROLE snagset_app LOGIN PASSWORD '…' NOBYPASSRLS;
GRANT CONNECT ON DATABASE postgres TO snagset_app;
GRANT USAGE, CREATE ON SCHEMA public TO snagset_app;
```

Then put `snagset_app` in `DATABASE_URL` instead of the provider's role. On
Supabase's poolers the user is written with the project reference, exactly as
the provider's own is: `snagset_app.<ref>`. The first boot migrates as that
role, so it owns every table, the forced policies apply to it, and the banner
reports row-level security in force.

**`CREATE` on the schema is not optional**: the migration runner creates its
own bookkeeping table, and without it every boot stops at `permission denied
for schema public`.

**On a database that is already running** there are tables to hand over too.
As the provider's role, after the three lines above:

```sql
REASSIGN OWNED BY <the provider's role> TO snagset_app;
```

**Not on Supabase.** Its `postgres` role owns objects in every schema the
platform ships — `auth`, `storage`, `extensions` — and `REASSIGN OWNED` moves
all of them. Use the object-by-object block below instead, which touches
`public` only.

Check it took, because a reassign that owns nothing succeeds silently:

```sql
SELECT count(*) FROM pg_tables
 WHERE schemaname = 'public' AND tableowner = 'snagset_app';
```

If that is zero, move ownership object by object instead. `REASSIGN OWNED` and
a membership grant both need admin over the provider's role, which a managed
console often withholds. This needs only that your session owns the objects,
that the new role has `CREATE` on the schema, and that your session may act as
it. Creating a role grants admin over it but not that last part, so the moves
fail with `must be able to SET ROLE` until you run:

```sql
GRANT snagset_app TO CURRENT_USER;
```

Then:

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP EXECUTE format('ALTER TABLE public.%I OWNER TO snagset_app', r.tablename); END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP EXECUTE format('ALTER SEQUENCE public.%I OWNER TO snagset_app', r.sequencename); END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public' AND t.typtype = 'e'
  LOOP EXECUTE format('ALTER TYPE public.%I OWNER TO snagset_app', r.typname); END LOOP;
END $$;
```

The enums matter as much as the tables: a migration that adds a value to one
can only be run by its owner.

The same banner reports two quieter versions of the problem: policies that
exist but are not `FORCE`d (which exempts the owner connection), and tables
carrying `org_id` with no policy at all — the second means "re-run migrations".

---

## Backing up, and putting it back

Two things, and **only one of them is the database**.

```bash
pg_dump "$DATABASE_URL" --no-owner --no-acl > snagset-$(date +%F).sql
```

That is everything people wrote: sites, rounds, threads, comments, reviewers.
Restoring it into an empty database is an ordinary `psql` restore and needs no
special step — the migration table comes with it, so the server starts up and
finds nothing to apply.

```bash
psql "$NEW_DATABASE_URL" < snagset-2026-08-27.sql
```

**And the signing key, which is not in the dump.** If you set
`SNAGSET_SECRET_KEY` it is in your `.env`; if you did not, the server generated
one into `.snagset/secret.key` on first boot. Either way it is a separate file
and it is the half people lose.

### What a lost key actually costs

Not the comments — those are plaintext in the database and come back with it.
What goes is everything derived from the key:

| | Restored with the key | Restored without it |
|---|---|---|
| Threads, comments, screenshots | fine | fine |
| Reviewer sessions | keep working | dead; everyone re-opens their link |
| Review links | keep working | must be re-issued |
| Stored bucket credentials | readable | **unreadable ciphertext, permanently** |

The last row is the one that does not recover. It is not a lockout you can
reset your way out of — the plaintext is not anywhere else. Measured, not
assumed: sealing a value under a backed-up key and opening it under a
regenerated one returns nothing at all.

So: back the key up wherever you keep passwords, and **check it is there
before you need it**. A dump you cannot fully use is worse than no dump,
because you will find out at the moment you were counting on it.

## What this costs to run

Postgres, and a bucket if you want screenshots. There is no queue service, no
Redis, no worker process and no third service to sign up for — scheduled work
is a bounded function the server calls on a timer, or a cron request on
serverless.

Deleting the script tag removes the tool from the site completely. Nothing is
left behind. A visitor who is not a reviewer costs one ~300-byte cached check —
"is review open here?" — and nothing else, ever.


## Support

**Community only.** There is no support inbox for self-hosting, no SLA and no
promise of a reply. The source is AGPL-3.0 and the issue tracker is public; that
is the whole of the arrangement, said plainly because it is not the kind of thing
that can be quietly introduced later.

## Run the server next to the database

Every page in the dashboard, and every load of the widget, makes several
database queries. Each one travels between the server and the database, so
the two must be in the same region — on another continent, a page that
should take 50 ms takes a second.

On Vercel, set `regions` in `vercel.json` to the database's region (Vercel
otherwise runs functions in `iad1`, Washington):

| Database region (Neon, Supabase) | `vercel.json` |
|---|---|
| `eu-west-2` London | `"regions": ["lhr1"]` |
| `eu-central-1` Frankfurt | `"regions": ["fra1"]` |
| `eu-west-1` Dublin | `"regions": ["dub1"]` |
| `us-east-1` Virginia | `"regions": ["iad1"]` |
| `us-east-2` Ohio | `"regions": ["cle1"]` |
| `us-west-2` Oregon | `"regions": ["pdx1"]` |
| `ap-southeast-1` Singapore | `"regions": ["sin1"]` |
| `ap-northeast-1` Tokyo | `"regions": ["hnd1"]` |
| `ap-southeast-2` Sydney | `"regions": ["syd1"]` |
| `sa-east-1` São Paulo | `"regions": ["gru1"]` |

The dashboard shows a notice to owners and admins when the two are apart,
naming the region to set. Pick the region itself by where your studio and
most of your clients are: a reviewer far away still waits on the distance to
the server, once per request.

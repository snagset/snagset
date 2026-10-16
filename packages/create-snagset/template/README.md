# __NAME__

A self-hosted [Snagset](https://github.com/snagset/snagset) instance. Click-to-comment
review for your clients' live sites.

## Run it

You need a Postgres and its connection string. A free
[Supabase](https://supabase.com) or [Neon](https://neon.tech) project takes a
minute and works from anywhere; a local `postgres` install is just as good.
On Supabase, use the **session pooler** string for `npm start` and the
**transaction pooler** string on Vercel — the comments in `.env` say which is
which. On Neon, the pooled string.

Put the URL in `.env` as `DATABASE_URL`, then:

```bash
pnpm install
pnpm start
```

<details>
<summary>npm · yarn · bun</summary>

```bash
npm install && npm start
yarn install && yarn start
bun install && bun start
```
</details>

Open http://localhost:8080 and create the first owner. An instance nobody has
claimed shows a setup screen rather than a sign-in form, and **the first person
to fill it in becomes the owner** — so do that before you share the address.

**No Docker anywhere in this project, deliberately.** One less thing to
install, and one less thing between you and a database you can also reach from
your laptop, your CI and your deploy.

## Add a site

Sign in, open **Sites**, and add one. You get a script tag:

```html
<script src="http://localhost:8080/snag.js" data-snag-site="prj_…" defer></script>
```

Paste it into the site you want reviewed, before `</body>`. Or install the npm
package — `pnpm add snagset` — and `snagset.init({ host, site })`, or one of the
framework subpaths: `snagset/react`, `snagset/vue`, `snagset/next`,
`snagset/vite` (which also covers Nuxt and SvelteKit), `snagset/astro`. They
all write the same tag.

**The site's address has to be on the allow-list.** That is the field beside
the name when you add it. A tag on an address that is not listed loads and is
ignored, which is the hardest failure here to spot from the outside.

## Configure

`.env`. Only `DATABASE_URL` is required.

```bash
pnpm run env         # every variable this build accepts, with its default
pnpm run env MAIL    # just the ones matching MAIL

# `run` is not optional here: `pnpm env` is pnpm's OWN command (it manages
# Node versions) and shadows the script. npm and yarn need no `run`.
```

Screenshots need an S3-compatible bucket (DigitalOcean Spaces, R2, MinIO,
AWS). Notifications need a mailer (Resend, or any SMTP). Both are optional:
with no bucket you get annotation mode and the widget says screenshots are
unavailable rather than offering one that fails; with no mailer, notifications
are off and the dashboard says so. `.env` carries a worked example of each,
and both can also be connected later from Studio › General without a restart.

**Row-level security.** Supabase's `postgres` role (and Neon's owner role)
can bypass the policies the server installs, and the boot log says so if
yours does. The app scopes every query itself, so that is a lost second
net rather than a hole; the self-hosting guide has the four-line SQL that
gives you a role without the bypass.

## Deploy it

**Vercel.** `vercel.json` and `api/index.js` are here already. **Set
`regions` in `vercel.json` to the region your database is in** — it says
`iad1` (Washington, Vercel's default) until you do. Functions on another
continent from the database make every page wait on that distance, several
times over. Neon `eu-west-2` or Supabase `eu-west-2` → `lhr1`; `eu-central-1`
→ `fra1`; `us-east-1` → `iad1`; `us-west-2` → `pdx1`; `ap-southeast-1` →
`sin1`; `ap-northeast-1` → `hnd1`; `ap-southeast-2` → `syd1`. The dashboard
says so if they differ. The
`rewrites` entry is load-bearing: without it Vercel's filesystem router serves
only `/api/index` and 404s `/`, `/snag.js` and the cron's own path. Keep the
file free of comment keys — Vercel's schema rejects them. Set `DATABASE_URL`
to the **transaction pooler** string (Supabase from the marketplace sets a
pooled one for you), set `SNAGSET_SECRET_KEY` (required on serverless — the
filesystem is ephemeral, so a generated key would differ per instance and
nothing would decrypt) and `CRON_SECRET`. Vercel does not migrate for you —
after each upgrade, run this here, with the deployment's `DATABASE_URL` in
`.env` (not as Vercel's build command: Vercel fails a build that leaves no
static output):

```
npx snagset migrate
```

If it is forgotten, the dashboard shows a banner on every page until it is run.

**Anything that runs Node.** `pnpm start`. It serves the API, the dashboard and
the widget on one port.

## Upgrading

```bash
pnpm update @snagset/server --latest
```

Then `pnpm start` again, or redeploy. Migrations run on boot; there is no
build step to redo.

`--latest` matters: this project pins `@snagset/server` to an exact version on
purpose (a fresh clone installs the version you last ran), and a plain
`pnpm update` respects the pin — it does nothing. Back up the database before
a version that carries migrations; the release notes name any that cannot
roll back.

## Back up your signing key

If you did not set `SNAGSET_SECRET_KEY`, the server generated one at
`.snagset/secret.key` on first boot. **Treat it as a password.** Without it,
every reviewer session is dead and any stored credential is unreadable
ciphertext.

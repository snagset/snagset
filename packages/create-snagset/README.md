# `create-snagset`

Scaffold a self-hosted **[Snagset](https://github.com/snagset/snagset)** instance
— click-to-comment review for your clients' live sites.

```bash
pnpm create snagset my-review
cd my-review
pnpm install && pnpm start
```

<details>
<summary>npm · yarn · bun</summary>

```bash
npm  create snagset@latest my-review   # then: npm install  && npm start
yarn create snagset my-review          # then: yarn install && yarn start
bun  create snagset my-review          # then: bun install  && bun start
```
</details>

Already in the folder you want it in — a fresh `git init`, say? Pass `.`
instead of a name (`pnpm create snagset .`) and skip the `cd`. A `.git`, a
`.DS_Store` or an editor folder is fine; anything the scaffold would
overwrite is refused.

Bring a Postgres URL — a free Neon or Supabase branch, or a local install — and
put it in `.env` as `DATABASE_URL`. Open `http://localhost:8080` and create the
first owner — an instance nobody has claimed shows a setup screen rather than a
sign-in form, and **the first person to fill it in becomes the owner**, so do
that before you share the address.

**No Docker, on purpose.** No Dockerfile, no compose file, nothing to build:
Snagset is a Node process and a Postgres URL.

## What you get

A directory with everything an instance needs and nothing it does not:

| | |
|---|---|
| `.env` | Configuration. **`DATABASE_URL` is the only required variable** — a signing key is generated into it for you |
| `package.json` | `@snagset/server` as a dependency, with `start`, `migrate` and `env` scripts |
| `vercel.json` + `api/index.js` | Deploy to Vercel instead, if you would rather not run anything |
| `README.md` | The operating manual, written for the instance you just made |

## Then what

Sign in, add a site, and paste the tag it gives you into the site you want
reviewed:

```html
<script src="http://localhost:8080/snag.js" data-snag-site="prj_…" defer></script>
```

Your client opens a review link, clicks the thing that's wrong, and types.
**No account, no extension, no login** — the link is the whole identity. You
get the pin, the screenshot, the console and the route.

Prefer an import? `npm i snagset` gives you the same tag from
`snagset.init({ host, site })`, or the framework subpaths — `snagset/react`,
`snagset/vue`, `snagset/next`, `snagset/vite` (which covers Nuxt and
SvelteKit too), `snagset/astro`.

## What it costs to run

A Node process and a Postgres. Screenshots want an S3-compatible bucket (R2,
Spaces, MinIO, AWS) and notifications want a mailer — **both optional**, and
the product is honest without them: no bucket means annotation mode and the
widget says screenshots are unavailable rather than offering one that fails.

## Back up the signing key

If you did not set `SNAGSET_SECRET_KEY`, one was generated into your `.env`.
**Treat it as a password.** Without it every reviewer session is dead and any
stored credential is unreadable ciphertext.

---

**Early release.** The install path is tested end to end, but this is a `0.0.x`
line: expect the odd rough edge, and pin the version if you need stability.
Issues and notes are welcome at
[snagset/snagset](https://github.com/snagset/snagset).

MIT — the folder it writes is yours. The server it installs,
[`@snagset/server`](https://www.npmjs.com/package/@snagset/server), is
AGPL-3.0-only; the widget you put on a client's site,
[`snagset`](https://www.npmjs.com/package/snagset), is MIT.

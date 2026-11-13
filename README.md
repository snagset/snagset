# Snagset

**Click-to-comment review for client sites.** Your client clicks the thing
that's wrong and types. You get the pin, the screenshot, the route, the browser
and the console errors — on the real site, in their real browser.

Reviewers never sign in: the review link *is* the identity, and it works on
their phone. And it runs on your server — Node and Postgres, your clients'
words in your database.

Documentation: **[snagset.com](https://snagset.com)** (the same pages live in
[`docs/`](docs/)).

## Self-host the server

```bash
npm create snagset@latest my-review
cd my-review
npm install && npm start
```

Put a Postgres URL in `.env` as `DATABASE_URL`, open `http://localhost:8080`
and claim the instance — the first person to fill in the setup screen becomes
the owner. See [Self-hosting](docs/self-hosting.md).

## Add the widget to a site

A script tag, which the dashboard prints for each site:

```html
<script src="https://review.example.com/snag.js" data-snag-site="prj_…" defer></script>
```

Or from npm — `npm i snagset`, then `snagset.init({ host, site })`, or one of
`snagset/react`, `snagset/vue`, `snagset/astro`, `snagset/next`,
`snagset/vite`. All of them write that same tag. See
[Quickstart](docs/quickstart.md).

## Repository layout

| | |
|---|---|
| `apps/server` | `@snagset/server` — API, bin, migrations (AGPL-3.0-only) |
| `apps/dashboard` | the dashboard the server ships (AGPL-3.0-only) |
| `packages/create-snagset` | `npm create snagset` (MIT) |
| `packages/widget-core` | the widget — stub, runtime, panels, capture (MIT) |
| `packages/widget-npm` | `snagset` on npm — the loader and framework subpaths (MIT) |
| `packages/mcp` | `@snagset/mcp` — the agent server (MIT) |
| `packages/types` | the wire contract and name registry (MIT) |
| `packages/adapters` | the outbound sanitiser (MIT) |

## Building and testing

```bash
pnpm install
pnpm typecheck
pnpm build:widget
pnpm test          # unit tests, every package
```

Database-backed tests run when `SNAGSET_TEST_DATABASE_URL` points at a
throwaway Postgres (they drop and recreate the schema), and skip otherwise.

## Licence

The server and dashboard are **AGPL-3.0-only**; the widget, the libraries it
is built from and the `create-snagset` scaffolder are **MIT**. [LICENSE.md](LICENSE.md) explains the
split.

## Where development happens

Development happens in a separate repository; this one receives a clean copy
of each release. Self-hosting is community supported.

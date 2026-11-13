# @snagset/dashboard

The studio dashboard — a Vite + React SPA on shadcn/ui, TanStack Router and
TanStack Query, built into `apps/server/static/dashboard` and served by the
same Hono process as the API.

## Layout

```
src/
  routes/          TanStack file routes; `_app` is the signed-in layout and the auth gate
  components/ui/   shadcn (base-nova preset on Base UI), copied in, themed in index.css
  components/app/  the shell, the gate frame, the parts every screen is composed from
  lib/             api (the typed fetch client), query (client + key factory), theme, auth, labels
  index.css        the tokens mapped onto shadcn's variables; light and dark
```

## Running it

Against a local instance on another port:

```bash
SNAGSET_DEV_API=http://127.0.0.1:8099 pnpm --filter @snagset/dashboard dev
```

The e2e specs in `e2e/dashboard/` drive the BUILT app on a real instance —
`tools/dashboard-e2e-server.mjs` boots one claimed (:8099) and one unclaimed
(:8098) on a throwaway Postgres:

```bash
SNAGSET_TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/snagset_test \
SNAGSET_E2E_ADMIN_URL=postgres://postgres:test@127.0.0.1:54329/postgres \
pnpm exec playwright test --project=dashboard
```

## Two rules from the first day

- A `DropdownMenuLabel` lives inside a `DropdownMenuGroup` or a radio group,
  or Base UI throws at runtime.
- Build with `NODE_ENV=development vite build` to read a Base UI error's text;
  production prints only its number.

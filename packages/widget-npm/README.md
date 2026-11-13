# `snagset`

Click-to-comment review for a live website. Your client clicks the thing that's
wrong and types; you get the pin, the screenshot, the console and the route.

One import, or one script tag. Both do exactly the same thing.

```bash
npm install snagset

# later — a caret on a 0.x version stays inside that minor, so this is how you move up
npm install snagset@latest
```

## Vanilla

```js
import snagset from "snagset";

snagset.init({ host: "https://review.example.com", site: "prj_…" });
```

That is the whole API. `snagset.destroy()` takes it back off; `snagset.tag({…})`
gives you the tag as data if you would rather render it yourself.

## React

```jsx
import Snagset from "snagset/react";

<Snagset host="https://review.example.com" site="prj_…" />
```

## Vue

```vue
<script setup>
import Snagset from "snagset/vue";
</script>

<template>
  <Snagset host="https://review.example.com" site="prj_…" />
</template>
```

## Next.js

```tsx
// app/layout.tsx
import { Snagset } from "snagset/next";

<body>
  {children}
  <Snagset host="https://review.example.com" site="prj_…" />
</body>
```

No `"use client"` — it renders the script tag on the server, so it costs zero
client JavaScript. Leave the props off and it reads `NEXT_PUBLIC_SNAGSET_HOST`
and `NEXT_PUBLIC_SNAGSET_SITE`, so each environment configures itself from
`.env`. Works in the Pages Router too.

## Vite — and Nuxt, SvelteKit, SolidStart, anything on Vite

```ts
// vite.config.ts
import { snagset } from "snagset/vite";

export default defineConfig({
  plugins: [snagset({ host: "https://review.example.com", site: "prj_…" })],
});
```

One line in a file the project already has; the tag is injected before
`</body>`. In Nuxt, put it under `vite: { plugins: […] }` in `nuxt.config`.
Want it only in dev? Use Vite's own idiom:
`mode === "development" ? snagset({…}) : undefined`. Shipping the tag to
production is safe either way — who sees the toolbar is a dashboard setting,
checked by the tag on load, not something baked into your build.

## Astro, Rails — anything that renders a layout

```astro
---
import { snagsetTag } from "snagset/astro";
const tag = snagsetTag({ host: "https://review.example.com", site: "prj_…" });
---
<script src={tag.src} {...tag.attrs} defer is:inline></script>
```

`is:inline` matters — without it Astro bundles the script and rewrites the
`src`, and the widget finds its chunks relative to its own `src`.

## Or no npm at all

```html
<script src="https://review.example.com/snag.js" data-snag-site="prj_…" defer></script>
```

That is what this package writes for you. There is no feature behind the npm
install — if a script tag suits your stack better, use it. It works on
WordPress, Webflow, Shopify and Rails, where a React-only tool cannot go.

## Options

Every `data-snag-*` attribute, as a camelCase key. `host` and `site` are the
only required ones.

| Option | What it does |
|---|---|
| `host` | Your Snagset instance |
| `site` | The project uid, from the dashboard |
| `env` | Which environment this build is — `staging`, `production` |
| `theme` | `light`, `dark`, or leave it to follow the page |
| `lang` | UI language |
| `position` | Where the toolbar sits |
| `hotkey` | Default is `alt+c` |
| `branch`, `build` | Stamped onto every comment, for "which deploy was this?" |

## What this package is

**A loader.** It writes the script tag and nothing else — the widget itself is
served by your Snagset instance, at your instance's version.

That is deliberate. The widget is a lazy chunk graph: about 10 kB loads on
every page and the remaining ~245 kB arrives only if somebody opens the toolbar.
Bundling it here would put all of it into your bundle, and pin a widget version
in your `package.json` that can drift from the server it talks to.

It also means the bytes come from your own origin, so your CSP is one
`script-src 'self'` entry and there is no third party to justify to anyone.

## Requirements

A Snagset instance. It self-hosts on Node and Postgres —
[snagset/snagset](https://github.com/snagset/snagset), or
`npx create-snagset` to scaffold one.

---

**Early release.** This is a `0.0.x` line: the tag it writes is stable and
tested, but expect the odd rough edge, and pin the version if you need
stability. Issues and notes are welcome at
[snagset/snagset](https://github.com/snagset/snagset).

MIT.

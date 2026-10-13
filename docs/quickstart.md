# Quickstart

One `<script>` tag — or one import, which writes that tag for you. No proxy, no
DNS change, no build step. Deleting it deletes the tool.

## Add it

Paste this immediately before `</body>`:

<!-- snagset:quickstart -->
```html
<script src="https://review.example.com/snag.js" data-snag-site="prj_…" defer></script>
```
<!-- /snagset:quickstart -->

Both parts matter, and the dashboard's **Sites** screen prints them filled in:

- **`src`** points at your Snagset instance. The stub finds everything else —
  the lazy chunks, the API — relative to its own `src`, so this is the only
  address you write.
- **`data-snag-site`** says which of your sites a comment belongs to.

There is no third thing. The widget talks to the origin it was served from, so
the `src` is both where the code comes from and where the comments go. Add
`data-snag-host` only if those differ — a CDN install, where the script is
somewhere your API is not.

The toolbar appears on its own — in the bottom corner (following the writing
direction), or as a full-width bar on a touch screen. Nobody needs to know a
shortcut:

- When the dashboard says **review is open** on this site — the "who sees the
  toolbar?" setting on the Sites screen — every visitor sees it. The tag checks
  on load, so flipping the setting needs no re-paste, ever. Right for staging.
- When it says **link holders only**, the toolbar appears for anyone who opens
  a **review link** — and from then on, whenever they come back. Right for
  production, where the other visitors are your client's customers.

**Alt + C** also toggles it anywhere the tag is live — an accelerator for
people who live in keyboards, not the way in.

### If nothing reaches the dashboard

The page's address has to be on that site's allow-list. This is the most common
reason a correct-looking install appears to do nothing: the widget loads, the
toolbar works, comments are written, and every request is refused.

```bash
snagset allow-origin prj_… https://staging.acme.com
```

Or add it beside the site's name on the **Sites** screen.

### Trying it with no server at all

A tag with no `data-snag-site` runs in **local demo mode** — the toolbar works
and comments stay in that browser. Useful for seeing what the widget does; not
useful for a review, because nothing you write reaches anyone.

<!-- snagset:demo -->
```html
<script src="https://review.example.com/snag.js" defer></script>
```
<!-- /snagset:demo -->

### Or from npm

If your site has a build, the same thing as an import:

```bash
pnpm add snagset
```

```js
import snagset from "snagset";

snagset.init({ host: "https://review.example.com", site: "prj_…" });
```

```jsx
// React
import Snagset from "snagset/react";
<Snagset host="https://review.example.com" site="prj_…" />
```

```vue
<!-- Vue -->
<script setup>import Snagset from "snagset/vue";</script>
<template><Snagset host="https://review.example.com" site="prj_…" /></template>
```

```tsx
// Next.js — app/layout.tsx, no "use client": the tag arrives in the HTML
import { Snagset } from "snagset/next";
<Snagset host="https://review.example.com" site="prj_…" />
```

```ts
// vite.config.ts — one line, no component anywhere in the tree
import { snagset } from "snagset/vite";
plugins: [snagset({ host: "https://review.example.com", site: "prj_…" })]
```

The Vite plugin covers everything built on Vite — put it under `vite.plugins`
in `nuxt.config`, or beside `sveltekit()`. `snagset/astro` returns the tag as
data, for Astro or any layout that renders its own `<head>`.

**Nothing is behind the npm install.** The package writes the same tag, and the
widget itself still comes from your instance — so your bundle grows by about a
kilobyte rather than by the whole widget, and the version can never drift from
the server it talks to.

### It needs a server, even a trivial one

Opening an HTML file straight from your disk (`file://`) works in Firefox and
not in Chrome or Safari, and where it does not the console says so once. The
widget fetches its runtime as an ES module, and Chromium and WebKit refuse a
module request from `file:` — their scheme allow-list is `chrome`, `data`,
`http`, `https`. Any static server is enough:

```bash
npx serve .
```

## What a visitor pays for

Nothing they will notice, and — this is the part worth checking rather than
believing — **nothing over the network**. Until somebody presses the chord or a
script calls `Snagset.activate()`, the widget is *dormant*: the stub is parsed,
one keyboard listener is registered, and no further request is made. No DOM node,
no cookie, no storage key.

| State | What has loaded | Network |
|---|---|---|
| Dormant | `snag.js` — about 2 KB gzipped | nothing further |
| Active — pins, toolbar | `snag.runtime.js` | one request, once |
| A panel or *Add* | `snag.panels.js`, `snag.capture.js` | two more, once |

*(Measured, not estimated: those are the three `performance.getEntriesByType("resource")` states a page actually passes through.)*

You can verify the dormant claim yourself in about fifteen seconds: open the page
with devtools on the Network tab, filter for `snag`, and leave it. One request.

## The three states

The toolbar has three, and they mean exactly what they say:

- **Browse** — the site, untouched. No pins, no shield, nothing of ours in the
  way. This is not "pins hidden with CSS"; the nodes are not in the document.
- **Comments** — pins are visible and clickable, and the page still works.
- **Add** — click any element to leave a comment on it.

Press **Esc** to leave *Add*.

## Turning it off

Any one of these is enough, and each is independent of the others:

| How | When to use it |
|---|---|
| `?snag_off=1` on the URL | one page load, e.g. to screenshot the site clean |
| `data-snag-disabled` on the script tag | a whole environment, from the template. **Presence means off** — there is no `="false"`, exactly as HTML's own `disabled` and `hidden` work |
| the `snag_off` cookie | one browser, until it is cleared |
| `data-snag-env="production"` | ship the tag everywhere, arm it nowhere it matters. This is what `data-snag-mode="auto"` means: on production it declines unless somebody says otherwise |
| Remove the tag | permanently — nothing is left behind |

When a gate stops it, the widget says so once, in `console.info`, naming the gate
and the fix. It never warns and never repeats itself.

## Configuring it, if you need to

Every option is an attribute on the same script tag. All are optional.

```html
<script
  src="https://cdn.example.com/snagset/snag.js"
  data-snag-site="prj_your_project"
  data-snag-mode="on"
  data-snag-theme="dark"
  data-snag-hotkey="off"
  defer
></script>
```

| Attribute | Values | Default |
|---|---|---|
| `data-snag-site` | your project id | `local` — comments stay in this browser |
| `data-snag-mode` | `auto` · `on` · `off` | `auto` — dormant until asked, and inert on `data-snag-env="production"` |
| `data-snag-theme` | `auto` · `light` · `dark` | `auto` — follows the OS |
| `data-snag-hotkey` | `off` | on — **Alt** + **C** |
| `data-snag-env` | your environment name | — |
| `data-snag-asset-base` | a URL | inferred from the script's own `src` |

`data-snag-mode="on"` activates without the chord, after the page has finished
loading. Use it on a staging site where everyone visiting is a reviewer; leave it
off on production.

## Driving it from your own code

Most installs never touch this. `window.Snagset` exists on every page the
script is on — including pages where a gate has switched the widget off, so
calling into it is always safe — and it is there for the handful of apps that
need their own trigger, a router we cannot observe, or a deep link. The full
surface is on *Driving it from your own code*.

```js
await Snagset.activate();          // dormant → active
Snagset.setMode("add");            // and straight into add mode
Snagset.on("thread:create", ({ thread }) => track(thread.id));
Snagset.deactivate();              // back to dormant, chunks stay in memory
```

Every event is also dispatched on `document` as `snagset:<name>`, so a page with
no build step can listen without touching the global:

```js
document.addEventListener("snagset:thread:create", (e) => track(e.detail.thread));
```

## Where comments go

Nowhere, at v0 — they stay in this browser's `localStorage`, under keys prefixed
`snag:`. That is a deliberate floor rather than a missing feature: the tool is
useful for a single reviewer working through a page before any of the server
exists. **Export** in the panel's footer writes the whole round out as Markdown or
JSON, across every page it touched, and that is currently the only way a round
leaves the machine it was made on.

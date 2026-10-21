# Driving it from your own code

**You probably do not need this page.** Installing is a script tag and a
couple of `data-*` attributes; the toolbar appears on its own, `Alt + C` opens
it, and a review link works with no code at all. If that covers you, stop
here — the attribute reference is the page you want.

There are four situations where a host app needs to talk to the widget:

- **Your router is one we cannot see.** Memory routers, webviews, custom
  history stacks — `setRoute()` tells us the page changed.
- **Your layout changes in ways no observer catches.** Canvas-driven layout,
  styles written in a rAF loop — `resync()` re-measures.
- **You want your own trigger.** A "Leave feedback" button in your app calling
  `activate()`, instead of the keyboard chord.
- **You want to deep-link to a comment** from your own inbox — `open()`.

Everything else here is reading state and listening to events.

The widget installs itself at `window.Snagset`, on every page the script is on
— **including pages where a kill switch has turned it off**, where every method
is a no-op. Host code never has to guard.

```js
await window.Snagset.activate();
```

## Reading state

| Property | Type | Meaning |
|---|---|---|
| `version` | `string` | Semver of the loaded stub, with the build's content hash as build metadata — `0.1.34+3fa9c1`. Compare releases on the part before the `+`. |
| `state` | `string` | `inert`, `booting`, `dormant`, `degraded`, `active` or `destroyed`. |
| `pointerMode` | `string` | `browse`, `comments` or `add`. Always `browse` unless `state` is `active`. |
| `config` | `object` | The resolved configuration, frozen. |
| `assetBase` | `string` | Where the widget resolves its chunks from. |
| `activated` | `boolean` | Whether the runtime has been mounted. |

`inert` means a kill switch matched — a `data-snag-disabled` attribute, a
`snag_off` parameter, an automation-driven browser. The API is still present
and every method is a no-op, so host code never has to guard.

## Turning it on and off

**`init(config?)`** — merge configuration. Safe before mount, safe to repeat,
and it **never rejects**. Resolves once the widget has left `booting`.

**`activate(opts?)`** — fetch and mount the runtime. Idempotent; concurrent
calls share one fetch. Pass `{ mode: "add" }` to arrive ready to place a pin.

**`deactivate()`** — back to `dormant`. Closes the UI and removes the pins,
keeps the downloaded chunks in memory so re-activating is instant.

**`destroy()`** — full teardown. Idempotent, never throws. The host node and
every listener go; nothing of ours is left in the DOM.

**`setMode(mode)`** — switch between `browse`, `comments` and `add`, activating
first if the widget is dormant.

## Working with comments

**`open(idOrKey)`** — open one thread by its key (`SN-14`) or its id (`thr_…`).
Activates first if dormant. Resolves `{ ok, reason?, url? }`.

**It never navigates your app.** If the thread belongs to another page the
result carries the URL and the decision is yours — a review tool that moves a
user's browser out from under them is one they stop trusting. Deep-linking is
what the host router is for.

**`close()`** — close any open panel or composer, without changing mode.

## Telling the widget about your app

**`setRoute(pattern)`** — for routers we cannot observe: memory routers,
webviews, custom history stacks. Runs the same pipeline an observed navigation
would. Safe before activation — the value is stashed and applied at mount.

**`resync()`** — one re-measure, re-anchor and reposition pass. For layout
changes no observer sees: canvas-driven layout, style written in a rAF loop.
Cheap, and coalesced to a frame, so calling it too often is not a problem.

## Events

```js
const off = Snagset.on("modechange", ({ mode, previous }) => {
  console.log(previous, "→", mode);
});
off(); // or Snagset.off("modechange", fn)
```

**`on(type, fn)`** — subscribe. Returns its own unsubscriber, so a component
can clean up without keeping a reference to the handler.

**`off(type, fn)`** — unsubscribe, for the case where you do have the reference.

Events fire whether or not the runtime has loaded: subscribing at page load and
hearing nothing until a reviewer activates is the intended shape, not a
missed connection.

## What is not here yet

The specification describes more than this — `identify()` for signed-in
reviewers, `getThreads()`, metadata methods, a manual `mount()`. They are
**not implemented**, and this page lists only what the shipped build actually
exposes. A test fails the build if the two ever disagree.

// snag.js — the stub. The tax every visitor to a client's site pays, so it stays
// vanilla, dependency-free and tiny (≤ 8 KB gz). Its whole job: read the script-tag
// config, decide whether this visitor is a reviewer, and either lazily fetch the
// runtime or get out of the way.
//
// The lazy boundary is the point of this file. The runtime is
// reached ONLY through a dynamic `import()` of a resolved URL, so a non-reviewer
// never downloads it. That import is deliberately opaque to the bundler
// (@vite-ignore): the URL is computed at runtime from the asset base, because the
// widget is served from the operator's own origin, not a build-time constant.
import {
  GLOBALS,
  ARTIFACT,
  DOM_EVENT_PREFIX,
  PRODUCT,
  SYMBOL_KEY,
  param,
  scriptAttr,
  type ScriptAttr,
} from "@snagset/types/names";
import { blockedReason, type Config, type ConfigGlobal } from "./loader/policy.ts";
// Its own module so that `loader.ts` EXPORTS NOTHING. Vite's IIFE build needs a
// name, and Rollup only assigns that name to a global when the entry has
// exports — so one export purely for a unit test put `__snagset_stub__` on
// every client's window, which the design forbids and `verify-dist` checks.
import { inferHost } from "./loader/infer-host.ts";
// The ONE storage module the stub may import: a synchronous localStorage read
// behind its own try/catch, no dependencies. It is what lets the boot decision
// stay local — "has this person reviewed here before" without asking a server.
import { holderId } from "./storage/identity.ts";
import { installEarly, type EarlyCrumbs } from "./loader/crumbs-early.ts";
import type { Emit, Listener, Mode, Phase, RuntimeModule, SnagsetApi } from "./api.ts";
import type { RuntimeMount } from "./runtime/index.ts";
import { VERSION } from "./build.ts";

/**
 * Taken at load, once, before anything else can run. Held in
 * a module-scope binding and handed to the runtime at mount; never written to
 * storage, and cleared by the adapter after its single use.
 */
const REVIEW_TOKEN = takeReviewToken();

/**
 * `#snag_k` — read once, stripped immediately, held in memory only.
 *
 * And both specify this, and each clause is load-bearing:
 *
 *  - **The fragment, not a query parameter.** Fragments are never sent to the
 *    server, so the token does not reach access logs, does not leak via
 *    `Referer`, and is absent from most analytics captures. A secret in a
 *    query string is a secret in your CDN logs.
 *  - **Stripped BEFORE the redemption request**, so an in-flight failure
 *    cannot leave the secret sitting in the address bar for a screenshot.
 *  - **`history.state` PRESERVED.** Draft 2 wrote `replaceState(null, …)`,
 *    which discards the host application's router state — a router keeping
 *    scroll position or a wizard step loses it the moment a reviewer opens a
 *    link.
 *  - **Only the `snag_k` pair is removed.** A hash router's own fragment
 *    (`#/products/1`) has to survive byte-identical, or opening a review link
 *    navigates the host app.
 *  - **Never persisted.** It is returned to the caller and stored nowhere;
 *    after the session's absolute cap the reviewer re-opens their link, which
 *    the design takes deliberately over leaving a long-lived bearer in web
 *    storage.
 */
function takeReviewToken(): string | undefined {
  try {
    const hash = location.hash.slice(1);
    if (!hash.includes(param("k"))) return undefined;
    const parts = new URLSearchParams(hash);
    const token = parts.get(param("k")) ?? undefined;
    if (!token) return undefined;

    parts.delete(param("k"));
    const rest = parts.toString();
    // A hash router's fragment is not a parameter list; if nothing else was in
    // there, the hash goes entirely rather than becoming a bare "#".
    const url = location.pathname + location.search + (rest ? `#${rest}` : "");
    history.replaceState(history.state, "", url);
    return token;
  } catch {
    // A sandboxed iframe can refuse `replaceState`. Better a working widget
    // with a visible token than no widget — and the token is single-use.
    return undefined;
  }
}

const CONFIG_ATTRS: ScriptAttr[] = [
  "site", "host", "disabled", "env", "mode", "hotkey",
  "allowAutomation", "assetBase", "theme", "autoMount",
  // `storage` was registered .3 and read by nobody: the one attribute
  // that decides whether a comment reaches a server was silently dropped
  // between the script tag and the runtime.
  "storage",
];

/**
 * The precedence ladder: defaults < CONFIG GLOBAL < attributes < URL <
 * cookie. The second rung did not exist — `window.SnagsetConfig` was a
 * registered name with zero consumers, which is the strongest tell
 * there is that something was never built.
 *
 * The design names the case it serves: "WordPress optimiser plugins that rewrite
 * tags, template engines that strip unknown attributes". A host in that
 * position cannot configure the widget through the tag at all, and the global
 * is the documented answer.
 *
 * String-valued keys are merged into the attribute config so the precedence
 * ladder is one object; booleans, arrays and functions are NOT, because they
 * are read as policy rather than as configuration — `disabled: true` is
 * `enabled` is row 9 and `allowedOrigins` is row 10, and stringifying
 * any of them would turn a gate into the string "true".
 */
function readConfigGlobal(w: Record<string, unknown>): ConfigGlobal | undefined {
  const g = w[GLOBALS.config];
  return g && typeof g === "object" ? (g as ConfigGlobal) : undefined;
}

function readConfig(el: HTMLScriptElement | null, global?: ConfigGlobal): Config {
  const cfg: Config = {};
  for (const name of CONFIG_ATTRS) {
    // Layer 2 first so layer 3 overwrites it — the ladder's whole point.
    const g = global?.[name];
    if (typeof g === "string" || typeof g === "number") cfg[name] = String(g);
    const v = el?.getAttribute(scriptAttr(name));
    if (v !== null && v !== undefined) cfg[name] = v;
  }
  return cfg;
}

/**
 * Where the sibling chunks live. Precedence: explicit attribute → explicit global
 * → the stub's own <script src>. The last one is what makes the zero-attribute
 * paste snippet work: the stub resolves its own runtime with nothing configured.
 */
/** Every chunk URL carries this build's id, so a release renames it. */
function chunkUrl(file: string, base: string): string {
  const u = new URL(file, base);
  u.searchParams.set("cv", VERSION);
  return u.href;
}

function resolveAssetBase(cfg: Config, el: HTMLScriptElement | null): string {
  const explicit = cfg.assetBase ?? (window as unknown as Record<string, string | undefined>)[GLOBALS.assetBase];
  if (explicit) return new URL(explicit, location.href).href.replace(/\/?$/, "/");
  const src = el?.src;
  if (src) return new URL(".", src).href;
  return new URL(".", location.href).href;
}

/**
 * The event bus behind `on`/`off` — and the `snagset:*` DOM events beside it.
 *
 * Every event is ALSO dispatched as a `CustomEvent` on `document`,
 * "so a host page with no bundler can listen without touching window.Snagset".
 * That is the whole reason the mirror exists, and it is why it is one line here
 * rather than an opt-in: a marketing site with a `<script>` tag and no build
 * step is the exact deployment this product is for.
 *
 * `bubbles: false, composed: false` — a document-level event has nowhere to
 * bubble to, and composing it would let it escape into a host's own shadow
 * roots, which is the opposite of what our isolation is for.
 *
 * A throwing listener is contained. The design is absolute — "the widget never throws
 * into host code" — and a host's broken analytics handler must not take the
 * remaining listeners, or the emitting call, down with it.
 */
function makeBus(): { on: SnagsetApi["on"]; off: SnagsetApi["off"]; emit: Emit } {
  const map = new Map<string, Set<Listener>>();
  const off: SnagsetApi["off"] = (type, fn) => void map.get(type)?.delete(fn);
  return {
    on(type, fn) {
      let set = map.get(type);
      if (!set) map.set(type, (set = new Set()));
      set.add(fn);
      return () => off(type, fn);
    },
    off,
    emit(type, payload) {
      const set = map.get(type);
      if (set) {
        for (const fn of [...set]) {
          try {
            fn(payload);
          } catch (err) {
            console.error(`[${PRODUCT}] listener for "${type}" threw`, err);
          }
        }
      }
      document.dispatchEvent(
        new CustomEvent(`${DOM_EVENT_PREFIX}${type}`, {
          detail: payload,
          bubbles: false,
          composed: false,
        }),
      );
    },
  };
}

/**
 * The API a GATED page gets.
 *
 * "A no-op global whose every method is a warn-once stub." It has to be
 * installed — a host that calls `Snagset.activate()` should get an explanation
 * rather than a TypeError — but it must not be able to fetch anything, which is
 * exactly what the live API was doing here: the real object was installed
 * BEFORE the gate ran, so every kill switch could be walked straight through by
 * anything that called activate(). Each of the rows applied alone is
 * supposed to yield `inert`; none of them did.
 */
function inertApi(cfg: Config, assetBase: string, gate: string): SnagsetApi {
  let warned = false;
  const warn = (): void => {
    if (warned) return;
    warned = true;
    console.info(`[${PRODUCT}] not activated: ${gate}`);
  };
  // The bus is REAL here, not stubbed. The design says `on`/`off` work in `inert`
  // and simply never fire — a host that subscribes at page load and is then
  // gated must get an unsubscribe function back, not undefined, or its own
  // teardown throws on a page it was never running on.
  const bus = makeBus();
  const api: SnagsetApi = {
    version: VERSION,
    config: cfg,
    assetBase,
    state: "inert",
    pointerMode: "browse",
    activated: false,
    // Init in `inert` is a warn-once no-op that still RESOLVES
    // "resolving with state === 'inert' is a legitimate outcome". A host that
    // awaits it on a killed page must not hang forever.
    init: () => (warn(), Promise.resolve(api)),
    activate: () => (warn(), Promise.resolve(null)),
    deactivate: () => {},
    destroy: () => {},
    setMode: warn,
    setRoute: warn,
    // The open row: `{ok:false, reason:'inert'}` — resolved, never thrown.
    open: () => (warn(), Promise.resolve({ ok: false as const, reason: "inert" as const })),
    resync: () => {},
    close: () => {},
    on: bus.on,
    off: bus.off,
  };
  return api;
}

/**
 * `requestIdleCallback`, or the closest thing the browser has.
 *
 * Still absent from stable Safari, so the design requires this shim and forbids
 * the bare identifier anywhere else in the codebase — a CI lint enforces it,
 * because the failure mode is silent: on Safari the callback simply never runs
 * and the widget never mounts.
 */
function whenIdle(run: () => void): void {
  const ric = (window as unknown as Record<string, unknown>).requestIdleCallback;
  if (typeof ric === "function") (ric as (cb: () => void, o: object) => void)(run, { timeout: 2000 });
  else setTimeout(run, 1);
}

/**
 * The mount gate: "Nothing DOM-related happens before this resolves."
 *
 * load → two animation frames → idle. The two frames are not superstition: one
 * gets past the load handlers a host framework registers, the second past the
 * layout they cause. Going earlier is what re-opens the React/Next hydration
 * mismatch exists to close.
 */
function whenMountable(run: () => void): void {
  if (document.readyState === "complete") {
    whenIdle(run);
    return;
  }
  window.addEventListener(
    "load",
    () => requestAnimationFrame(() => requestAnimationFrame(() => whenIdle(run))),
    { once: true },
  );
}

/**
 * The chord — "the one listener a dormant widget owns".
 *
 * Alt+C, and it is what makes `dormant` reachable at all: with `mode` unset
 * there was previously NO way to activate, because the toolbar lives in the
 * runtime and the runtime is what has not been fetched yet
 * Capture phase, so a host page that swallows keydown
 * cannot take the only entrance away.
 *
 * One listener, no DOM, no storage — the dormant budget is zero network and
 * this spends none of it.
 *
 * ── IT ALSO CYCLES THE MODE ONCE ACTIVE, AND THAT IS NOT A LUXURY ──
 *
 * The table .2 lists `Alt+C` beside the toolbar `+` in both directions
 * `comments|browse → add` and `add → comments` — at v0. Only the activation
 * half was built, so on an already-active widget the chord did nothing.
 *
 * What that cost is bigger than a missing shortcut, and dogfooding found it: an
 * open `popover="auto"` LIGHT-DISMISSES when you press the pointer anywhere
 * outside it, and our toolbar is outside it. So a reviewer who opened a menu,
 * a combobox or a tooltip and then reached for `+` to comment on it watched it
 * vanish under their cursor. Entering `add` first does not help either — in
 * `add` we cancel host clicks, so the control that opens the popover no longer
 * opens it.
 *
 * There is no way to suppress light dismiss from script. It is engine-internal:
 * measured, `preventDefault()` in a capture-phase `pointerdown` listener does
 * NOT stop it, and re-showing the popover afterwards would mean calling a
 * method on a host element and firing a close/open pair through the host app's
 * own `toggle` handlers — which A3 and A5 forbid for good reason.
 *
 * A KEY PRESS DISPATCHES NO POINTER EVENT. So the chord is not a convenience
 * here, it is the only way to comment on a popover at all: open it with the
 * mouse, press Alt+C, click inside it. Verified end to end in e2e/overlays.spec.
 */
function armHotkey(api: SnagsetApi, cfg: Config, signal: AbortSignal): void {
  if (cfg.hotkey === "off") return;
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      // `code` rather than `key`: Alt+C produces "ç" on a US Mac layout, and
      // keying on the character means the chord works on some keyboards and
      // not others.
      if (e.code !== "KeyC") return;
      e.preventDefault();

      // Already up: cycle the mode instead of re-activating.
      // `add → comments`, never `add → browse`: you were adding comments, so
      // you land where the comments are — the own note on that row.
      if (api.state === "active") {
        api.setMode(api.pointerMode === "add" ? "comments" : "add");
        return;
      }

      // CAUGHT, not just voided. `activate()` rejects when a chunk cannot be
      // fetched, and a bare `void` on a rejecting promise is an unhandled
      // rejection — which lands in the host's own error reporting as if their
      // page had thrown. The design is absolute that we never throw into host code,
      // and an unhandled rejection is how that promise gets broken quietly.
      // The failure is already a console.error and an `error` event; there is
      // nothing further to say and nobody left to say it to.
      void api.activate().catch(() => {});
    },
    // `{ signal }` is not optional here: The design makes it mandatory for
    // every listener and tears them all down through one
    // AbortController. Without it this survived `destroy()` — and it is a
    // CAPTURE-phase handler that calls preventDefault() before it discovers the
    // widget is gone, so a host page with its own Alt+C shortcut kept losing it
    // to a widget that was supposed to have removed itself.
    { capture: true, signal },
  );
}

function makeApi(
  cfg: Config,
  assetBase: string,
  /** Every listener the stub owns, so `destroy()` can take them all. */
  listeners: AbortController,
  early?: EarlyCrumbs,
): SnagsetApi & { signal: AbortSignal } {
  let pending: Promise<RuntimeMount> | null = null;
  let pendingRoute: string | null | undefined;
  let phase: Phase = "dormant";
  let rt: RuntimeMount | null = null;
  let resyncPending = 0;
  const bus = makeBus();

  const api: SnagsetApi = {
    version: VERSION,
    config: cfg,
    assetBase,
    get state() {
      return phase;
    },
    // "'browse' unless state === 'active'". Read THROUGH the runtime
    // rather than mirrored into a field here — a copy of somebody else's state
    // is a copy that goes stale the first time they change it without telling
    // you, and the toolbar changes mode without going through this object.
    get pointerMode() {
      return phase === "active" && rt ? rt.getState() : "browse";
    },
    activated: false,

    // Merge, never replace: `init` is documented as safe to call repeatedly, and
    // a second call carrying one key must not blank the other nine.
    init(next) {
      if (next) Object.assign(cfg, next);
      return pending ? pending.then(() => api, () => api) : Promise.resolve(api);
    },

    activate(opts) {
      if (phase === "destroyed") return Promise.resolve(null);
      // ALREADY MOUNTED, MERELY DORMANT. `deactivate()` leaves the chunks in
      // memory by design, so `pending` still holds a resolved promise
      // and the `if (!pending)` short-circuit returned it unchanged — the
      // `.then` that sets `phase = "active"` never ran again. The API then
      // reported `dormant` for the rest of the page's life, `pointerMode`
      // returned "browse" whatever the toolbar was showing, and `resync()` and
      // `deactivate()` became no-ops because both gate on the phase.
      if (rt && phase !== "active") {
        phase = "active";
        bus.emit("activated", { mode: rt.getState() });
      }
      if (!pending) {
        /**
         * The `?cv=` cache-buster, on BOTH chunk URLs.
         *
         * `VERSION` is this build's id, `<release>+<content hash>`
         * (scripts/build-id.mjs). It was the literal "0.0.0" until a reviewer
         * kept running the previous release after a deploy: a buster that
         * never changes busts nothing. Now every build names its chunks
         * differently, the server caches a chunk immutable ONLY under the
         * current id, and an old id is answered `no-store` — so R7's skew
         * (an old `snag.js` against fresh chunks) can no longer be pinned into
         * a cache, at the edge or in the browser.
         *
         * It is an ASSET-URL parameter and explicitly not a page one, so
         * does not govern it and it is not in the registry.
         */
        const url = chunkUrl(ARTIFACT.runtime, assetBase);
        // The lazy boundary. @vite-ignore keeps the URL runtime-resolved so the
        // bundler neither inlines the runtime into the stub nor rewrites the path.
        pending = (import(/* @vite-ignore */ url) as Promise<RuntimeModule>)
          .then((m) => {
            // DESTROYED WHILE THE CHUNK WAS IN FLIGHT. `destroy()` can do
            // nothing about an import already started, so the check belongs
            // here: without it the mount landed AFTER teardown — a fresh
            // `[data-snag-root]` appended to a page the host had just cleaned
            // up, `ready` and `activated` emitted after `destroyed`, and the
            // widget alive again with `state` still reading "destroyed".
            // `Snagset.activate(); Snagset.destroy();` with no await is the
            // ordinary case, not a contrived one: it is the chord path, and it
            // is any host tearing down on a route change.
            if (phase === "destroyed") return null as never;
            api.activated = true;
            phase = "active";
            rt = m.mount(undefined, {
              assetBase,
              config: cfg,
              emit: bus.emit,
              // The Tier A/B backlog — the runtime seeds its real
              // buffer from it, redacting on the way in.
              ...(early ? { early } : {}),
              // In memory, once. Not in `config`: that is a string map derived
              // from attributes and the URL, and a credential does not belong
              // in the same bag as a theme preference.
              ...(REVIEW_TOKEN ? { reviewToken: REVIEW_TOKEN } : {}),
            });
            if (pendingRoute !== undefined) rt.setRoute(pendingRoute);
            bus.emit("ready", { version: VERSION, state: phase });
            bus.emit("activated", { mode: rt.getState() });
            return rt;
          })
          .catch((err: unknown) => {
            pending = null;
            console.error(`[${PRODUCT}] runtime failed to load from ${url}`, err);
            // Internal failures become `error` events, and this one is
            // the difference between "the widget is broken" and "the chunk 404s
            // behind your CDN rule" for whoever is reading the host's logs.
            bus.emit("error", { code: "runtime-load-failed", message: url, cause: err });
            throw err;
          });
      }
      // Applied AFTER the mount resolves, not before — the runtime it is meant
      // to configure does not exist yet on the first call.
      return opts?.mode
        ? pending.then((m) => (rt?.setState(opts.mode!), m))
        : pending;
    },

    // "Closes UI, persists drafts, detaches pins, keeps the host node and the
    // loaded chunks in memory". `browse` IS the pins-detached state in
    // the table, and drafts already live outside the components that render
    // them, so both fall out of closing the panel and dropping to browse.
    deactivate() {
      if (phase !== "active" || !rt) return;
      rt.closePanel();
      rt.setState("browse");
      phase = "dormant";
      bus.emit("deactivated", {});
    },

    destroy() {
      if (phase === "destroyed") return;
      listeners.abort();
      if (resyncPending) cancelAnimationFrame(resyncPending);
      resyncPending = 0;
      try {
        rt?.destroy();
      } catch (err) {
        // Idempotent, never throws. A teardown that throws leaves the
        // host with a half-removed widget and no way to finish removing it.
        console.error(`[${PRODUCT}] destroy failed`, err);
      }
      rt = null;
      pending = null;
      phase = "destroyed";
      api.activated = false;
      bus.emit("destroyed", {});
    },

    // "implicitly activate()s" from dormant. Anything else means a host
    // calling the one method whose name says "put the widget in this mode" gets
    // silence on the state where it is most likely to be called.
    setMode(mode) {
      if (phase === "destroyed") return;
      if (phase === "active" && rt) {
        rt.setState(mode);
        return;
      }
      void api.activate({ mode }).catch(() => {});
    },

    // Stash-then-apply: the override is meaningful before the runtime exists
    // (a host wires its router hook at page load), so it waits here and lands
    // in the same breath as the mount.
    setRoute(pattern) {
      pendingRoute = pattern;
      rt?.setRoute(pattern);
    },

    // Dormant activates first — the row says so — and the
    // runtime does the resolving; the stub never learns what a key means.
    async open(idOrKey) {
      if (phase === "destroyed") return { ok: false, reason: "inert" };
      const m = await api.activate();
      if (!m) return { ok: false, reason: "inert" };
      return rt!.open(idOrKey);
    },

    /**
     * "Cheap and safe to call; COALESCED TO ONE FRAME."
     *
     * The comment here used to claim the coalescing was the runtime's, and it
     * is not: `refresh()` reads the whole thread store, re-anchors every pin,
     * emits one `anchor:settled` each and writes back the ones that moved, with
     * nothing debouncing it. The host pattern documents this method FOR
     * "manual style writes in a rAF loop" — would therefore call it sixty times
     * a second and get sixty full passes. One frame, one pass.
     */
    resync() {
      if (phase !== "active" || resyncPending) return;
      resyncPending = requestAnimationFrame(() => {
        resyncPending = 0;
        void rt?.refresh();
      });
    },

    close() {
      rt?.closePanel();
    },

    on: bus.on,
    off: bus.off,
  };
  // The signal is the stub's own business — every listener it owns is tied to
  // it, and `destroy()` aborts it. Deliberately NOT on the public contract
  // (does not list it), so it rides alongside rather than inside.
  return Object.assign(api, { signal: listeners.signal });
}

/**
 * The stub's own cost, on the performance timeline.
 *
 * `snagset:`, NOT `snag:`. The storage prefix exists so the inertness test can
 * filter web-storage keys by it — and spells out why a performance
 * entry sharing that prefix re-creates the same defect one layer up: the stub
 * would assert "zero storage keys" while emitting `snag:`-prefixed entries, and
 * a prefix-filtered assertion cannot tell the two apart. Same registered
 * namespace in a second position, exactly as `data-snag-theme` is reused on our
 * own host element.
 *
 * Emitted only when the stub ACTIVATES. The design requires an inert
 * production page to emit zero performance entries, and needs the stub's
 * cost measurable — so the start is a plain `performance.now()` and the entry
 * is created on the activating path alone. Neither criterion is traded for the
 * other, which is what nearly happened.
 */
const PERF = `${DOM_EVENT_PREFIX}stub-init`;

function boot(): void {
  // The SSR guard. This module must have ZERO top-level side
  // effects that touch the DOM, or importing it in Node, Deno or a Worker
  // throws before it can explain itself. It is the first line for a reason.
  if (typeof document === "undefined" || typeof window === "undefined") return;

  // A plain `performance.now()`, NOT a mark — because a mark IS an entry, and
  // the design requires an inert production page to emit ZERO performance
  // entries. Marking at boot and measuring later would satisfy by
  // breaking that, which is the kind of trade nobody notices until the two
  // criteria are checked by the same job.
  const t0 = performance.now();
  const el = document.currentScript as HTMLScriptElement | null;
  const w = window as unknown as Record<string, unknown>;
  const configGlobal = readConfigGlobal(w);
  const cfg = readConfig(el, configGlobal);
  const assetBase = resolveAssetBase(cfg, el);
  inferHost(cfg, el?.src);

  /**
   * THE GATE RUNS BEFORE THE API IS INSTALLED.
   *
   * It used to run after, so on a page that had switched us off `window.Snagset`
   * was the LIVE object and anything calling `activate()` fetched the runtime
   * anyway. Every one of the kill switches could be walked straight
   * through; requires each of them applied alone to yield `inert`, and
   * requires the global to expose "nothing beyond the warn-once stub".
   */
  // `document.cookie` THROWS SecurityError in an opaque origin — a sandboxed
  // iframe with allow-scripts and not allow-same-origin, which is the shape a
  // CMS preview pane commonly uses and exactly the framed case F12 says we
  // should still boot in. Unguarded, it took `boot()` down before the global
  // was installed: no widget, and a SecurityError in the host's error
  // reporting, which the design forbids absolutely.
  let cookie = "";
  try {
    cookie = document.cookie;
  } catch {
    /* opaque origin — no cookies to read, and no cookie gate can have been set */
  }

  /**
   * IN REVIEW — the boot decision the maintainer's model turns on, decided from LOCAL
   * information only.
   *
   * "Installed on the domain should show all the time, no Alt+C" is right
   * about the audience: a client will never learn a keyboard shortcut. The
   * naive implementation asks the server "is this page registered?" on every
   * load — which would cost every stranger a network request and break the
   * zero-requests-while-dormant, the measured 7× advantage over the
   * bundled-eager competitor. The stub does not need to ask: the tag says who
   * this deployment is for (`mode="on"`, printed by the dashboard's "everyone
   * on these addresses" choice), the URL says whether a link was opened, and
   * localStorage says whether this person has reviewed here before. All three
   * are free.
   */
  const returning = cfg.site ? Boolean(holderId(cfg.site)) : false;

  const blocked = blockedReason({
    config: cfg,
    search: location.search,
    cookie,
    webdriver: navigator.webdriver,
    globals: w,
    inReview: Boolean(REVIEW_TOKEN) || returning,
    // Spread rather than `: undefined` — `exactOptionalPropertyTypes` treats
    // "absent" and "present but undefined" as different things, and most pages
    // have no config global at all.
    ...(configGlobal ? { configGlobal } : {}),
    origin: location.origin,
  });

  /**
   * WHOSE GLOBAL IS THAT? — the table, which had collapsed into one row.
   *
   * `w[GLOBALS.api] !== undefined` was treated as "a host owns it", so a SECOND
   * COPY OF OUR OWN STUB — two script tags, or a framework wrapper beside a
   * hand-pasted snippet (F5, v0) — installed a fully live second instance
   * at the fallback global and armed a second capture-phase Alt+C listener. One
   * press then activated both, and two runtimes mounted two hosts onto the same
   * page.
   *
   * The BRAND is what tells the two apart. It is a cross-realm registered
   * symbol, so it is visible to anything that looks — which is the point: the
   * second copy has to be able to recognise the first.
   *
   * The rationale for FIRST WINS is worth keeping in sight, because the
   * instinct is the other way round: "the already-booted instance may hold an
   * open composer with unsaved text; silently destroying it to install a newer
   * build loses user data."
   */
  const BRAND = Symbol.for(SYMBOL_KEY.instance);
  const existing = w[GLOBALS.api] as (Record<symbol, unknown> & SnagsetApi) | undefined;

  if (existing?.[BRAND]) {
    // First wins. Record the duplicate and install NOTHING — no global, no
    // hotkey, no auto-mount. Types `__duplicates` as diagnostics-only.
    const dupes = ((existing as unknown as { __duplicates?: unknown[] }).__duplicates ??= []);
    dupes.push({ version: VERSION, src: el?.src ?? "" });
    console.warn(
      `[${PRODUCT}] a second copy of the script is on this page and was ignored; ` +
        `the first one is running. See window.${GLOBALS.api}.__duplicates.`,
    );
    return;
  }

  const target = existing === undefined ? GLOBALS.api : GLOBALS.collisionFallback;
  if (target === GLOBALS.collisionFallback) {
    // A FOREIGN global — somebody else's `Snagset`. Leave it alone entirely and
    // install beside it; the dunder marks the fallback as not-public-API.
    console.warn(`[${PRODUCT}] window.${GLOBALS.api} is taken; installing at window.${GLOBALS.collisionFallback}.`);
  }

  if (blocked) {
    const inert = inertApi(cfg, assetBase, blocked.gate);
    // Branded too: a gated page still owns the global, and a second copy must
    // recognise it as ours rather than install a live instance beside it.
    (inert as unknown as Record<symbol, unknown>)[BRAND] = true;
    w[target] = inert;
    // Deliberately NO measure on this path: an inert page emits nothing at all,
    // not even a timing entry.
    // NO SILENT INERT. The design fixes the shape:
    //   [Snagset] not activated: <gate> — <one-line fix>
    // One line, `info` and never `warn` — a widget that logs a
    // warning on a page that deliberately opted out is noise in someone else's
    // console. This is the single carved-out exception to the silence rule,
    // and names it as such.
    //
    // The prefix is composed, never typed: The design forbids a literal product
    // name anywhere under src/, which is what keeps a rename to minutes.
    if (!blocked.silent) {
      console.info(`[${PRODUCT}] not activated: ${blocked.gate} — ${blocked.fix}`);
    }
    return;
  }

  /**
   * Tier A + B breadcrumbs — installed HERE, on the ungated path
   * only. A page that opted out via any kill switch is `inert` and gets no
   * listeners and no wrapped console; a DORMANT page gets both, because the
   * whole point of the early tiers is the evidence that exists only before
   * activation — hydration errors do not wait for a reviewer.
   *
   * Config comes off the CONFIG GLOBAL alone for now: The design owns the shape
   * (`breadcrumbs: false` kills all tiers, `breadcrumbs.early: false` kills
   * Tier B), and 04 names no script-tag attribute — spellings are the, and
   * 06 registers none for this yet.
   */
  // The one AbortController every stub-owned listener ties to
  // — created here rather than in makeApi so Tier A can use the same signal.
  const listeners = new AbortController();
  const bc = configGlobal?.breadcrumbs;
  const early =
    bc === false
      ? undefined
      : installEarly(
          window,
          { early: (bc as { early?: unknown } | undefined)?.early !== false },
          listeners.signal,
        );

  const api = makeApi(cfg, assetBase, listeners, early);
  // The brand goes on before the global is published, so a second copy racing
  // us in the same task cannot see an unbranded instance.
  (api as unknown as Record<symbol, unknown>)[BRAND] = true;
  w[target] = api;
  measure(t0); // the stub's own work ends here; the import is the runtime's cost

  /**
   * DORMANT. This is the whole product claim, and until now it did not exist:
   * `boot()` ended by calling `activate()` unconditionally, so every visitor to
   * a client's production site downloaded `snag.runtime.js`. Marks zero
   * network requests while dormant NON-NEGOTIABLE and traces a dormant
   * page for 30 seconds to prove it. A script-injected tool that fetches its
   * whole runtime for everyone has given away the one thing it has over a proxy.
   *
   * `mode` is the trigger and the design fixes its polarity: `auto` — the default
   * boots to dormant; only `on` activates by itself. The old
   * `data-snag-auto-mount="false"` opt-OUT had it exactly backwards.
   *
   * Even `on` waits for the mount gate. Activating at script-parse time is what
   * produced the React/Next hydration mismatches the design is written against.
   */
  armHotkey(api, cfg, api.signal);
  // A ?snag_t permalink is an activation trigger — its
  // presence forces `comments` even in mode:"auto", because the link IS the
  // request to read. This runs after the kill-switch gate returned above, so
  // ?snag_off=1&snag_t=… stays inert: the owner's off switch wins.
  const permalinked = new URLSearchParams(location.search).has(param("t"));
  /**
   * FOUR triggers now, and two of them are the bug this block carried
   * `REVIEW_TOKEN` was captured for the session exchange, STRIPPED from
   * the URL, and activated nothing — so the product's primary path, "send your
   * client a review link", opened a page that booted dormant, consumed the
   * single-use token, and showed a blank site. And `returning` is why nobody
   * needs the link twice: a holder identity only exists after a successful
   * exchange, so its presence means this person has reviewed here before and
   * the toolbar simply appears. Alt+C survives as an accelerator, not the way
   * in.
   */
  if (
    (cfg.mode === "on" || permalinked || Boolean(REVIEW_TOKEN) || returning) &&
    cfg.autoMount !== "false"
  ) {
    whenMountable(() => void api.activate().catch(() => {}));
  } else if (cfg.site && cfg.host && cfg.mode !== "off" && cfg.autoMount !== "false") {
    /**
     * THE DASHBOARD DECIDES, and the maintainer's actual model: *"it should just
     * be checking the url and if matches then it should be on."*
     *
     * First put this control in the TAG (`mode="on"`), which had a flaw
     * the byte-counting missed: changing who sees the toolbar meant editing
     * the client's codebase again. The dashboard's setting has to work AFTER
     * the paste, forever — so the stub asks the instance.
     *
     * One request, ~300 bytes, `Cache-Control: max-age=60`, fired only when
     * the tag names a site (a site-less demo tag still fetches nothing — that
     * claim survives, scoped). `writeMode` is the answer because it already
     * means the right thing: who can WRITE is who the toolbar is for, and
     * showing a comment bar to somebody whose comments would be refused is a
     * form the product fills in and then tears up. The server sends the
     * EFFECTIVE mode, so the 24-hour grace closes the toolbar with the
     * window unless the owner chose "everyone" deliberately.
     *
     * Every failure lands on dormant: an instance that is down, blocked or
     * misconfigured must degrade to the widget's resting state, never to a
     * toolbar that cannot talk or an error on somebody else's page.
     *
     * `writable` is the same rule from the other side: the
     * server judges THIS page's origin against the allow-list — the browser
     * already names its origin on every cross-origin fetch, so nothing new is
     * sent — and a copy of the page living anywhere else (an archive.org
     * snapshot, a mirrored staging) reads `writable: false` and stays
     * dormant. Checked as `!== false`, not `=== true`, so a server from
     * before the field existed keeps working.
     */
    void fetch(`${cfg.host.replace(/\/+$/, "")}/api/v1/projects/${cfg.site}/config`)
      .then((r) => (r.ok ? (r.json() as Promise<{ writeMode?: string; writable?: boolean }>) : null))
      .then((conf) => {
        if (conf?.writeMode === "open" && conf.writable !== false) {
          whenMountable(() => void api.activate().catch(() => {}));
        }
      })
      .catch(() => {});
  }
}

function measure(start: number): void {
  try {
    performance.measure(PERF, { start });
  } catch {
    /* no User Timing, or no options-object support — timing is a nicety */
  }
}

boot();

import { GLOBALS, scriptAttr, type ScriptAttr } from "@snagset/types/names";

/**
 * `snagset` — the npm way in., and the structure with the name.
 *
 * ── THIS PACKAGE DOES NOT CONTAIN THE WIDGET, AND THAT IS THE DESIGN ──
 *
 * It writes the script tag for you. Nothing more. The question that deserves an
 * answer before anyone reads further is *why not just bundle it*, and the
 * answer is measured rather than argued:
 *
 * | file | bytes |
 * |---|---|
 * | `snag.js` — the eager stub | **10 230** |
 * | the other nine chunks, lazy | 245 945 |
 *
 * The widget is a lazy chunk graph. Ten kilobytes load on every page; the
 * screenshot code, the panels, the fuzzy anchorer and the rest arrive only if
 * somebody actually opens the toolbar. Bundling that into `snagset` would put a
 * quarter of a megabyte into the host application's own bundle — or force them
 * to teach their bundler about our code-splitting — and the eager
 * envelope, the budget the whole architecture is built around, would be a
 * number about a file nobody loads.
 *
 * Three more things fall out of the shim that a bundle would break:
 *
 *  · **No version skew.** The chunks are fetched from the server at the
 *    server's version. A bundled widget pinned in someone's `package.json` at
 *    an older version would request chunk names that build no longer has.
 *  · **Same-origin stays same-origin** (A7). The bytes come from the
 *    instance the widget already talks to, so a client's CSP is one
 *    `script-src 'self'` entry and there is no third party to justify.
 *  · **The script tag is still sacred** — literally, not by
 *    analogy. This package emits exactly the tag the docs tell you to paste,
 *    so a bug here cannot produce behaviour the tag cannot.
 *
 * ── AND NO CUSTOM ELEMENT ──
 *
 * Sketched registering one so that "Vue, Svelte and Astro need no adapter
 * at all". That was reasoning about a *bundled* widget, where a framework needs
 * something to render. With a shim there is nothing to render — `init()` is
 * already framework-agnostic, and the framework subpaths are lifecycle glue
 * over this file rather than wrappers around an element. The custom element
 * would be bytes added to the eager stub to solve a problem this shape does not
 * have.
 */

/**
 * Everything the script tag accepts, as an object.
 *
 * Keys are the attribute names minus their `data-snag-` prefix, which is the
 * mapping `scriptAttr()` already owns — so this type cannot drift from the
 * attribute registry, and a new attribute is accepted here the day it is
 * registered rather than the day somebody remembers this file.
 */
export type SnagsetConfig = Partial<Record<ScriptAttr, string | number | boolean>>;

export interface InitOptions extends SnagsetConfig {
  /**
   * The instance. `https://review.example.com`.
   *
   * Required, and the ONE thing with no sensible default: the widget has to
   * know which server to talk to, and guessing `location.origin` would be
   * wrong on every site that is not itself the instance — which is all of them.
   */
  host: string;
  /** The project uid — `prj_…`, from the dashboard's Sites screen. */
  site: string;
  /** Where to put the tag. Defaults to `document.head`. */
  target?: Element;
}

const INSTALLED = "__snagset_npm_installed__";

/** The tag this package writes, exposed for tests and for docs to render. */
export function tagFor(options: InitOptions): { src: string; attrs: Record<string, string> } {
  const host = String(options.host).replace(/\/+$/, "");
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === "target" || key === "host" || value === undefined || value === null) continue;
    // `false` is dropped rather than written as the string "false". Every one
    // of these attributes is read by `loader.ts` as a STRING, and the presence
    // of `data-snag-disabled="false"` reads as "disabled" to anything doing a
    // has-attribute check — which is the shape of kill switch uses.
    if (value === false) continue;
    attrs[scriptAttr(key as ScriptAttr)] = value === true ? "" : String(value);
  }
  // `host` is both the config and the source, exactly as a hand-pasted tag has
  // it: the tag's own `src` is what `resolveAssetBase` falls back to, so the
  // chunks resolve with no extra configuration.
  attrs[scriptAttr("host")] = host;
  return { src: `${host}/snag.js`, attrs };
}

/**
 * Start Snagset on this page.
 *
 * ```js
 * import snagset from "snagset";
 *
 * snagset.init({ host: "https://review.example.com", site: "prj_…" });
 * ```
 *
 * ── WHY `init` AND NOT `mount` ──
 *
 * Because the product already had a name for this and it was not mine to
 * choose. defines
 * **`Snagset.init(config)`** as the public JS API — *"may be called repeatedly
 * before activation; each call merges"* — and `window.Snagset.init` /
 * `window.Snagset.destroy` are on the live object right now.
 *
 * The first version of this package called it `mount`/`unmount`, which is React
 * vocabulary imported into a package whose underlying object has said `init`
 * since 02 draft 1. A developer reading `snagset.mount()` in their app and
 * `Snagset.init()` in the console would reasonably conclude they were two
 * different things. Raised by the maintainer — *"init seems better than mount"* — and
 * he is right for a better reason than either of us gave at the time.
 *
 * ── REPEATED CALLS MERGE, LIKE THE SPEC SAYS ──
 *
 * A second `init()` does not add a second tag (that would boot a second
 * widget). It forwards the new config to `Snagset.init()`, which deep-merges
 * it — so this behaves the way documents rather than being a same-named
 * function with different rules. When the widget has not finished loading the
 * config is QUEUED and flushed on the script's `load` event, because a caller
 * has no way to know whether an async script has arrived yet and "your second
 * call was silently dropped depending on timing" is not a contract.
 *
 * Returns a function that removes the tag.
 */
function init(options: InitOptions): () => void {
  // SSR guard first. This package is imported at module scope in a Next.js or
  // Nuxt component, so it IS evaluated on the server, and touching `document`
  // there throws before anything can explain itself.
  if (typeof document === "undefined") return () => {};

  const w = window as unknown as Record<string, unknown>;

  if (w[INSTALLED]) {
    merge(options);
    return () => {};
  }

  if (!options.host) throw new Error("snagset: `host` is required — the URL of your Snagset instance.");
  if (!options.site) throw new Error("snagset: `site` is required — the project uid, which looks like prj_….");

  const { src, attrs } = tagFor(options);
  const el = document.createElement("script");
  el.src = src;
  el.defer = true;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  el.addEventListener("load", flush, { once: true });

  w[INSTALLED] = true;
  (options.target ?? document.head).appendChild(el);

  return () => {
    el.remove();
    w[INSTALLED] = false;
    queued.length = 0;
  };
}

/** Config handed to `init()` after the first call, before the widget exists. */
const queued: InitOptions[] = [];

function widget(): { init?: (c: unknown) => unknown; destroy?: () => void } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, unknown>)[GLOBALS.api] as never;
}

function merge(options: InitOptions): void {
  const api = widget();
  // `target` is OURS — where to put the tag — and means nothing to the widget.
  const { target: _drop, ...config } = options;
  if (api?.init) api.init(config);
  else queued.push(options);
}

function flush(): void {
  const pending = queued.splice(0);
  for (const options of pending) merge(options);
}

/**
 * Take Snagset off the page — 's
 * `Snagset.destroy()`.
 *
 * Delegates to the widget's OWN teardown rather than removing the script
 * element, because removing a script element does nothing at all: the code has
 * already run, the listeners are already bound, and the toolbar is already in
 * the DOM. That is the difference between a teardown that works and one that
 * appears to.
 */
function destroy(): void {
  if (typeof window === "undefined") return;
  widget()?.destroy?.();
  (window as unknown as Record<string, unknown>)[INSTALLED] = false;
  queued.length = 0;
}

/**
 * Is the tag on this page?
 *
 * `isInstalled`, not `isActive`: The `state` is `inert | dormant | active`
 * and "active" already means *the toolbar is open*, which is a different
 * question with a different answer. Read `window.Snagset.state` for that one.
 */
function isInstalled(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>)[INSTALLED];
}

/**
 * The default export — the package's own name, carrying the verbs.
 *
 * An OBJECT with `init`, not a callable. The first version made `snagset({…})`
 * itself the call, on the argument that one verb should be the noun; with the
 * verb named `init` that argument evaporates, and `snagset({…})` alongside
 * `snagset.init({…})` would be two ways to do one thing in a brand-new API.
 * This is the shape every SDK a developer has installed before this one has —
 * `posthog.init`, `Sentry.init`, `mixpanel.init` — and now also the shape the
 * widget's own global has, which matters more.
 */
export const snagset = { init, destroy, isInstalled, tag: tagFor };

export { init, destroy, isInstalled };
export default snagset;

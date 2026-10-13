import { tagFor, type InitOptions } from "./index.ts";

/**
 * `snagset/astro`.
 *
 * Astro is the case where the OTHER answer is better, and this file says so
 * rather than pretending otherwise.
 *
 * Astro renders on the server and ships zero JavaScript by default. A component
 * that exists only to run a `init()` effect in the browser would need a client
 * directive (`client:load`), which means shipping a hydration runtime to boot a
 * script tag — paying for a framework to do something HTML does natively.
 *
 * So this subpath gives you the tag as data, to render in your layout:
 *
 * ```astro
 * ---
 * import { snagsetTag } from "snagset/astro";
 * const tag = snagsetTag({ host: "https://review.example.com", site: "prj_…" });
 * ---
 * <script src={tag.src} {...tag.attrs} defer is:inline></script>
 * ```
 *
 * `is:inline` matters: without it Astro takes ownership of the script, bundles
 * it, and rewrites the `src` — which breaks `resolveAssetBase`, because the
 * widget finds its sibling chunks relative to its own `<script src>`.
 *
 * The same function is what a plain Nuxt/SvelteKit/Rails layout wants, and
 * `useHead`/`svelte:head` consume it directly.
 */
export function snagsetTag(options: InitOptions): {
  src: string;
  attrs: Record<string, string>;
  /** The whole thing as a string, for a template that wants one. */
  html: string;
} {
  const { src, attrs } = tagFor(options);
  const rendered = Object.entries(attrs)
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${v.replace(/"/g, "&quot;")}"`))
    .join("");
  return { src, attrs, html: `<script src="${src}"${rendered} defer></script>` };
}

export { tagFor };

/**
 * Default-exported too, so a consumer who prefers defaults has one — but the
 * NAMED import is what the docs show.
 *
 * `import snagset from "snagset/astro"` would give you a callable `snagset(…)`
 * beside the core's `snagset.init(…)`, which is two different shapes under one
 * name. `snagsetTag` says what it returns.
 *
 * The same function is on the core as `snagset.tag(…)` — it touches no DOM, so
 * it is safe to call while rendering on a server.
 */
export default snagsetTag;

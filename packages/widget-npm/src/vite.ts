import { tagFor, type InitOptions } from "./index.ts";

/**
 * `snagset/vite`, the config-level install.
 *
 * ```ts
 * // vite.config.ts
 * import { snagset } from "snagset/vite";
 *
 * export default defineConfig({
 *   plugins: [snagset({ host: "https://review.example.com", site: "prj_…" })],
 * });
 * ```
 *
 * One line in a file the project already has, and no component in the tree at
 * all. This is the piece of Vercel's install story worth taking (their
 * SvelteKit path is `vercelToolbar()` in `vite.config`) — and because Nuxt,
 * SvelteKit, Astro, SolidStart and Qwik all sit on Vite, this single plugin is
 * the config-level answer for every one of them: put it under `vite.plugins`
 * in `nuxt.config`, or beside `sveltekit()`.
 *
 * ── WHY THERE IS NO `vite` IMPORT IN THIS FILE ──
 *
 * The plugin is a plain object — a `name` and a `transformIndexHtml` hook —
 * and Vite's contract for it is structural. Importing `vite` for its `Plugin`
 * type would make a types-only package a peer dependency and pin us to its
 * version churn, to say nothing this file's shape does not already say. The
 * local types below are the subset we implement, and they assign cleanly to
 * every Vite since the hook stabilized (v2).
 *
 * ── DEV AND BUILD BOTH, DELIBERATELY ──
 *
 * The tag is safe in a production build because who sees the toolbar is a
 * DASHBOARD setting, checked by the stub on load — shipping the tag is
 * not showing the toolbar. So the plugin does not carry an `enabled`/`dev`
 * option that re-answers a question Vite already answers natively: a project
 * that wants the tag only in dev writes the standard idiom
 * `mode === "development" ? snagset({…}) : undefined` in its own config.
 */

/** The subset of Vite's `HtmlTagDescriptor` this plugin produces. */
export interface SnagsetHtmlTag {
  tag: string;
  attrs: Record<string, string | boolean>;
  injectTo: "body";
}

/** The subset of Vite's `Plugin` this plugin is. */
export interface SnagsetVitePlugin {
  name: string;
  transformIndexHtml: () => SnagsetHtmlTag[];
}

export function snagset(options: InitOptions): SnagsetVitePlugin {
  // Fail in the factory, not in the hook: a config error should stop `vite`
  // at startup with a sentence, never surface mid-build as a mangled page.
  if (!options?.host) throw new Error("snagset/vite: `host` is required — the URL of your Snagset instance.");
  if (!options.site) throw new Error("snagset/vite: `site` is required — the project uid, which looks like prj_….");

  const { src, attrs } = tagFor(options);
  return {
    name: "snagset",
    transformIndexHtml() {
      // `injectTo: "body"` is the docs' own instruction — "immediately before
      // the closing </body> tag" — expressed as the hook's vocabulary.
      return [{ tag: "script", attrs: { src, defer: true, ...attrs }, injectTo: "body" }];
    },
  };
}

export default snagset;

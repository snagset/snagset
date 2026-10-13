import { createElement } from "react";
import { tagFor, type InitOptions } from "./index.ts";

/**
 * `snagset/next`.
 *
 * ```tsx
 * // app/layout.tsx
 * import { Snagset } from "snagset/next";
 *
 * <body>
 *   {children}
 *   <Snagset host="https://review.example.com" site="prj_…" />
 * </body>
 * ```
 *
 * ── A SERVER COMPONENT, NOT A CLIENT EFFECT ──
 *
 * `snagset/react` runs `init()` in a `useEffect`, because a generic React tree
 * offers nothing better. Next offers something better: this component has no
 * hooks and no `"use client"`, so in the App Router it renders on the server
 * and the script tag arrives IN the HTML — zero client JavaScript, zero
 * hydration, byte-for-byte the tag the docs tell you to paste. It degrades
 * cleanly too: in the Pages Router (or any client tree) it renders the same
 * element and React mounts it, which boots the script just the same.
 *
 * ── WHY THERE IS NO `withSnagset(nextConfig)` WRAPPER ──
 *
 * Vercel's own toolbar ships one because their setup needs `next.config`
 * rewrites to proxy toolbar traffic through the deployment. Ours needs no
 * proxy: the widget is served by the studio's instance and talks back to that
 * same origin. A config wrapper would exist to look like theirs, not to
 * do anything — the component is the whole install.
 *
 * ── PROPS, OR `NEXT_PUBLIC_SNAGSET_*` ──
 *
 * A bare `<Snagset />` reads `NEXT_PUBLIC_SNAGSET_HOST` and
 * `NEXT_PUBLIC_SNAGSET_SITE`, so per-environment values live where a Next
 * project already keeps them (`.env.local`, the host's env UI) instead of in
 * the layout. The names carry Next's own public prefix — deliberately NOT bare
 * `SNAGSET_*`, which is the server's reserved namespace: an instance
 * colocated with the app must never find widget config in variables it treats
 * as its own and refuses to boot on.
 *
 * Missing config renders NOTHING rather than throwing: this sits in the root
 * layout, and a review widget that can take down every page of the site over
 * an unset env var would violate the product's oldest rule. The dev-only
 * console line is the diagnostic.
 */

export type SnagsetProps = Partial<InitOptions>;

// Declared, not imported: this package's build is browser-lib on purpose, and
// `@types/node` here would let genuinely Node-only APIs slip into files that
// run in other people's frontends. Dot access below is also load-bearing —
// Next's compiler inlines `process.env.NEXT_PUBLIC_*` on the client only for
// literal member expressions, never computed or bracketed ones.
declare const process:
  | {
      env: {
        NEXT_PUBLIC_SNAGSET_HOST?: string;
        NEXT_PUBLIC_SNAGSET_SITE?: string;
        NODE_ENV?: string;
      };
    }
  | undefined;

export function Snagset(props: SnagsetProps = {}): ReturnType<typeof createElement> | null {
  const hasEnv = typeof process !== "undefined" && !!process.env;
  const host = props.host ?? (hasEnv ? process!.env.NEXT_PUBLIC_SNAGSET_HOST : undefined);
  const site = props.site ?? (hasEnv ? process!.env.NEXT_PUBLIC_SNAGSET_SITE : undefined);
  if (!host || !site) {
    if (hasEnv && process!.env.NODE_ENV !== "production") {
      console.warn(
        "snagset/next: rendering nothing — set `host` and `site` props, or NEXT_PUBLIC_SNAGSET_HOST and NEXT_PUBLIC_SNAGSET_SITE.",
      );
    }
    return null;
  }
  const { src, attrs } = tagFor({ ...props, host, site });
  return createElement("script", { src, defer: true, ...attrs });
}

export default Snagset;

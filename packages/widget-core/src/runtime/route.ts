import { META_NAME } from "@snagset/types/names";

/**
 * The route a pin belongs to, verbatim:
 *
 *   "URL paths are not fully redacted. The route is a pin's primary key, so
 *    `/users/jane.doe/invoices` is stored as-is APART FROM TOKEN-SHAPED
 *    SEGMENTS."
 *
 * Both halves are load-bearing and the second was missing. `CaptureContext.url`
 * went through `redactUrl`, so a password-reset link came out as
 * `/reset-password/[redacted:jwt]` — while `PageRef.route`, `PageRef.pathname`
 * and `Snag.route` carried the same JWT verbatim into `localStorage` and into
 * both exports, from the same page load. Found by an adversarial review;
 * reproduced end to end before this existed.
 *
 * ── WHY THIS IS NOT `redactText`, AND NOT A FORK OF IT ──
 *
 * The design forbids forking the sensitivity vocabulary, and this does not: it
 * asks a different, narrower question — *is this path segment shaped like a
 * secret* — which is the question actually poses. The full
 * vocabulary lives in the CAPTURE chunk, which is lazy on purpose, and the
 * route cannot wait for it: `route` is the key `paint()` filters on, on every
 * repaint, from the first load. If storage held a redacted route and the live
 * comparison used a raw one, every pin would vanish from its own page.
 *
 * So the rule is applied ON BOTH SIDES by this one function, and the full net
 * still runs over `CaptureContext.url` in the capture chunk. A segment that is
 * sensitive by MEANING rather than by shape — `/users/jane.doe/` — is stored as
 * is, which is saying so out loud.
 */

/**
 * A segment nobody types and nobody reads: long, and mixing the character
 * classes that identifiers do not.
 *
 * The three shapes are the ones that actually appear in a URL path — a JWT, a
 * hex digest, and an opaque high-entropy id. Deliberately conservative at the
 * boundaries: `/reset-password/`, `/invoices/`, `/2026-08-12/` and a slug like
 * `/the-kerning-is-off/` must survive, because the route is a primary key and
 * mangling it loses the pin.
 */
const JWTISH = /^eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/;
const HEXISH = /^[a-f0-9]{32,}$/i;
const OPAQUE = /^(?=[A-Za-z0-9_-]{24,}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+$/;

const MARK = "[redacted]";

export function redactRoute(pathname: string): string {
  if (!pathname.includes("/")) return pathname;
  return pathname
    .split("/")
    .map((seg) =>
      JWTISH.test(seg) || HEXISH.test(seg) || OPAQUE.test(seg) ? MARK : seg,
    )
    .join("/");
}

/**
 * The path normalisation — all three v0 rows.
 *
 * | Step | Default | Behaviour |
 * |---|---|---|
 * | Trailing slash | `'strip'` | `/about/` → `/about`; **`/` is never stripped** |
 * | Case | insensitive | `route` lowercased; `pathname` kept raw |
 * | Index files | always | `/index.html`, `.htm`, `.php` → the parent path |
 *
 * ── WHAT ITS ABSENCE COST ──
 *
 * Route identity was the raw pathname, so `/about` and `/about/` were two
 * different pages holding two different sets of pins. That is not an edge case:
 * Hugo, Astro and Eleventy emit trailing slashes by default, Next has a
 * `trailingSlash` option that flips it, and a site that answers on both — most
 * do — silently splits every reviewer's round in half depending on which link
 * they followed. The comment does not appear, so it reads as data loss.
 *
 * Case folding is the same argument on Windows-authored and CMS-generated
 * URLs, where `/About` and `/about` serve one page. The RAW pathname is kept
 * beside the route precisely because it is the thing to show a human — the design
 * has `route` for identity and `pathname` for display, and folding both would
 * mean an export that misquotes the URL somebody visited.
 *
 * Index files are the oldest of the three: `/docs/` and `/docs/index.html` are
 * one page on every static host ever written.
 *
 * The three v0.1 rows — locale prefix and dynamic segments — are deliberately
 * NOT here. The own reasoning is that false MERGING is worse than false
 * splitting: a comment surfacing on the wrong product page is a bug report
 * about the wrong product, and merging locales mass-manufactures false orphans
 * because the text quote can never match.
 */
const INDEX_FILE = /\/index\.(html?|php)$/i;

export function normalisePath(pathname: string): string {
  // An empty or relative input is not a path we can reason about; hand it back
  // rather than inventing a leading slash the caller did not have.
  if (!pathname.startsWith("/")) return pathname;

  let out = pathname.replace(INDEX_FILE, "/");

  // Trailing slash AFTER the index strip, so `/docs/index.html` becomes
  // `/docs/` and then `/docs` in one pass rather than needing two.
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);

  // Lower-cased LAST: the two rules above are case-insensitive already, and
  // doing it last keeps them readable against the spec's table order.
  return out.toLowerCase();
}

/**
 * The route-hint ladder — at v0.1: explicit override, then
 * the `snagset:route` meta hint, then nothing (the caller falls back to the
 * normalised pathname). Evaluated in order; first hit wins.
 *
 * STATELESS on purpose. This file is bundled into both the runtime and the
 * capture chunk (self-contained copies), so module state set through one
 * copy would be invisible to the other — the OVERRIDE therefore lives in the
 * runtime's mount closure and arrives here as a parameter, while the meta
 * tag is DOM both copies read identically.
 *
 * Path 3 (Next.js Pages Router via __NEXT_DATA__) is deliberately absent:
 * the plan's bullet lists it, but tags it v1.x (
 * sweep R2 — it ships with the framework wrappers), and the spec's tag
 * governs stale plan text. The App Router sniff is rejected outright by the
 * spec ("can produce a WRONG pattern, which is worse than no pattern").
 */
export function metaRoute(doc: Document): string | null {
  // A HINT, not a contract: malformed values — and environments whose
  // `document` is a test stub with no querySelector — are ignored SILENTLY,
  // no console output, no behaviour change (the DoD asserts both).
  try {
    const v = doc
      .querySelector(`meta[name="${META_NAME.route}"]`)
      ?.getAttribute("content")
      ?.trim();
    if (!v || v.length > 512 || !v.startsWith("/")) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * The route identity for a document, hint-aware. A pattern like
 * `/products/[slug]` goes through the same normalisation as a pathname —
 * `redactRoute` cannot misfire on bracket segments (no digits, so none of
 * the three token shapes match) and lowercasing a pattern is harmless.
 */
export function routeWithHint(doc: Document, override: string | null): string {
  const hint = override ?? metaRoute(doc);
  return normalisePath(hint ?? redactRoute(doc.location.pathname));
}

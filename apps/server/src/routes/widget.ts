import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Widget asset serving, the CSP win.
 *
 * *"The server serves the widget from its own origin, from the same package, at
 * the same version."* That sentence is the product's answer to a client whose
 * security team will not allow a third-party CDN on a payment page: there is no
 * third party. One origin, one Content-Security-Policy entry, bytes the
 * operator can hash.
 *
 * ── HOW THIS WAS FOUND MISSING, WHICH IS THE PART WORTH KEEPING ──
 *
 * It was not implemented at all, and nothing said so. `/widget/snag.js`
 * returned **200** — because the dashboard's SPA fallback answers every
 * unmatched path with `index.html`, so a script tag pointing at it received a
 * page of HTML with `content-type: text/html` and failed silently in the
 * browser. The docs page written the day before told operators to use exactly
 * that URL.
 *
 * Two consequences are designed in below. This router is mounted BEFORE the
 * fallback, so a missing artefact 404s instead of becoming a web page. And the
 * test asserts the CONTENT TYPE and the first bytes, never the status code,
 * because a status code was what made this invisible.
 */

export interface WidgetDeps {
  /** Semver of the running build — the version path segment. */
  readonly version: string;
  /** Overridden in tests. Defaults to the package's own `static/widget`. */
  readonly dir?: string;
}

/** `1` from `1.4.2`; `0` while the package is pre-1.0. */
const majorOf = (version: string): string => version.split(".")[0] ?? "0";

/**
 * Three cache policies, and which one a response gets is decided by WHAT IS
 * ASKED FOR, never by the path alone. And own the table; the
 * reasoning is here because it is subtle and it was wrong.
 *
 * ── HOW IT WAS WRONG ──
 *
 * The alias and `/snag.js` were `max-age=300`, and every chunk URL carried
 * `?cv=0.0.0` — a cache-buster that was a constant. So after a release a
 * reviewer ran the previous widget until five minutes had passed since THEIR
 * last load, or until they hard-refreshed: the browser's copy of
 * `snag.runtime.js?cv=0.0.0` was still fresh, and nothing about the URL had
 * changed. The fix is in two halves, and this file is the second.
 *
 * ── THE THREE ──
 *
 * `ENTRY` — the stub on every unversioned path (`/snag.js`, `/widget/snag.js`,
 * `/widget/v1/snag.js`) and the manifest. These URLs cannot change, because
 * they are what a client pasted. A minute in the browser is how fast a release
 * reaches a reviewer; five at the edge, which a Vercel deploy empties anyway
 * (the deployment is part of its cache key), bounds what any other shared
 * cache can hold. Vercel strips `s-maxage` before the browser sees it. No
 * `stale-while-revalidate`: browsers honour it too, and on a self-hosted
 * instance with no CDN it would hand the reviewer the old stub one more time,
 * which is the bug. No ETag either: this stub runs on every page view of the
 * client's site, and a 304 round trip per view is not cheaper than a 4.5 KB
 * body a minute — and Vercel's edge has already been seen answering
 * conditional requests with 304s that drop the CORS headers.
 *
 * `IMMUTABLE` — a chunk whose `?cv=` is THIS build's id (dist/build.json,
 * written by widget-core's scripts/build-id.mjs), and the stub on the version
 * path that matches this server. The id changes whenever any byte does, so a
 * URL that names it names these bytes forever; a year is safe and a reload
 * costs nothing. The edge's cache key includes the query string for function
 * responses — on Vercel every path here IS the function (vercel.json rewrites
 * them all) — so each id is its own entry.
 *
 * `NO_STORE` — everything else: a chunk asked for under another build's id, or
 * no id, and anything under a version path that is not this server's. The bytes
 * still go out, because a page that loaded a stub a moment before the deploy
 * should still get a widget rather than a 404. But they are THIS build's bytes,
 * not the ones that URL named, so they must not be kept under that URL: cached
 * immutable they would pin new bytes to an old name for a year, and cached
 * briefly they would still let a rollback be answered from the wrong build.
 * Only stale pages ask for these, so the cost is a handful of uncached requests
 * in the minute after a release.
 */
const IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable";
const ENTRY = "public, max-age=60, s-maxage=300";
const NO_STORE = "no-store";

/** Exported for the route test, which asserts the table rather than re-deriving it. */
export const WIDGET_CACHE = { IMMUTABLE, ENTRY, NO_STORE } as const;

const STUB = "snag.js";

/**
 * This build's id from `build.json`, or null — a directory without one (a
 * dev watcher's output, an older package) has no id that can be current, so
 * every chunk is served `no-store`. Slower, never stale.
 */
function readBuildId(root: string): string | null {
  try {
    const cv = (JSON.parse(readFileSync(join(root, "build.json"), "utf8")) as { cv?: unknown }).cv;
    return typeof cv === "string" && cv ? cv : null;
  } catch {
    return null;
  }
}

export function widgetRoutes(deps: WidgetDeps): Hono {
  const app = new Hono();
  const root =
    deps.dir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "static", "widget");
  const major = majorOf(deps.version);
  const build = readBuildId(root);

  /**
   * The policy for one request — see the block above. `pinned` is the
   * version segment when the path has one: a version that is not this
   * server's is answered, never cached.
   */
  const policy = (c: Context, name: string, pinned?: string): string => {
    if (pinned !== undefined && pinned !== deps.version) return NO_STORE;
    if (name === STUB) return pinned !== undefined ? IMMUTABLE : ENTRY;
    // The id is `<release>+<hash>`, and the loader sends the `+` as `%2B`. A
    // proxy that decodes it hands us a literal `+`, which form-decoding reads
    // as a space — the same id, so it is read back as one.
    const cv = c.req.query("cv")?.replace(/ /g, "+");
    return build !== null && cv === build ? IMMUTABLE : NO_STORE;
  };

  /** One artefact, or null when the name escapes the directory or is absent. */
  const read = (name: string): Buffer | null => {
    // `..` cannot escape: the join is resolved and checked against the root.
    const full = resolve(root, name);
    if (!full.startsWith(resolve(root))) return null;
    if (!existsSync(full) || !statSync(full).isFile()) return null;
    return readFileSync(full);
  };

  const serve = (c: Context, name: string, pinned?: string) => {
    // Scripts and their maps only: `build.json` sits in the same directory and
    // is the server's to read, not a widget artefact to hand out as JavaScript.
    const body = /\.(?:js|map)$/.test(name) ? read(name) : null;
    if (!body) {
      // 404 and a sentence, never the SPA shell. An operator who mistypes a
      // path should learn that here rather than from a browser console saying
      // the module has an unexpected MIME type.
      return c.json(
        {
          error: "artefact_not_found",
          message:
            `No widget artefact called ${JSON.stringify(name)} in this build. ` +
            `The set is listed at /widget/manifest.json.`,
        },
        404,
      );
    }
    c.header("Content-Type", name.endsWith(".map") ? "application/json" : "text/javascript; charset=utf-8");
    c.header("Cache-Control", policy(c, name, pinned));
    // The widget is loaded BY OTHER ORIGINS — that is the entire product — so
    // these bytes are explicitly cross-origin readable. Without it a client's
    // site cannot fetch the module at all.
    c.header("Access-Control-Allow-Origin", "*");
    // A client hashing this file for PCI 6.4.3 needs the digest
    // to be the one they can compute themselves. Published here too so they do
    // not have to.
    c.header("X-Content-Type-Options", "nosniff");
    // Hono's body() takes an ArrayBuffer view, not Node's pooled Buffer.
    return c.body(new Uint8Array(body));
  };

  /**
   * `/widget/manifest.json` — version plus a `sha384` for every artefact.
   *
   * This is the answer .5's open question, and it is cheap to give
   * even while that question is open: a client who must inventory and
   * integrity-check every script on a payment page (PCI DSS 6.4.3, mandatory
   * since 2025-03-31) can read the digest of the exact bytes this instance is
   * serving. Computed on demand rather than at build, because the file on disk
   * is what will actually be served and a build-time digest can only ever be a
   * claim about it.
   */
  app.get("/widget/manifest.json", (c) => {
    let files: string[] = [];
    try {
      files = readdirSync(root).filter((f) => f.endsWith(".js"));
    } catch {
      /* no widget directory in this build — reported as an empty set below */
    }
    const assets = files.map((name) => {
      const body = readFileSync(join(root, name));
      return {
        name,
        bytes: body.byteLength,
        integrity: `sha384-${createHash("sha384").update(body).digest("base64")}`,
      };
    });
    c.header("Cache-Control", ENTRY);
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ version: deps.version, major: `v${major}`, build, assets });
  });

  // `/widget/v1/snag.js` — the major-pinned alias, and the path the dashboard
  // prints. Registered before the version route so `v1` is not read as one.
  // The whole segment is the param, `v1` included. Written first as
  // `/widget/v:major{v?[0-9]+}/…` — a literal `v` followed by a param whose
  // own pattern also allowed one — which matched nothing and fell through to
  // the dashboard's catch-all, i.e. straight back into the bug this router
  // exists to fix. Caught because the check asserted the content type.
  app.get("/widget/:major{v[0-9]+}/:name", (c) => serve(c, c.req.param("name")));

  // `/widget/1.4.2/snag.js` — immutable, and what an SRI hash is taken against.
  // Only when 1.4.2 is what this server IS: it used to answer any version
  // with the current bytes and cache them for a year under the old name.
  app.get("/widget/:version{[0-9]+\\.[0-9]+\\.[0-9]+}/:name", (c) =>
    serve(c, c.req.param("name"), c.req.param("version")),
  );

  // `/widget/snag.js` — unversioned, the shortest thing to paste. Same cache
  // policy as the alias: it can change under a client who never revisits.
  app.get("/widget/:name", (c) => serve(c, c.req.param("name")));

  /**
   * `/snag.js` AND ITS SIBLINGS — the convenience path. **Serves bytes,
   * never a 302**: a redirect costs a round trip on the critical path of every
   * page load, and a client's CSP would need the redirect target listed too.
   *
   * ── WHY THE PATTERN, AND NOT JUST `/snag.js` ──
   *
   * It WAS just `/snag.js`, and that made the documented install broken past
   * its first file. The stub resolves its lazy chunks relative to its own
   * `<script src>` (the `resolveAssetBase`), so a tag pointing at
   * `https://host/snag.js` asks for `https://host/snag.runtime.js` — which
   * nothing served, so the dashboard's SPA fallback answered **200 with
   * `text/html`**, and the dynamic `import()` failed with "Failed to fetch
   * dynamically imported module". The stub loaded, installed its global, and
   * the widget could never activate.
   *
   * Exactly the failure this router was written to fix, at the one path this
   * router did not cover — and invisible for the same reason: a 200 with the
   * wrong content type. The CLI, the docs and the dashboard's Sites screen all
   * print this path. Found by activating the widget in a browser rather than by
   * requesting `/snag.js` and seeing 200.
   *
   * The pattern is anchored to `snag.<something>.js` and to `snag.js`, so it
   * cannot become a second catch-all: `serve()` still confines every name to
   * the widget directory, and anything not on disk 404s with a sentence.
   */
  app.get("/:name{snag\\.js}", (c) => serve(c, c.req.param("name")));
  app.get("/:name{snag\\.[a-z0-9-]+\\.js}", (c) => serve(c, c.req.param("name")));
  // The source maps the chunks reference, on the same terms.
  app.get("/:name{snag\\.[a-z0-9.-]+\\.map}", (c) => serve(c, c.req.param("name")));

  return app;
}

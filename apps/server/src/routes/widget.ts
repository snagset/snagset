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
 * Immutable for a version path, five minutes for the major alias.
 *
 * The design sets both, and the asymmetry is the whole point of having two paths:
 * a client who pins gets bytes that can be cached forever and hashed for SRI,
 * and a client who never touches the tag again gets a fix within five minutes.
 *
 * `s-maxage` says the same to a SHARED cache, which reads only that: on Vercel
 * every path is the function, and a widget chunk fetched by a reviewer in
 * Seoul crossed to the function's region on every page load past the five
 * minutes. With it the nearest edge answers, for the same five minutes — and
 * a deploy starts that cache afresh.
 */
const IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable";
const ALIAS = "public, max-age=300, s-maxage=300";

export function widgetRoutes(deps: WidgetDeps): Hono {
  const app = new Hono();
  const root =
    deps.dir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "static", "widget");
  const major = majorOf(deps.version);

  /** One artefact, or null when the name escapes the directory or is absent. */
  const read = (name: string): Buffer | null => {
    // `..` cannot escape: the join is resolved and checked against the root.
    const full = resolve(root, name);
    if (!full.startsWith(resolve(root))) return null;
    if (!existsSync(full) || !statSync(full).isFile()) return null;
    return readFileSync(full);
  };

  const serve = (c: Context, name: string, cache: string) => {
    const body = read(name);
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
    c.header("Cache-Control", cache);
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
    c.header("Cache-Control", ALIAS);
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ version: deps.version, major: `v${major}`, assets });
  });

  // `/widget/v1/snag.js` — the major-pinned alias, and the path the dashboard
  // prints. Registered before the version route so `v1` is not read as one.
  // The whole segment is the param, `v1` included. Written first as
  // `/widget/v:major{v?[0-9]+}/…` — a literal `v` followed by a param whose
  // own pattern also allowed one — which matched nothing and fell through to
  // the dashboard's catch-all, i.e. straight back into the bug this router
  // exists to fix. Caught because the check asserted the content type.
  app.get("/widget/:major{v[0-9]+}/:name", (c) => serve(c, c.req.param("name"), ALIAS));

  // `/widget/1.4.2/snag.js` — immutable, and what an SRI hash is taken against.
  app.get("/widget/:version{[0-9]+\\.[0-9]+\\.[0-9]+}/:name", (c) =>
    serve(c, c.req.param("name"), IMMUTABLE),
  );

  // `/widget/snag.js` — unversioned, the shortest thing to paste. Same cache
  // policy as the alias: it can change under a client who never revisits.
  app.get("/widget/:name", (c) => serve(c, c.req.param("name"), ALIAS));

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
  app.get("/:name{snag\\.js}", (c) => serve(c, c.req.param("name"), ALIAS));
  app.get("/:name{snag\\.[a-z0-9-]+\\.js}", (c) => serve(c, c.req.param("name"), ALIAS));
  // The source maps the chunks reference, on the same terms.
  app.get("/:name{snag\\.[a-z0-9.-]+\\.map}", (c) => serve(c, c.req.param("name"), ALIAS));

  return app;
}

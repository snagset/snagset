import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { widgetRoutes, WIDGET_CACHE } from "../src/routes/widget.ts";

/**
 * Widget asset serving.
 *
 * EVERY ASSERTION IS ON THE CONTENT TYPE OR THE BYTES, never on the status
 * code, and that is the whole lesson of how this was found. The routes did not
 * exist at all, and `/widget/snag.js` answered **200** — the dashboard's SPA
 * fallback returning `index.html` for any unmatched path. A script tag pointing
 * at it received a page of HTML and failed in the browser with a MIME type
 * error. A status-code test would have passed on the broken build.
 *
 * The router is mounted here BEHIND a catch-all that mimics that fallback, so
 * these tests fail the same way the real server would if the mounting order
 * ever regressed.
 */

let app: Hono;
let dir: string;

const STUB = '(function(){"use strict";console.log("stub")})();';
/** This fixture build's id — what widget-core's build-id.mjs writes. */
const BUILD = "1.4.2+abc123";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "snagset-widget-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "snag.js"), STUB);
  writeFileSync(join(dir, "snag.runtime.js"), "export const x = 1;");
  writeFileSync(join(dir, "snag.panels.js"), "export const p = 1;");
  writeFileSync(join(dir, "snag.capture.js"), "export const c = 1;");
  writeFileSync(join(dir, "build.json"), JSON.stringify({ version: "1.4.2", cv: BUILD }));

  app = new Hono();
  app.route("/", widgetRoutes({ version: "1.4.2", dir }));
  // The SPA fallback, reproduced: this is what swallowed the paths before.
  app.get("/*", (c) => {
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.html("<!doctype html><html><body>dashboard</body></html>");
  });
});

const get = (path: string) => app.request(path);

test("the unversioned path serves JAVASCRIPT, not the dashboard shell", async () => {
  const res = await get("/widget/snag.js");
  assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(await res.text(), STUB, "the actual stub bytes, not a page");
});

test("`/snag.js` serves the bytes directly — never a redirect", async () => {
  // "serves bytes directly, never a 302". A redirect costs a round
  // trip on the critical path of every page load, and a client's CSP would
  // need the redirect target listed too.
  const res = await get("/snag.js");
  assert.equal(res.status, 200, "not 301/302");
  assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(await res.text(), STUB);
});

test("the major alias resolves, and is NOT cached forever", async () => {
  // The first implementation wrote this route as a literal `v` followed by a
  // param that also allowed one. It matched nothing, fell through to the
  // catch-all, and returned HTML with a 200.
  const res = await get("/widget/v1/snag.js");
  assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(res.headers.get("cache-control"), "public, max-age=60, s-maxage=300");
});

test("the exact-version path IS cached forever — that is what SRI is taken against", async () => {
  const res = await get("/widget/1.4.2/snag.js");
  assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(res.headers.get("cache-control") ?? "", /immutable/);
});

test("the widget is readable cross-origin — that is the entire product", async () => {
  // It is loaded BY other origins by definition. Without this a client's site
  // cannot fetch the module at all.
  const res = await get("/widget/snag.js");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("a missing artefact 404s with a sentence, and NEVER the SPA shell", async () => {
  const res = await get("/widget/does-not-exist.js");
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; message: string };
  assert.equal(body.error, "artefact_not_found");
  assert.match(body.message, /manifest\.json/, "and it says where the real list is");
});

test("a traversal cannot escape the widget directory", async () => {
  for (const path of ["/widget/..%2f..%2fpackage.json", "/widget/../package.json"]) {
    const res = await get(path);
    const type = res.headers.get("content-type") ?? "";
    assert.ok(
      !type.includes("javascript") || res.status === 404,
      `${path} must not serve a file from outside static/widget`,
    );
  }
});

test("the manifest carries a sha384 for every artefact (PCI 6.4.3, .5)", async () => {
  const res = await get("/widget/manifest.json");
  const body = (await res.json()) as {
    version: string;
    major: string;
    assets: { name: string; bytes: number; integrity: string }[];
  };
  assert.equal(body.version, "1.4.2");
  assert.equal(body.major, "v1");
  assert.equal((body as { build?: string }).build, BUILD, "and the build id a ?cv= must carry");
  const stub = body.assets.find((a) => a.name === "snag.js");
  assert.ok(stub, "the stub is listed");
  assert.match(stub.integrity, /^sha384-[A-Za-z0-9+/]+=*$/);
  assert.equal(stub.bytes, STUB.length);

  // The digest must be of the bytes actually served, or it is worse than
  // absent: a client pins an integrity hash that fails on every load.
  const { createHash } = await import("node:crypto");
  const served = await (await get("/widget/snag.js")).text();
  assert.equal(stub.integrity, `sha384-${createHash("sha384").update(served).digest("base64")}`);
});

// ── the root path, past its first file ───────────────────────────────────

test("the ROOT install path serves the lazy chunks too, not just the stub", async () => {
  /**
   * `/snag.js` was routed and its nine siblings were not. The stub resolves
   * chunks relative to its own `<script src>`, so the documented install asked
   * for `/snag.runtime.js` — which the dashboard's SPA fallback answered with
   * **200 and `text/html`**, and the dynamic import failed. The stub loaded,
   * installed its global, and the widget could never activate.
   *
   * The same invisible-200 failure this whole router exists to fix, at the one
   * path it did not cover. Found by ACTIVATING the widget in a browser; a
   * request for `/snag.js` alone returns 200 and proves nothing.
   */
  for (const name of ["snag.js", "snag.runtime.js", "snag.panels.js", "snag.capture.js"]) {
    const res = await app.request(`/${name}`);
    assert.match(
      res.headers.get("content-type") ?? "",
      /text\/javascript/,
      `/${name} must be JavaScript — a 200 of text/html is how this hid`,
    );
    assert.match(await res.text(), /function|export/, `/${name} has JS in it`);
  }
});

test("the root pattern is anchored — it has not become a second catch-all", async () => {
  // The bug being fixed was a catch-all answering everything; the fix must not
  // be another one.
  for (const path of ["/index.html", "/anything.js", "/api/v1/meta", "/snagx.js"]) {
    const res = await app.request(path);
    const body = await res.text();
    assert.ok(
      !body.includes("artefact_not_found"),
      `${path} must not be handled by the widget router`,
    );
  }
});

// ── cache policy, per path — / the table, as served ─────────

test("THE TABLE: every path gets the cache policy it was designed to", async () => {
  /**
   * After every release reviewers ran the previous widget for up to five
   * minutes, or until a hard refresh: the stub was `max-age=300` and every
   * chunk URL was `?cv=0.0.0`, a cache-buster that never changed. The fix
   * is that a URL naming THIS build is cached forever, a URL that cannot
   * change is cached for a minute, and anything naming another build is
   * not cached at all — so the table is asserted row by row, not sampled.
   */
  const { IMMUTABLE, ENTRY, NO_STORE } = WIDGET_CACHE;
  const cv = `cv=${encodeURIComponent(BUILD)}`;
  const rows: [string, string][] = [
    // The stub on the URLs a client pastes: short, because they cannot change.
    ["/snag.js", ENTRY],
    ["/widget/snag.js", ENTRY],
    ["/widget/v1/snag.js", ENTRY],
    // …and on the version path that IS this server: the SRI path.
    ["/widget/1.4.2/snag.js", IMMUTABLE],
    // A chunk naming this build, under every base the stub can resolve to.
    [`/snag.runtime.js?${cv}`, IMMUTABLE],
    [`/widget/snag.panels.js?${cv}`, IMMUTABLE],
    [`/widget/v1/snag.capture.js?${cv}`, IMMUTABLE],
    [`/widget/1.4.2/snag.runtime.js?${cv}`, IMMUTABLE],
    // The `+` decoded to a literal by a proxy on the way: still this build.
    [`/snag.runtime.js?cv=${BUILD}`, IMMUTABLE],
    // The loader's retry generation is a different URL of the same bytes.
    [`/snag.runtime.js?${cv}&r=1`, IMMUTABLE],
    // Another build's id — the page loaded its stub before the deploy.
    ["/snag.runtime.js?cv=1.4.2%2Bffffff", NO_STORE],
    ["/widget/v1/snag.panels.js?cv=0.0.0", NO_STORE],
    // No id at all: nothing the loader sends, so nothing worth keeping.
    ["/snag.runtime.js", NO_STORE],
    // A version path that is NOT this server: answered, never kept.
    ["/widget/1.4.1/snag.js", NO_STORE],
    [`/widget/1.4.1/snag.runtime.js?${cv}`, NO_STORE],
    // The manifest describes the current build, so it moves with the stub.
    ["/widget/manifest.json", ENTRY],
  ];
  for (const [path, want] of rows) {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} is served`);
    assert.equal(res.headers.get("cache-control"), want, `${path}`);
    // CORS on EVERY response, cached or not: chunks are import()ed, which is
    // a CORS-mode fetch, and one missing header is a widget that never loads.
    assert.equal(res.headers.get("access-control-allow-origin"), "*", `${path} is CORS-readable`);
    // And nothing here may be revalidated: Vercel's edge has answered
    // conditional requests with 304s that dropped the CORS headers.
    assert.equal(res.headers.get("etag"), null, `${path} carries no validator`);
  }
});

test("a stale ?cv= gets THIS build's bytes — a widget, just not a cached one", async () => {
  // A 404 would strand every page that loaded its stub a moment before the
  // deploy. The bytes are right; only keeping them under that name is wrong.
  const res = await get("/snag.runtime.js?cv=0.0.0");
  assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(await res.text(), "export const x = 1;");
});

test("build.json is the server's to read, not an artefact to serve", async () => {
  for (const path of ["/widget/build.json", "/widget/v1/build.json", "/widget/1.4.2/build.json"]) {
    const res = await get(path);
    assert.ok(!(res.headers.get("content-type") ?? "").includes("javascript"), `${path} is not served as a script`);
  }
});

test("a directory with no build id caches no chunk — slower, never stale", async () => {
  // A dev watcher's output, or a package built before ids existed: there is
  // no `cv` that can be current, so none may be cached immutable.
  const bare = mkdtempSync(join(tmpdir(), "snagset-widget-noid-"));
  writeFileSync(join(bare, "snag.js"), STUB);
  writeFileSync(join(bare, "snag.runtime.js"), "export const x = 1;");
  const a = new Hono().route("/", widgetRoutes({ version: "1.4.2", dir: bare }));
  const chunk = await a.request(`/snag.runtime.js?cv=${encodeURIComponent(BUILD)}`);
  assert.equal(chunk.headers.get("cache-control"), WIDGET_CACHE.NO_STORE);
  const stub = await a.request("/snag.js");
  assert.equal(stub.headers.get("cache-control"), WIDGET_CACHE.ENTRY);
});

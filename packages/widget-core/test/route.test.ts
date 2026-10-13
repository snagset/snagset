import { test } from "node:test";
import assert from "node:assert/strict";
import { normalisePath, redactRoute } from "../src/runtime/route.ts";

/**
 * Both halves.
 *
 * Found by adversarial review and reproduced end to end first: on
 * `/reset-password/<jwt>`, `CaptureContext.url` came out as
 * `/reset-password/[redacted:jwt]` while `PageRef.route`, `PageRef.pathname`
 * and `Snag.route` carried the JWT verbatim into localStorage and into both
 * exports — from the same page load.
 */

test("token-shaped segments are removed", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
  assert.equal(redactRoute(`/reset-password/${jwt}`), "/reset-password/[redacted]");
  assert.equal(redactRoute("/session/9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c"), "/session/[redacted]");
  assert.equal(redactRoute("/o/AKIAIOSFODNN7EXAMPLE1234"), "/o/[redacted]");
  // More than one, and in any position.
  assert.equal(
    redactRoute(`/a/${jwt}/b/9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c`),
    "/a/[redacted]/b/[redacted]",
  );
});

test("AND THE REST OF THE ROUTE SURVIVES — it is a primary key", () => {
  // The design is explicit that `/users/jane.doe/invoices` is stored as-is. A
  // route mangled by an over-eager rule loses the pin, which is a worse outcome
  // than the leak: the comment still exists and can no longer be found.
  for (const ok of [
    "/",
    "/pricing",
    "/users/jane.doe/invoices",
    "/blog/2026-08-12/the-kerning-is-off",
    "/docs/getting-started",
    "/checkout/step-2",
    "/products/SKU-1234",
    "/a/b/c/d/e",
    "/search",
    "/2026/08/12",
  ]) {
    assert.equal(redactRoute(ok), ok, `${ok} was mangled`);
  }
});

test("it is idempotent, so a re-read cannot corrupt a stored route", () => {
  const once = redactRoute("/reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefghij");
  assert.equal(redactRoute(once), once);
});

/**
 * The normalisation table, one row per rule — plan task 21's "unit table
 * for each normalisation row", which was written down and never built.
 */
test("trailing slash is stripped, and the root NEVER is", () => {
  assert.equal(normalisePath("/about/"), "/about");
  assert.equal(normalisePath("/a/b/c/"), "/a/b/c");
  // The design states this exception explicitly: "/ is never stripped". Without it
  // the home page's route becomes the empty string and matches nothing.
  assert.equal(normalisePath("/"), "/");
});

test("case is folded, because /About and /about are one page on most hosts", () => {
  assert.equal(normalisePath("/About/Us"), "/about/us");
  assert.equal(normalisePath("/CASE"), "/case");
});

test("index files collapse to the parent path", () => {
  assert.equal(normalisePath("/docs/index.html"), "/docs");
  assert.equal(normalisePath("/docs/index.htm"), "/docs");
  assert.equal(normalisePath("/index.php"), "/");
  // The root's own index file is the case that would break if the trailing
  // slash were stripped before the index file: "/index.html" → "/" → "".
  assert.equal(normalisePath("/index.html"), "/");
});

test("a path that is not a path is handed back untouched", () => {
  // A relative or empty input has no leading slash to reason from, and
  // inventing one would fabricate a route the caller never had.
  assert.equal(normalisePath(""), "");
  assert.equal(normalisePath("about"), "about");
});

test("normalisation composes with redaction, in that order", () => {
  // The stored route and the live route must agree or a pin never appears on
  // its own page — so both call sites run the same pair, and this asserts the
  // composition rather than each half alone.
  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij";
  assert.equal(normalisePath(redactRoute(`/Reset/${token}/`)), "/reset/[redacted]");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { RESERVED_URL_PARAMS } from "@snagset/types/names";
import { isIgnoredQueryParam, queryMatches, significantQuery } from "../src/runtime/params.ts";
import { metaRoute, routeWithHint } from "../src/runtime/route.ts";
import { derivePageRef } from "../src/capture/context.ts";

/**
 * The query-parameter policy and the route-hint ladder
 * The CI clause the spec marks mandatory lives here: the reserved
 * set is generated .5 and every member must be ignored, and the
 * constant's SHAPE is asserted at the type level — a flat array would
 * type-check against `.every` and silently empty the denylist, which is the
 * one name-drift that cannot be repaired after permalink data exists.
 */

// The type-level shape test: this line fails to COMPILE if the
// constant ever flattens to an array.
const _shape: { query: readonly string[]; fragment: readonly string[] } = RESERVED_URL_PARAMS;
void _shape;

test("the reserved set is an OBJECT, and every query member is ignored (mandatory CI)", () => {
  assert.ok(!Array.isArray(RESERVED_URL_PARAMS), "a flat array silently empties the denylist");
  assert.ok(RESERVED_URL_PARAMS.query.length >= 4);
  assert.ok(RESERVED_URL_PARAMS.query.every((p) => isIgnoredQueryParam(p)));
  // The fragment half is ignored DEFENSIVELY too — a hand-moved snag_k must
  // not become page identity.
  assert.ok(RESERVED_URL_PARAMS.fragment.every((p) => isIgnoredQueryParam(p)));
});

test("The tracking shapes, spot-checked across all four regex groups", () => {
  for (const p of ["utm_source", "utm_campaign", "gclid", "fbclid", "mc_cid", "_hsenc", "_vercel_x", "__vercel_y", "_rsc"]) {
    assert.ok(isIgnoredQueryParam(p), p);
  }
  assert.ok(!isIgnoredQueryParam("variant"), "an ordinary param is NOT ignored");
  assert.ok(isIgnoredQueryParam("variant", ["variant"]), "…unless the config names it");
});

test("significantQuery: default policy strips EVERYTHING — query is undefined, not {}", () => {
  assert.equal(significantQuery("?variant=b&utm_source=x"), undefined);
  assert.equal(significantQuery(""), undefined);
});

test("significantQuery: a named list keeps only its members, minus the denylist", () => {
  const q = significantQuery("?variant=b&page=2&utm_source=x&snag_debug=1", {
    significantQueryParams: ["variant", "snag_debug"],
  });
  assert.deepEqual(q, { variant: "b" }, "snag_debug is reserved even when named significant");
});

test("significantQuery: '*' reproduces Vercel's exact-match minus reserved and tracking", () => {
  const q = significantQuery("?q=kiln&page=2&utm_source=x&snag_t=thr_1&snag_k=sec", {
    significantQueryParams: "*",
  });
  assert.deepEqual(q, { q: "kiln", page: "2" });
  assert.ok(!("snag_k" in (q ?? {})), "the hand-moved fragment secret never reaches PageRef.query");
});

test("queryMatches: both-undefined equal; a significant key must agree", () => {
  const policy = { significantQueryParams: ["variant"] as const };
  assert.ok(queryMatches(undefined, undefined, policy));
  assert.ok(queryMatches({ variant: "b" }, { variant: "b" }, policy));
  assert.ok(!queryMatches({ variant: "b" }, undefined, policy));
  assert.ok(!queryMatches({ variant: "b" }, { variant: "c" }, policy));
  // '*' compares the full kept set both ways.
  assert.ok(!queryMatches({ q: "a" }, { q: "a", page: "2" }, { significantQueryParams: "*" }));
});

/** A doc stub that serves one meta value. */
const docWith = (content: string | null): Document =>
  ({
    querySelector: () =>
      content === null ? null : ({ getAttribute: () => content } as unknown as Element),
    location: { pathname: "/products/red-widget" },
  }) as unknown as Document;

test("metaRoute: a hint, not a contract — malformed values vanish silently", () => {
  assert.equal(metaRoute(docWith("/products/[slug]")), "/products/[slug]");
  assert.equal(metaRoute(docWith("")), null, "empty");
  assert.equal(metaRoute(docWith("x".repeat(600))), null, "over 512 chars");
  assert.equal(metaRoute(docWith("products/[slug]")), null, "no leading slash");
  assert.equal(metaRoute(docWith(null)), null, "absent");
  assert.equal(metaRoute({} as Document), null, "a stub document cannot throw either");
});

test("the ladder: override beats meta beats pathname; null restores the fallback", () => {
  const doc = docWith("/products/[slug]");
  assert.equal(routeWithHint(doc, "/override/[id]"), "/override/[id]");
  assert.equal(routeWithHint(doc, null), "/products/[slug]");
  assert.equal(routeWithHint(docWith(null), null), "/products/red-widget");
});

test("derivePageRef carries the hint as route and the significant query, injected", () => {
  const loc = { pathname: "/products/red-widget", search: "?variant=b&utm_source=x", origin: "https://x.test" } as Location;
  const ref = derivePageRef(loc, {
    routeOverride: "/products/[slug]",
    query: { significantQueryParams: ["variant"] },
    doc: docWith(null),
  });
  assert.equal(ref.route, "/products/[slug]");
  assert.equal(ref.pathname, "/products/red-widget", "pathname stays the real one — the valve's key");
  assert.deepEqual(ref.query, { variant: "b" });
});

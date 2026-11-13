import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION } from "@snagset/types/names";
import { captureContext, derivePageRef } from "../src/capture/context.ts";

/**
 * The T0 snapshot.
 *
 * The design is a CLOSED type and validates "no extra keys and no null
 * values" — which is only enforceable because it is closed, so the key set is
 * asserted exactly rather than sampled.
 */

const PAGE = { route: "/pricing", pathname: "/pricing", origin: "https://kilnwork.test" };

/**
 * Just enough browser for twelve property reads.
 *
 * `defineProperty` throughout rather than assignment: Node defines
 * `globalThis.navigator` as a getter-only accessor, so `g.navigator = …` throws
 * outright.
 */
function stubEnv(over: Record<string, unknown> = {}): void {
  const set = (k: string, value: unknown): void =>
    void Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  set("location", { href: "https://kilnwork.test/pricing?tab=2", origin: PAGE.origin, pathname: "/pricing" });
  set("document", { URL: "https://kilnwork.test/pricing?tab=2", documentElement: { clientWidth: 1280, clientHeight: 860 } });
  set("innerWidth", 1280);
  set("innerHeight", 860);
  set("devicePixelRatio", 2);
  set("screen", { width: 1920, height: 1080 });
  set("navigator", {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    language: "en-GB",
  });
  for (const [k, v] of Object.entries(over)) set(k, v);
}

beforeEach(() => stubEnv());

test("the v0 key set is EXACTLY the twelve declares", () => {
  // AC the "no extra keys" clause. A stray field here is not cosmetic: it is a
  // 422 from the v1 validator against records written today.
  const ctx = captureContext({ page: PAGE });
  assert.deepEqual(Object.keys(ctx).sort(), [
    "capture",
    "derived",
    "language",
    "page",
    "prefersColorScheme",
    "schemaVersion",
    "screen",
    "timestamp",
    "ua",
    "url",
    "viewport",
  ]);
  // uaData is ABSENT, not undefined: "`—` means the field is omitted
  // (not null, not '')". On a non-Chromium browser there is no such key at all.
  assert.ok(!("uaData" in ctx));
  // And nothing v0.1 or v1 has crept in.
  for (const later of ["breadcrumbs", "build", "custom"]) assert.ok(!(later in ctx), later);
});

test("no value is null, anywhere", () => {
  const ctx = captureContext({ page: PAGE });
  const walk = (o: unknown, path = ""): void => {
    if (o === null) assert.fail(`null at ${path}`);
    if (typeof o === "object") {
      for (const [k, v] of Object.entries(o as object)) walk(v, `${path}.${k}`);
    }
  };
  walk(ctx);
});

test("THE URL IS REDACTED before it is ever stored", () => {
  // The design is the boundary rule: nothing reaches storage or a surface un-redacted.
  // This is the one v0 datum that carries page data, so it is the whole of the
  // capture module's exposure.
  stubEnv({
    location: {
      href: "https://kilnwork.test/reset?token=abc123def456&page=2#access_token=xyz789abcdef",
      origin: PAGE.origin,
      pathname: "/reset",
    },
  });
  const { url } = captureContext({ page: PAGE });
  assert.ok(!url.includes("abc123def456"), url);
  assert.ok(!url.includes("xyz789abcdef"), url);
  assert.match(url, /token=\[redacted\]/);
  assert.match(url, /#\[redacted\]/);
  // The parameter NAMES survive — the name alone is diagnostic.
  assert.match(url, /page=/);
});

test("The caps — pre-cap at 4096, post-cap at 2048 with the count", () => {
  const long = "https://kilnwork.test/x?q=" + "a".repeat(9000);
  stubEnv({ location: { href: long, origin: PAGE.origin, pathname: "/x" } });
  const { url } = captureContext({ page: PAGE });
  assert.ok(url.length <= 2048 + 12, `${url.length}`);
  // The truncation SAYS how much went, rather than reading like the URL itself.
  if (url.length > 2048) assert.match(url, /…\[\+\d+\]$/);
});

test("schemaVersion is the registry's constant, never re-spelled", () => {
  // AC H2: the literal has exactly one home, so a future rename moves it.
  assert.equal(captureContext({ page: PAGE }).schemaVersion, SCHEMA_VERSION);
});

test("viewport falls back to documentElement when the window reports 0", () => {
  // Some embedded webviews do exactly this.
  stubEnv({ innerWidth: 0, innerHeight: 0 });
  const { viewport } = captureContext({ page: PAGE });
  assert.deepEqual({ w: viewport.w, h: viewport.h }, { w: 1280, h: 860 });
});

test("dpr is stored RAW — rounding is the renderer's job", () => {
  stubEnv({ devicePixelRatio: 2.625 });
  assert.equal(captureContext({ page: PAGE }).viewport.dpr, 2.625);
});

test("screen access throwing yields {0,0} rather than taking the snapshot down", () => {
  stubEnv();
  Object.defineProperty(globalThis, "screen", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  assert.deepEqual(captureContext({ page: PAGE }).screen, { w: 0, h: 0 });
  Object.defineProperty(globalThis, "screen", {
    configurable: true,
    writable: true,
    value: { width: 1920, height: 1080 },
  });
});

test("uaData is a structured COPY, not the live object", () => {
  class NavigatorUAData {
    brands = [{ brand: "Chromium", version: "126", extra: "nope" }];
    platform = "macOS";
    mobile = false;
    getHighEntropyValues(): never {
      throw new Error("must never be called");
    }
  }
  stubEnv({
    navigator: { userAgent: "Mozilla/5.0 Chrome/126", language: "en", userAgentData: new NavigatorUAData() },
  });
  const ctx = captureContext({ page: PAGE });
  assert.ok(ctx.uaData);
  assert.equal(Object.getPrototypeOf(ctx.uaData.brands), Array.prototype);
  // The low-entropy triple ONLY — an extra field on the live object must not
  // ride along into storage.
  assert.deepEqual(ctx.uaData.brands, [{ brand: "Chromium", version: "126" }]);
  assert.deepEqual(Object.keys(ctx.uaData).sort(), ["brands", "mobile", "platform"]);
});

test("prefersColorScheme falls back to light with no matchMedia", () => {
  assert.equal(typeof (globalThis as { matchMedia?: unknown }).matchMedia, "undefined");
  assert.equal(captureContext({ page: PAGE }).prefersColorScheme, "light");
});

test("capture says BOTH categories are off, in sentences", () => {
  // Both 'disabled', reasons[] non-empty.: "entries are
  // sentences, not codes" and they are rendered verbatim to the reviewer.
  // Now the breadcrumb sentence describes an OFF category rather than
  // an unbuilt feature — with no crumbs input, disabled is still the truth.
  const { capture } = captureContext({ page: PAGE });
  assert.equal(capture?.screenshot, "disabled");
  assert.equal(capture?.breadcrumbs, "disabled");
  assert.deepEqual(capture?.reasons, [
    "Screenshots are not available in this release.",
    "Console and network capture is off for this project.",
  ]);
  for (const r of capture!.reasons!) assert.match(r, /\.$/, "punctuation normalised across both");
  // The v0.1/v1 fields are omitted, not empty — again.
  for (const later of ["blindSpots", "droppedCategories", "maskedCount"]) {
    assert.ok(!(later in capture!), later);
  }
});

test("breadcrumbs ride the context when the crumbs chunk supplied them", () => {
  const records = [
    { t: new Date().toISOString(), type: "console" as const, level: "error" as const, message: "boom" },
  ];
  const ctx = captureContext({ page: PAGE, breadcrumbs: { records, status: "ok" } });
  assert.deepEqual(ctx.breadcrumbs, records);
  assert.equal(ctx.capture?.breadcrumbs, "ok");
  // 'ok' needs no excuse: reasons carry sentences for what DIDN'T run.
  assert.deepEqual(ctx.capture?.reasons, ["Screenshots are not available in this release."]);

  const truncated = captureContext({ page: PAGE, breadcrumbs: { records, status: "truncated" } });
  assert.equal(truncated.capture?.breadcrumbs, "truncated");
  assert.ok(truncated.capture?.reasons?.some((r) => /dropped/.test(r)));
});

test("derivePageRef is pathname-only at v0, and origin is display-only", () => {
  // "In v0 only normalisePath runs; query is undefined, route is the
  // normalised pathname."
  const ref = derivePageRef({ pathname: "/pricing", origin: PAGE.origin } as Location);
  assert.deepEqual(ref, { route: "/pricing", pathname: "/pricing", origin: PAGE.origin });
  assert.ok(!("query" in ref));
});

test("the whole snapshot is well under 2 ms", () => {
  // The budget. It is twelve property reads and one regex pass, and it
  // runs on the click — between the reviewer pointing and the composer opening.
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) captureContext({ page: PAGE });
  assert.ok((performance.now() - t0) / 50 < 2);
});

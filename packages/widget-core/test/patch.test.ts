import { test } from "node:test";
import assert from "node:assert/strict";
import { wrap } from "../src/patch.ts";
import { SYMBOL_KEY } from "@snagset/types/names";

/**
 * The five registry properties, each of which a breadcrumb failure
 * mode depends on (the table). These are unit tests because every one of
 * them is about function identity and property mechanics — the co-existence
 * E2E proves the same protocol against a Sentry-shaped stranger, but when THAT
 * fails you want these to say which property broke.
 */

interface Host {
  fn: (n: number) => number;
}
const makeHost = (): Host => ({ fn: (n: number) => n * 2 });

test("P2 — call-through: the wrapper returns the original's result unchanged", () => {
  const host = makeHost();
  const seen: number[] = [];
  wrap(host, "fn", (prev) => (n: number) => {
    const r = (prev as (n: number) => number)(n);
    seen.push(n);
    return r;
  });
  assert.equal(host.fn(21), 42);
  assert.deepEqual(seen, [21]);
});

test("P1 — idempotent: wrapping our own wrapper is a no-op with a no-op unwrapper", () => {
  const host = makeHost();
  let calls = 0;
  wrap(host, "fn", (prev) => (n: number) => {
    calls++;
    return (prev as (n: number) => number)(n);
  });
  const top = host.fn;
  // A second copy of the module (stub, runtime and crumbs each bundle
  // one) sees the registered symbol and declines.
  const un2 = wrap(host, "fn", (prev) => (n: number) => {
    calls += 100;
    return (prev as (n: number) => number)(n);
  });
  assert.equal(host.fn, top, "second wrap must not replace the first");
  host.fn(1);
  assert.equal(calls, 1, "the recorder must fire exactly once");
  un2();
  assert.equal(host.fn, top, "the no-op unwrapper must not unwind the real wrapper");
});

test("P3 — name and length are preserved on the wrapper", () => {
  const host = { fn: function report(_a: string, _b: string) {} };
  wrap(host, "fn", (prev) => (...args: unknown[]) => (prev as (...a: unknown[]) => unknown)(...args));
  assert.equal(host.fn.name, "report");
  assert.equal(host.fn.length, 2);
});

test("P4 row 1 — still on top at unwrap: full unwind to the original", () => {
  const host = makeHost();
  const original = host.fn;
  const un = wrap(host, "fn", (prev) => (n: number) => (prev as (n: number) => number)(n) + 1);
  assert.equal(host.fn(1), 3);
  un();
  assert.equal(host.fn, original, "identity restore, not a new function");
  assert.equal(host.fn(1), 2);
});

test("P4 row 2 — someone wrapped on top: neutralise, never restore", () => {
  const host = makeHost();
  let recorded = 0;
  const un = wrap(host, "fn", (prev) => (n: number) => {
    recorded++;
    return (prev as (n: number) => number)(n);
  });
  // A Sentry-shaped stranger wraps AFTER us, capturing our wrapper as its prev.
  const ourWrapper = host.fn;
  let theirs = 0;
  host.fn = (n: number) => {
    theirs++;
    return ourWrapper(n);
  };
  un();
  assert.notEqual(host.fn, ourWrapper, "their wrapper must survive our teardown");
  const out = host.fn(5);
  assert.equal(out, 10, "the chain still works end to end");
  assert.equal(theirs, 1, "the later patcher still receives every call");
  assert.equal(recorded, 0, "ours is a pure pass-through once neutralised");
});

test("P4 row 3 — host nuked the slot: unwrap does nothing", () => {
  const host = makeHost();
  const un = wrap(host, "fn", (prev) => (n: number) => (prev as (n: number) => number)(n));
  (host as unknown as Record<string, unknown>).fn = "not a function";
  un();
  assert.equal(host.fn as unknown, "not a function");
});

test("P5 — a frozen owner is a silent skip, and a non-function target is left alone", () => {
  const frozen = Object.freeze(makeHost());
  const before = frozen.fn;
  assert.doesNotThrow(() => wrap(frozen, "fn", (prev) => prev)());
  assert.equal(frozen.fn, before);

  const empty = {} as Host;
  assert.doesNotThrow(() => wrap(empty, "fn", (prev) => prev)());
  assert.equal(empty.fn, undefined);
});

test("the wrapper carries the registered symbols — the cross-copy contract", () => {
  const host = makeHost();
  const original = host.fn;
  wrap(host, "fn", (prev) => prev);
  const w = host.fn as unknown as Record<symbol, unknown>;
  assert.equal(w[Symbol.for(SYMBOL_KEY.wrapped)], true);
  assert.equal(w[Symbol.for(SYMBOL_KEY.original)], original);
});

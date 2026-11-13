import { test } from "node:test";
import assert from "node:assert/strict";
import { storageKey } from "@snagset/types/names";
import { takeHandoff, writeHandoff } from "../src/runtime/jump.ts";

/**
 * The cross-route handoff.
 *
 * The scroll half of jump.ts needs a real layout engine and is proven in
 * e2e/live.spec.ts. This covers the half that is pure state — and the half whose
 * failure is silent, because a handoff that never clears springs a panel open on
 * every subsequent load with nothing to explain it.
 */

function fakeWindow(store: Map<string, string> | null): Window {
  const sessionStorage = store
    ? {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      }
    : new Proxy(
        {},
        {
          get() {
            // Safari private mode, or a third-party-cookie block.
            throw new Error("storage disabled");
          },
        },
      );
  return { sessionStorage } as unknown as Window;
}

test("a handoff round-trips under the REGISTERED key", () => {
  const store = new Map<string, string>();
  writeHandoff(fakeWindow(store), "thr_abc");
  // Not a hand-typed "snag:handoff": the registry owns the spelling, and this is
  // the assertion that would fail if the key were minted here instead.
  assert.ok(store.has(storageKey.handoff));
  assert.equal(takeHandoff(fakeWindow(store)), "thr_abc");
});

test("it is CONSUMED — reading it once empties it", () => {
  const store = new Map<string, string>();
  writeHandoff(fakeWindow(store), "thr_abc");
  const win = fakeWindow(store);
  assert.equal(takeHandoff(win), "thr_abc");
  assert.equal(takeHandoff(win), null, "a second load must not reopen the same detail");
  assert.equal(store.size, 0);
});

test("no handoff is not an error — it is the ordinary case", () => {
  assert.equal(takeHandoff(fakeWindow(new Map())), null);
});

test("a corrupt handoff is cleared as well as ignored", () => {
  // Cleared BEFORE it is parsed, deliberately. Parsed first, a bad entry would
  // throw on the way out, stay in storage, and throw again on every load for the
  // rest of the session.
  const store = new Map([[storageKey.handoff, "{not json"]]);
  assert.equal(takeHandoff(fakeWindow(store)), null);
  assert.equal(store.size, 0, "and cannot wedge every subsequent load");
});

test("a handoff with the wrong SHAPE is ignored", () => {
  const store = new Map([[storageKey.handoff, JSON.stringify({ openThreadId: 42 })]]);
  assert.equal(takeHandoff(fakeWindow(store)), null);
});

test("storage being disabled costs the handoff, never the navigation", () => {
  // Its absence must land on the list, never on a blank dock — so writing
  // must not throw into the caller, which is about to change the location.
  assert.doesNotThrow(() => writeHandoff(fakeWindow(null), "thr_abc"));
  assert.equal(takeHandoff(fakeWindow(null)), null);
});

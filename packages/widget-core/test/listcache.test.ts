import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readList, writeList, dropList } from "../src/storage/listcache.ts";
import { storageKey, STORAGE_KEY_PATTERNS } from "@snagset/types/names";
import type { Snag } from "../src/storage/types.ts";

/**
 * `snag:list:<uid>:<class>` — the stale-while-revalidate copy of the thread
 * list. What it must never do is the point of these tests: show a member's
 * list to a guest, outlive the store its credential lives in, grow without
 * bound, trust a shape it did not write, or throw on a page that is not ours.
 */

function fakeStorage(opts: { throws?: boolean } = {}) {
  const map = new Map<string, string>();
  const boom = (): never => {
    throw Object.assign(new Error("denied"), { name: "SecurityError" });
  };
  return {
    map,
    store: {
      getItem: (k: string) => (opts.throws ? boom() : (map.get(k) ?? null)),
      setItem: (k: string, v: string) => (opts.throws ? boom() : void map.set(k, v)),
      removeItem: (k: string) => (opts.throws ? boom() : void map.delete(k)),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage,
  };
}

let local: ReturnType<typeof fakeStorage>;
let session: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  local = fakeStorage();
  session = fakeStorage();
  globalThis.localStorage = local.store;
  globalThis.sessionStorage = session.store;
});

const snag = (id: string, body = "x"): Snag =>
  ({
    id,
    key: "SN-1",
    route: "/",
    anchor: { label: "a button" },
    anchorState: "anchored",
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: { id: "rev_1", name: "Ada", kind: "guest" },
    comments: [{ id: `c_${id}`, body, createdAt: "2026-01-01T00:00:00.000Z", author: { id: "rev_1", name: "Ada" } }],
  }) as unknown as Snag;

test("round trip per env/round slot", () => {
  writeList("prj", "guest", "staging:3", [snag("a")]);
  writeList("prj", "guest", "staging:2", [snag("b")]);
  assert.deepEqual(readList("prj", "guest", "staging:3")?.map((s) => s.id), ["a"]);
  assert.deepEqual(readList("prj", "guest", "staging:2")?.map((s) => s.id), ["b"]);
  assert.equal(readList("prj", "guest", "staging:1"), null);
  assert.equal(readList("other", "guest", "staging:3"), null, "per project");
});

test("an empty round is cached as empty, not as missing", () => {
  writeList("prj", "guest", ":3", []);
  assert.deepEqual(readList("prj", "guest", ":3"), []);
});

test("class separation: a member's list is in localStorage, a guest's in sessionStorage, and neither reads the other", () => {
  writeList("prj", "member", ":3", [snag("private")]);
  assert.ok(local.map.has(storageKey.list("prj", "member")));
  assert.equal(session.map.size, 0, "a member's list never lands in the guest's store");
  assert.equal(readList("prj", "guest", ":3"), null, "a guest never sees a member's copy");

  writeList("prj", "guest", ":3", [snag("public")]);
  assert.ok(session.map.has(storageKey.list("prj", "guest")));
  assert.deepEqual(readList("prj", "member", ":3")?.map((s) => s.id), ["private"]);
  assert.deepEqual(readList("prj", "guest", ":3")?.map((s) => s.id), ["public"]);
});

test("dropList forgets one class only, every slot of it", () => {
  writeList("prj", "member", ":3", [snag("a")]);
  writeList("prj", "member", ":2", [snag("b")]);
  writeList("prj", "guest", ":3", [snag("c")]);
  dropList("prj", "member");
  assert.equal(readList("prj", "member", ":3"), null);
  assert.equal(readList("prj", "member", ":2"), null);
  assert.deepEqual(readList("prj", "guest", ":3")?.map((s) => s.id), ["c"]);
});

test("size cap: a write past 1 MB is skipped, and the stale copy goes with it", () => {
  writeList("prj", "guest", ":3", [snag("small")]);
  writeList("prj", "guest", ":3", [snag("huge", "z".repeat(1_100_000))]);
  assert.equal(session.map.has(storageKey.list("prj", "guest")), false, "a stale copy must not stand in for an unstorable one");
  assert.equal(readList("prj", "guest", ":3"), null);

  // Two slots that only overflow together: the key resets, and the next
  // write starts from empty rather than staying wedged over the cap.
  const big = "y".repeat(600_000);
  writeList("prj", "guest", ":2", [snag("old", big)]);
  writeList("prj", "guest", ":3", [snag("new", big)]);
  assert.equal(readList("prj", "guest", ":2"), null);
  writeList("prj", "guest", ":3", [snag("next")]);
  assert.deepEqual(readList("prj", "guest", ":3")?.map((s) => s.id), ["next"]);
  assert.ok(session.map.get(storageKey.list("prj", "guest"))!.length < 1_000_000);
});

test("a version it did not write is ignored, and so is garbage", () => {
  session.map.set(storageKey.list("prj", "guest"), JSON.stringify({ v: 2, m: { ":3": [snag("a")] } }));
  assert.equal(readList("prj", "guest", ":3"), null);
  session.map.set(storageKey.list("prj", "guest"), "{not json");
  assert.equal(readList("prj", "guest", ":3"), null);
  session.map.set(storageKey.list("prj", "guest"), JSON.stringify({ v: 1, m: { ":3": "nope" } }));
  assert.equal(readList("prj", "guest", ":3"), null);
  // …and a write over garbage starts over rather than failing.
  session.map.set(storageKey.list("prj", "guest"), "{not json");
  writeList("prj", "guest", ":3", [snag("a")]);
  assert.deepEqual(readList("prj", "guest", ":3")?.map((s) => s.id), ["a"]);
});

test("storage that throws on every access never throws out of the cache", () => {
  globalThis.localStorage = fakeStorage({ throws: true }).store;
  globalThis.sessionStorage = fakeStorage({ throws: true }).store;
  assert.doesNotThrow(() => writeList("prj", "member", ":3", [snag("a")]));
  assert.doesNotThrow(() => writeList("prj", "guest", ":3", [snag("a")]));
  assert.equal(readList("prj", "member", ":3"), null);
  assert.equal(readList("prj", "guest", ":3"), null);
  assert.doesNotThrow(() => dropList("prj", "member"));
});

test("the key is registered — the diff accepts it", () => {
  const k = storageKey.list("prj_demo", "guest");
  assert.equal(k, "snag:list:prj_demo:guest");
  assert.ok(STORAGE_KEY_PATTERNS.some((p) => new RegExp(p).test(k)));
});

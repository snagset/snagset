import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFilter, writeFilter } from "../src/storage/filterstore.ts";
import { defaultFilter, type ListFilter } from "../src/storage/filter.ts";
import { storageKey, STORAGE_KEY_PATTERNS } from "@snagset/types/names";

/**
 * `snag:filter:<uid>:<env>` — the filter carried across document loads
 * in one tab. What these tests hold it to: it round-trips what an SPA
 * navigation would have kept, it drops `newOnly`, and anything it did not
 * write (garbage, another version, a field of the wrong type, a store that
 * throws) reads as the default rather than reaching pinPass.
 */

function fakeStorage(throws = false) {
  const map = new Map<string, string>();
  const boom = (): never => {
    throw Object.assign(new Error("denied"), { name: "SecurityError" });
  };
  return {
    map,
    store: {
      getItem: (k: string) => (throws ? boom() : (map.get(k) ?? null)),
      setItem: (k: string, v: string) => (throws ? boom() : void map.set(k, v)),
      removeItem: (k: string) => (throws ? boom() : void map.delete(k)),
    } as unknown as Storage,
  };
}

let session: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  session = fakeStorage();
  globalThis.sessionStorage = session.store;
  // A local write would outlive the tab: the filter must never land there.
  globalThis.localStorage = fakeStorage(true).store;
});

const KEY = storageKey.filter("prj", "default");

test("the key is registered, per project and env — the diff accepts it", () => {
  assert.equal(KEY, "snag:filter:prj:default");
  assert.ok(STORAGE_KEY_PATTERNS.some((p) => new RegExp(p).test(KEY)));
});

test("nothing stored reads as null (the caller falls back to the defaults)", () => {
  assert.equal(readFilter("prj", "default"), null);
});

test("round-trips every carried facet, and never newOnly", () => {
  const f: ListFilter = {
    statuses: ["open", "review"],
    read: "unread",
    by: "rev_a",
    assignee: "rev_b",
    page: "/a",
    q: "hero",
    pageOnly: true,
    newOnly: true,
    sort: "newest",
  };
  writeFilter("prj", "default", f);
  const raw = JSON.parse(session.map.get(KEY)!);
  assert.equal(raw.v, 1);
  assert.equal("newOnly" in raw, false);
  assert.deepEqual(readFilter("prj", "default"), { ...f, newOnly: false });
  // Unassigned is null, and null survives JSON.
  writeFilter("prj", "default", { ...defaultFilter(), assignee: null });
  assert.equal(readFilter("prj", "default")!.assignee, null);
  // Another project or env is another key.
  assert.equal(readFilter("prj", "staging"), null);
  assert.equal(readFilter("other", "default"), null);
});

test("garbage is ignored: not JSON, not an object, or the wrong version", () => {
  for (const bad of ["{", "null", "42", '"x"', "[]", JSON.stringify({ statuses: ["open"] }), JSON.stringify({ v: 2, statuses: ["open"] })]) {
    session.map.set(KEY, bad);
    assert.equal(readFilter("prj", "default"), null, bad);
  }
});

test("a field that does not validate falls back to its default; the rest still apply", () => {
  session.map.set(
    KEY,
    JSON.stringify({
      v: 1,
      statuses: ["open", "nonsense", 3],
      read: "sideways",
      sort: { evil: true },
      pageOnly: "yes",
      by: 7,
      page: "",
      q: ["x"],
      assignee: 0,
    }),
  );
  const f = readFilter("prj", "default")!;
  assert.deepEqual(f, { ...defaultFilter(), statuses: ["open"] });
  assert.equal("assignee" in f, false);
  // No valid status at all is "every status", never an empty filter.
  session.map.set(KEY, JSON.stringify({ v: 1, statuses: ["nope"], q: "kept" }));
  assert.deepEqual(readFilter("prj", "default"), { ...defaultFilter(), q: "kept" });
});

test("a store that throws reads as null and writes nothing, without throwing", () => {
  globalThis.sessionStorage = fakeStorage(true).store;
  assert.equal(readFilter("prj", "default"), null);
  assert.doesNotThrow(() => writeFilter("prj", "default", defaultFilter()));
  // And with no sessionStorage at all (a sandboxed frame).
  delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  assert.equal(readFilter("prj", "default"), null);
  assert.doesNotThrow(() => writeFilter("prj", "default", defaultFilter()));
});

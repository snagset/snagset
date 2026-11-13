import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSeenStore } from "../src/storage/seen.ts";
import { createLocalAdapter } from "../src/storage/local.ts";
import type { CreateThreadRequest, Snag } from "../src/storage/types.ts";

/**
 * The storage half.
 *
 * The claim worth testing hardest is the one the design was changed FOR: this
 * store must not be able to reach the threads key. Read-state is cosmetic;
 * the reviewer's comments are not, and an earlier version of this feature kept
 * both in one array.
 */

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

const THREADS = "snag:threads:local:default";
const SEEN = "snag:seen:local:default";

beforeEach(() => {
  globalThis.localStorage = fakeStorage();
});

const req = (id: string): CreateThreadRequest => ({
  route: "/",
  anchor: { label: `el ${id}`, domid: id },
  comment: { body: `note ${id}` },
  author: { id: "rev_ada", name: "Ada", kind: "guest" },
});

test("read-state cannot touch the threads key, in either direction", async () => {
  const adapter = createLocalAdapter("local", "default");
  await adapter.createThread(req("a"));
  const before = localStorage.getItem(THREADS);

  const seen = createSeenStore("local", "default", () => 1000);
  seen.mark("thr_x");
  seen.markAll([{ id: "thr_y" }] as Snag[]);

  assert.equal(localStorage.getItem(THREADS), before, "threads byte-identical after marking");
  assert.deepEqual(JSON.parse(localStorage.getItem(SEEN)!), { thr_x: 1000, thr_y: 1000 });

  // …and the adapter's own writes leave the seen key alone.
  await adapter.createThread(req("b"));
  assert.deepEqual(JSON.parse(localStorage.getItem(SEEN)!), { thr_x: 1000, thr_y: 1000 });
});

test("the threads key is NOT created as a side effect of marking", () => {
  // The race this removes: marking your own new thread seen happens at
  // creation, so a shared key sprang into existence holding no threads, and
  // anything waiting on "the key exists" read an empty round.
  createSeenStore("local", "default").mark("thr_a");
  assert.equal(localStorage.getItem(THREADS), null);
});

test("both levels of seen: one thread, then everything", () => {
  let clock = 500;
  const seen = createSeenStore("local", "default", () => clock);
  const snags = [{ id: "a" }, { id: "b" }, { id: "c" }] as Snag[];

  seen.mark("b");
  assert.deepEqual([...seen.map().keys()], ["b"], "opening one detail marks only that one");

  clock = 900;
  seen.markAll(snags);
  assert.deepEqual(
    [...seen.map().entries()].sort(),
    [["a", 900], ["b", 900], ["c", 900]],
    "closing the dock marks everything, including the one already read",
  );
});

test("it survives a reload, and reads back through a cold store", () => {
  createSeenStore("local", "default", () => 42).mark("thr_a");
  assert.equal(createSeenStore("local", "default").map().get("thr_a"), 42);
});

test("a corrupt or hostile value degrades to EVERYTHING UNREAD, and never throws", () => {
  for (const junk of ['{not json', '[]', '"a string"', "null"]) {
    localStorage.setItem(SEEN, junk);
    const seen = createSeenStore("local", "default");
    assert.deepEqual([...seen.map().keys()], [], `"${junk}" reads as nothing seen`);
    assert.doesNotThrow(() => seen.mark("a"), `"${junk}" is writable over`);
  }
});

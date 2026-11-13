import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeCounts, readCounts, badgeFor } from "../src/storage/counts.ts";
import type { Snag } from "../src/storage/types.ts";

/**
 * `snag:counts:<origin>` — the whole of the dormant badge.
 *
 * A returning reviewer sees the unresolved count before the runtime has
 * loaded, from a local read. The alternative that was deleted — a count query
 * from the stub — would have pinged the review host from every visitor's
 * browser on every page load. So the cache is not an optimisation; it is what
 * makes the zero-network rule survivable.
 */

function fakeStorage(opts: { full?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.full) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  globalThis.localStorage = fakeStorage();
});

const snag = (route: string, status: Snag["status"] = "open", id = Math.random().toString()): Snag => ({
  id,
  key: "SN-1",
  route,
  anchor: { label: "a button" },
  anchorState: "anchored",
  status,
  comments: [],
  createdBy: { id: "rev_local", name: "Edith", kind: "guest" },
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
});

test("the shape is the, exactly", () => {
  const c = writeCounts("https://example.com", [snag("/a"), snag("/a"), snag("/b")], "/a")!;
  assert.equal(c.v, 1);
  assert.equal(c.p, 3, "project-wide open count");
  assert.equal(c.r["/a"], 2, "per-route, keyed by route");
  assert.match(c.t, /^\d{4}-\d{2}-\d{2}T/);
});

test("RESOLVED is not counted — a badge means work waiting", () => {
  const all = [snag("/a"), snag("/a", "resolved"), snag("/a", "progress")];
  const c = writeCounts("https://example.com", all, "/a")!;
  assert.equal(c.p, 2);
  assert.equal(c.r["/a"], 2);
});

test("every route the adapter holds is cached, not just the one on screen", () => {
  // The runtime renders one route at a time, but the cache is per ORIGIN —
  // that is what lets the stub badge /pricing on a visit that starts at /.
  const c = writeCounts("https://example.com", [snag("/a"), snag("/b"), snag("/b")], "/a")!;
  assert.equal(c.r["/a"], 1);
  assert.equal(c.r["/b"], 2, "a route we are not looking at is still counted");
});

test("the current route is cached even with nothing on it", () => {
  const c = writeCounts("https://example.com", [snag("/a")], "/b")!;
  assert.equal(c.r["/b"], 0, "\"none here\" is a fact; absence would read as \"not visited\"");
});

test("capped at 64 routes, dropping the least recently seen", () => {
  const origin = "https://example.com";
  const many = Array.from({ length: 70 }, (_, i) => snag(`/r${i}`));
  const c = writeCounts(origin, many, "/r69")!;
  assert.equal(Object.keys(c.r).length, 64);
  assert.ok("/r69" in c.r, "the route being viewed always survives the trim");
});

test("over 4 KB the per-route map is DROPPED and the project count kept", () => {
  // A truncated map would be quietly wrong for whichever routes fell off; a
  // project-wide number is still a true number.
  const origin = "https://example.com";
  const long = "/" + "x".repeat(300);
  const many = Array.from({ length: 40 }, (_, i) => snag(`${long}${i}`));
  const c = writeCounts(origin, many, `${long}0`)!;
  assert.deepEqual(c.r, {});
  assert.equal(typeof c.p, "number");
});

test("a missing key, garbage, or a version we do not know reads as NO badge", () => {
  // This runs on a stranger's page against data an older or newer build wrote.
  assert.equal(readCounts("https://example.com"), null);

  localStorage.setItem("snag:counts:https://example.com", "not json");
  assert.equal(readCounts("https://example.com"), null);

  localStorage.setItem("snag:counts:https://example.com", JSON.stringify({ v: 99, p: 4 }));
  assert.equal(readCounts("https://example.com"), null, "an unknown schema is not guessed at");
});

test("a full disk loses the badge and NOTHING else", () => {
  // Unlike a thread write, this one is silent by design: the badge is a
  // nicety, and a warning about it would be noise in a client's console.
  globalThis.localStorage = fakeStorage({ full: true });
  assert.equal(writeCounts("https://example.com", [snag("/a")], "/a"), null);
});

test("badgeFor: an unvisited route is 0, not undefined", () => {
  const c = writeCounts("https://example.com", [snag("/a")], "/a");
  assert.equal(badgeFor(c, "/a"), 1);
  assert.equal(badgeFor(c, "/never-seen"), 0);
  assert.equal(badgeFor(null, "/a"), 0, "first visit: no cache, no badge — correct, not degraded");
});

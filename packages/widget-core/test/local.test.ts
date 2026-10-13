import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createLocalAdapter, storageWorks } from "../src/storage/local.ts";
import { newCommentId, newThreadId, uuidv7 } from "../src/storage/ids.ts";
import {
  AdapterError,
  threadFromRequest,
  type CreateThreadRequest,
  type Reviewer,
} from "../src/storage/types.ts";

/**
 * The local adapter against the interface.
 *
 * These assertions are about the BOUNDARY, not about localStorage: what makes
 * v1's HTTP adapter a swap rather than a rewrite is that the runtime only ever
 * speaks these methods, in these shapes. An earlier version shipped a
 * two-method `load()`/`save()` pair invented in code — this file is what stops
 * that happening quietly again.
 */

const WHO: Reviewer = { id: "rev_local", name: "Edith", kind: "guest" };

/** Minimal in-memory localStorage — the tests are about the adapter, not the DOM. */
function fakeStorage(opts: { full?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.full) {
        const e = new Error("quota");
        e.name = "QuotaExceededError";
        throw e;
      }
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

const thread = (over: Partial<CreateThreadRequest> = {}): CreateThreadRequest => ({
  id: "thr_1",
  key: "SN-1",
  route: "/pricing",
  anchor: { label: 'Button "Get started"' },
  anchorState: "anchored",
  createdBy: WHO,
  // Deliberately long past. A fixture stamped "today at 09:00" compares as
  // NEWER than `new Date()` whenever the suite runs before 09:00 UTC, so the
  // updatedAt assertion below failed by time of day rather than by behaviour.
  createdAt: "2020-01-01T00:00:00.000Z",
  ...over,
});

test("capabilities and optional methods AGREE — the design requires it", () => {
  // "A missing `uploadAttachment` and `attachments: 'none'` must agree, and a
  // CI test asserts they do." A capability that lies is worse than one that
  // says no: the UI renders from this, so a false `direct` renders a button
  // that fails when pressed.
  const a = createLocalAdapter("local", "default");
  // v0.1: the blob store exists, so the capability says so and the
  // method is present — the same agreement, new truth.
  assert.equal(a.capabilities.attachments, "direct");
  assert.equal(typeof a.uploadAttachment, "function");
  assert.equal(a.capabilities.assignees, false);
  assert.equal(a.listAssignees, undefined);
  assert.equal(a.capabilities.anchorReports, false);
  assert.equal(a.reportAnchors, undefined);
  // One localStorage origin still cannot keep a secret.
  assert.equal(a.capabilities.privateThreads, false, "one localStorage origin cannot keep a secret");
});

test("createThread mints the first comment in the same call, as endpoint 6 does", async () => {
  const a = createLocalAdapter("local", "default");
  const t = await a.createThread(thread({ comment: { id: "cmt_1", body: "wrong label", author: WHO } }));
  assert.equal(t.comments.length, 1);
  assert.equal(t.comments[0]!.body, "wrong label");
  assert.equal(t.comments[0]!.snagId, t.id, "the comment knows its thread");
  assert.equal(t.status, "open");
});

test("a thread with no comment is legal — the composer can be cancelled", async () => {
  const a = createLocalAdapter("local", "default");
  const t = await a.createThread(thread());
  assert.deepEqual(t.comments, []);
});

test("listThreads filters by route and status, and reports a server time", async () => {
  const a = createLocalAdapter("local", "default");
  await a.createThread(thread({ id: "thr_1", route: "/a" }));
  await a.createThread(thread({ id: "thr_2", route: "/b" }));
  await a.patchThread("thr_2", { status: "resolved" });

  assert.equal((await a.listThreads()).data.length, 2);
  assert.equal((await a.listThreads({ route: "/a" })).data.length, 1);
  assert.equal((await a.listThreads({ status: ["resolved"] })).data[0]!.id, "thr_2");
  assert.match((await a.listThreads()).serverTime, /^\d{4}-\d{2}-\d{2}T/);
  // One browser writes this store, so there is never a page 2 and never a
  // delete somebody else made.
  assert.equal((await a.listThreads()).nextCursor, undefined);
});

test("patchThread touches updatedAt and leaves unmentioned fields alone", async () => {
  const a = createLocalAdapter("local", "default");
  const before = await a.createThread(thread({ comment: { id: "c", body: "b", author: WHO } }));
  const after = await a.patchThread("thr_1", { status: "progress" });
  assert.equal(after!.status, "progress");
  assert.equal(after!.comments.length, 1, "a status patch must not touch the thread");
  assert.equal(after!.key, before.key);
  assert.ok(after!.updatedAt >= before.updatedAt);
});

test("a patch carrying undefined does NOT blank the field", async () => {
  // The difference between "absent" and "present but undefined" is the whole
  // semantics of PATCH, and a spread would happily write the undefined through.
  const a = createLocalAdapter("local", "default");
  await a.createThread(thread());
  const after = await a.patchThread("thr_1", { status: undefined, anchorState: "orphaned" });
  assert.equal(after!.status, "open");
  assert.equal(after!.anchorState, "orphaned");
});

test("comments: create, patch, delete", async () => {
  const a = createLocalAdapter("local", "default");
  await a.createThread(thread());
  const c = await a.createComment("thr_1", { id: "cmt_9", body: "first", author: WHO });
  assert.equal(c!.body, "first");

  const edited = await a.patchComment("cmt_9", "second");
  assert.equal(edited!.body, "second");
  assert.equal((await a.getThread("thr_1"))!.comments[0]!.body, "second");

  await a.deleteComment("cmt_9");
  assert.deepEqual((await a.getThread("thr_1"))!.comments, []);
});

test("writes to a thread that is gone return null rather than throwing", async () => {
  const a = createLocalAdapter("local", "default");
  assert.equal(await a.getThread("nope"), null);
  assert.equal(await a.patchThread("nope", { status: "open" }), null);
  assert.equal(await a.createComment("nope", { id: "c", body: "b", author: WHO }), null);
  await a.deleteThread("nope"); // no-op, no throw
});

test("QUOTA IS LOUD — it never silently drops a thread", async () => {
  globalThis.localStorage = fakeStorage({ full: true });
  const a = createLocalAdapter("local", "default");
  await assert.rejects(
    () => a.createThread(thread()),
    (e: unknown) => e instanceof AdapterError && e.code === "local_quota_exceeded",
  );
  // The code is client-side and never crosses the wire.
});

test("storage being unavailable degrades to a working, non-persisting widget", async () => {
  // Private-mode Safari and partitioned iframes throw on ACCESS, which is a
  // different failure from a full disk: nothing was going to persist anyway,
  // so it must not throw in the reviewer's face.
  globalThis.localStorage = new Proxy({} as Storage, {
    get() {
      throw new Error("SecurityError");
    },
  });
  const a = createLocalAdapter("local", "default");
  assert.deepEqual((await a.listThreads()).data, []);
});

test("garbage written by another version degrades to no snags, not a crash", async () => {
  const a = createLocalAdapter("local", "default");
  localStorage.setItem("snag:threads:local:default", '[{"garbage":true},"not an object",null]');
  assert.deepEqual((await a.listThreads()).data, []);
});

test("a record without anchor.label is refused — it cannot do its job", async () => {
  // /R5: in annotation mode the derived label is the ENTIRE fallback for
  // an orphaned snag. A record without one would render a pin that cannot say
  // what it pointed at.
  const a = createLocalAdapter("local", "default");
  localStorage.setItem(
    "snag:threads:local:default",
    JSON.stringify([{ id: "x", key: "SN-1", route: "/", anchor: {}, comments: [] }]),
  );
  assert.deepEqual((await a.listThreads()).data, []);
});

test("the stored thread is IDENTICAL to the one built from the same request", async () => {
  // The runtime paints an optimistic copy built from the same request, so if
  // the two were built independently they could differ — and the difference
  // would only surface after a reload, which is the worst place to find it.
  const req = thread({ comment: { id: "cmt_1", body: "b", author: WHO } });
  const a = createLocalAdapter("local", "default");
  assert.deepEqual(await a.createThread(req), threadFromRequest(req));
});

test("ids are the v1 wire form, so first sync does not have to re-key", () => {
  // The first version minted `thr_${ISO}_${performance.now()}` — carrying `:`,
  // `.` and `Z`, which a server strict about its id alphabet rejects, defeating
  // the only reason to mint client-side at all.
  const id = newThreadId();
  assert.match(id, /^thr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(newCommentId(), /^cmt_/);
});

test("ids do not collide within a millisecond", () => {
  // `cmt_${Date.now()}` did. Comment ids are matched GLOBALLY across threads by
  // patchComment/deleteComment, so a collision meant editing one comment
  // silently edited another thread's.
  const ids = new Set(Array.from({ length: 2000 }, () => newCommentId()));
  assert.equal(ids.size, 2000);
});

test("uuidv7 is time-ordered, which is why it is v7 and not v4", () => {
  const a = uuidv7();
  const b = uuidv7();
  // Same millisecond or later — the 48-bit prefix must never go backwards.
  assert.ok(a.slice(0, 8) <= b.slice(0, 8));
});

test("init reports v0.1's truth — local screenshots on, the WIRE still off", async () => {
  const a = createLocalAdapter("prj_demo", "staging");
  const cfg = await a.init({ uid: "prj_demo", env: "staging" });
  assert.deepEqual(cfg, {
    uid: "prj_demo",
    env: "staging",
    // `screenshots` is capture (local since /10); `uploads` means the
    // wire, which is the job and stays false without a server.
    features: { screenshots: true, uploads: false },
  });
});

/**
 * The F-01 probe.
 *
 * Until this existed the failure was completely silent: `writeAll` swallowed
 * the throw, every comment stayed on screen for the whole session, and the
 * reviewer found out on reload — having been told nothing at any point.
 */

/** localStorage that reads fine and throws on write. Safari private mode. */
function readOnlyStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: () => {
      throw new Error("The quota has been exceeded.");
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

test("storageWorks is true when writes actually land", () => {
  globalThis.localStorage = fakeStorage();
  assert.equal(storageWorks(), true);
});

test("storageWorks is FALSE when the browser refuses writes", () => {
  // The case that matters: a client on private-mode Safari. Reads succeed, so
  // anything checking `typeof localStorage` or calling getItem sees a working
  // store — which is exactly why the probe has to write.
  globalThis.localStorage = readOnlyStorage();
  assert.equal(storageWorks(), false);
});

test("a FULL disk still counts as working — it is F-02, not F-01", () => {
  // Different failure, different remedy. F-01 says "export before you leave";
  // F-02 says "export and clear". Reporting the first for the second sends the
  // reviewer to advice that will not free a single byte.
  globalThis.localStorage = fakeStorage({ full: true });
  assert.equal(storageWorks(), true);
});

test("the probe leaves NOTHING behind — counts probe keys too", () => {
  const seen = new Set<string>();
  const map = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      seen.add(k);
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;

  assert.equal(storageWorks(), true);
  assert.equal(map.size, 0, "cleaned up after itself");
  // And what it wrote in passing was still a registry-derived key, not an
  // invented one — "no storage key outside the registry" has no exemption for
  // keys that only exist for a moment.
  for (const k of seen) assert.match(k, /^snag:/);
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadShotBlob } from "../src/storage/shots.ts";
import { createHttpAdapter } from "../src/storage/http.ts";

/**
 * The dock's screenshot on a SERVER-BACKED instance.
 *
 * ── THE BUG ──
 *
 * Found self-hosting an instance and reviewing a client site: the dashboard
 * showed every screenshot, the widget's comment panel showed none — on every
 * browser, the one that took the picture included. Two breaks in a row:
 *
 *   1. `toSnag` dropped the `attachments` the server sends on the thread
 *      list, so a thread read back had no screenshot ref at all;
 *   2. the dock's loader read ONLY the local IndexedDB store, which a
 *      server-backed flow never writes, so even the in-session ref (built by
 *      `uploadAttachment`, with its URL) looked up nothing.
 *
 * Both halves are asserted here: the adapter keeps the ref and makes its URL
 * fetchable from the CLIENT'S origin, and the loader fetches it from there.
 */

let fetched: { url: string; init?: RequestInit }[] = [];
let localReads: string[] = [];
const local = async (id: string): Promise<Blob | null> => {
  localReads.push(id);
  return new Blob(["local"], { type: "image/webp" });
};

function stubFetch(respond: (url: string) => Response | Promise<Response>): void {
  (globalThis as Record<string, unknown>)["fetch"] = async (url: string, init?: RequestInit) => {
    fetched.push({ url: String(url), ...(init ? { init } : {}) });
    return respond(String(url));
  };
}

beforeEach(() => {
  fetched = [];
  localReads = [];
});

test("a server-held ref is FETCHED from its URL, credentials omitted, and the store is never opened", async () => {
  stubFetch(() => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }), { status: 200 }));
  const blob = await loadShotBlob({ id: "att_1", url: "https://review.test/api/v1/attachments/att_1/blob" }, local);
  assert.ok(blob);
  assert.equal(blob!.size, 3);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0]!.url, "https://review.test/api/v1/attachments/att_1/blob");
  // A capability URL: the id is the authority, no cookie rides along.
  assert.equal(fetched[0]!.init?.credentials, "omit");
  // A server-backed flow performs zero IndexedDB calls.
  assert.deepEqual(localReads, []);
});

test("a remote miss is no picture — never a fallback into the local store", async () => {
  stubFetch(() => new Response("{}", { status: 404 }));
  assert.equal(await loadShotBlob({ id: "att_1", url: "https://review.test/x" }, local), null);
  stubFetch(() => {
    throw new TypeError("network");
  });
  assert.equal(await loadShotBlob({ id: "att_1", url: "https://review.test/x" }, local), null);
  // A 200 that is not an image (a proxy's HTML page) must not reach
  // createImageBitmap.
  stubFetch(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
  assert.equal(await loadShotBlob({ id: "att_1", url: "https://review.test/x" }, local), null);
  assert.deepEqual(localReads, []);
});

test("a LOCAL ref (url \"\") reads the blob store and never touches the network", async () => {
  stubFetch(() => {
    throw new Error("must not fetch");
  });
  const blob = await loadShotBlob({ id: "att_local", url: "" }, local);
  assert.ok(blob);
  assert.deepEqual(localReads, ["att_local"]);
  assert.equal(fetched.length, 0);
  // An exported archive's data: URI is not a server ref either.
  await loadShotBlob({ id: "att_local" }, local);
  assert.equal(fetched.length, 0);
});

// ── The adapter half ────────────────────────────────────────────────────────

function wireThread(attachments: unknown[]): Record<string, unknown> {
  return {
    id: "thr_1",
    key: 1,
    status: "open",
    anchor: { page: { route: "/" }, offset: { x: 0.5, y: 0.5 } },
    anchorState: "anchored",
    context: {},
    comments: [],
    createdBy: { id: "rev_1", name: "Ana", kind: "guest" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    attachments,
  };
}

function installAdapterEnv(threads: Record<string, unknown>[]): void {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const g = globalThis as Record<string, unknown>;
  g["localStorage"] = ls;
  g["sessionStorage"] = ls;
  g["location"] = { href: "https://client.test/", origin: "https://client.test", pathname: "/", search: "" };
  g["window"] = globalThis;
  stubFetch((url) => {
    if (url.endsWith("/sessions")) {
      return new Response(
        JSON.stringify({
          sessionToken: "tok",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          refreshableUntil: new Date(Date.now() + 43_200_000).toISOString(),
          reviewer: { id: "rev_1", name: "Ana", kind: "guest" },
          permissions: ["thread:create", "comment:create"],
        }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify({ data: threads, nextCursor: null, deleted: [], serverTime: new Date().toISOString() }), {
      status: 200,
    });
  });
}

test("threads read back from an instance KEEP their screenshot ref, with a URL the client's page can fetch", async () => {
  installAdapterEnv([
    wireThread([
      // What threads.ts sends today: the proxy route, ROOT-RELATIVE.
      { id: "att_rel", kind: "screenshot", url: "/api/v1/attachments/att_rel/blob", width: 1280, height: 800 },
      // Only an id: the URL is derived from the public route.
      { id: "att_bare", kind: "screenshot" },
      // Already absolute: left alone.
      { id: "att_abs", kind: "screenshot", url: "https://cdn.review.test/a.webp" },
    ]),
  ]);
  const a = createHttpAdapter("https://review.test/", "prj_abc123456789", "production", {});
  const list = await a.listThreads();
  const atts = list.data[0]!.attachments!;
  assert.deepEqual(
    atts.map((x) => x.url),
    [
      // Resolved against the API base, NOT the client's origin — relative to
      // https://client.test it would 404 on somebody else's site.
      "https://review.test/api/v1/attachments/att_rel/blob",
      "https://review.test/api/v1/attachments/att_bare/blob",
      "https://cdn.review.test/a.webp",
    ],
  );
  assert.equal(atts[0]!.width, 1280);
  assert.equal(atts[0]!.kind, "screenshot");
});

test("a thread with no attachments gets no key — absent, never an empty array", async () => {
  installAdapterEnv([wireThread([])]);
  const a = createHttpAdapter("https://review.test", "prj_abc123456789", "production", {});
  const list = await a.listThreads();
  assert.ok(!("attachments" in list.data[0]!));
});

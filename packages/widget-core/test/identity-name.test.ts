import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHttpAdapter } from "../src/storage/http.ts";
import { writeIdentity } from "../src/storage/identity.ts";

/**
 * A reviewer's name reaches the server.
 *
 * ── THE BUG ──
 *
 * The design is explicit that *"a session's identity is decided at exchange and never
 * taken from a request"*, and that has a consequence nobody had followed
 * through: the session is minted when the widget ACTIVATES, which is before the
 * composer has asked anyone their name. So the reviewer row was created
 * `Anonymous`, the client then typed "Ana at Acme", the composer stored it —
 * and every comment they left for the rest of that session was attributed to
 * Anonymous.
 *
 * Found by installing from three packed tarballs, claiming through the browser
 * and leaving one comment as a client would: the dashboard said Anonymous over
 * a comment signed by somebody who had typed their name two seconds earlier.
 *
 * The server side already worked — a guest re-exchange with the same holder and
 * a typed name updates the row. What was missing was anything asking it to.
 */

const store = new Map<string, string>();
let posted: { url: string; body: any }[] = [];

function installEnv(): void {
  store.clear();
  posted = [];
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as Record<string, unknown>)["localStorage"] = ls;
  (globalThis as Record<string, unknown>)["sessionStorage"] = ls;
  (globalThis as Record<string, unknown>)["location"] = {
    href: "https://shop.test/",
    origin: "https://shop.test",
    pathname: "/",
    search: "",
  };
  (globalThis as Record<string, unknown>)["window"] = globalThis;
  (globalThis as Record<string, unknown>)["fetch"] = async (url: string, init: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    posted.push({ url: String(url), body });
    if (String(url).endsWith("/sessions")) {
      return new Response(
        JSON.stringify({
          sessionToken: "tok",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          refreshableUntil: new Date(Date.now() + 43_200_000).toISOString(),
          reviewer: { id: "rev_1", name: body?.identity?.name ?? "Anonymous", kind: "guest" },
          permissions: ["thread:create", "comment:create"],
        }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify({ data: [], nextCursor: null, deleted: [], serverTime: new Date().toISOString() }), {
      status: 200,
    });
  };
}

beforeEach(installEnv);

const sessions = () => posted.filter((p) => p.url.endsWith("/sessions"));

test("a name typed AFTER activation forces a re-exchange", async () => {
  const a = createHttpAdapter("https://review.test", "prj_abc123456789", "production", {});

  // Activation: no name known yet, so the reviewer is Anonymous.
  await a.listThreads();
  assert.equal(sessions().length, 1);
  assert.equal(sessions()[0]!.body.identity.name, "Anonymous");

  // The composer collects one and stores it, exactly as `send()` does.
  writeIdentity({ name: "Ana at Acme" });

  // The next write must carry it — this is the whole fix.
  await a.listThreads();
  assert.equal(sessions().length, 2, "a name learned since the exchange forces a new one");
  assert.equal(sessions()[1]!.body.identity.name, "Ana at Acme");
});

test("a reviewer who never types a name exchanges exactly once", async () => {
  // The comparison is against what we EXCHANGED with, not "is there a name" —
  // otherwise every request would re-exchange for an anonymous reviewer.
  const a = createHttpAdapter("https://review.test", "prj_abc123456789", "production", {});
  await a.listThreads();
  await a.listThreads();
  await a.listThreads();
  assert.equal(sessions().length, 1);
});

test("a CORRECTED name is picked up too", async () => {
  const a = createHttpAdapter("https://review.test", "prj_abc123456789", "production", {});
  writeIdentity({ name: "Ana" });
  await a.listThreads();
  assert.equal(sessions()[0]!.body.identity.name, "Ana");

  writeIdentity({ name: "Ana Ferreira" });
  await a.listThreads();
  assert.equal(sessions().length, 2, "somebody fixing their own name mid-round gets that too");
  assert.equal(sessions()[1]!.body.identity.name, "Ana Ferreira");
});

test("the same name twice does not re-exchange", async () => {
  const a = createHttpAdapter("https://review.test", "prj_abc123456789", "production", {});
  writeIdentity({ name: "Ana" });
  await a.listThreads();
  writeIdentity({ name: "Ana" });
  await a.listThreads();
  assert.equal(sessions().length, 1);
});

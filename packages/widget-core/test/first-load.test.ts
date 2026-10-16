import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHttpAdapter } from "../src/storage/http.ts";
import { writeIdentity } from "../src/storage/identity.ts";

/**
 * The HTTP adapter's first load, counted in requests — because from a studio
 * in Seoul to an instance in London every one of them is ~0.3 s, and the ones
 * in series are the wait a reviewer sees before the pins.
 *
 * Measured against a seeded instance before these were written: TWO guest
 * exchanges on every first load (`init()` and the first list raced, each found
 * no session), `/config` asked again after the exchange with a bearer — so
 * preflighted, and never from the cache the stub had just filled — and a named
 * guest re-exchanging on every page load, because the name a session was
 * minted with lived only in memory.
 */

const tab = new Map<string, string>();
const kept = new Map<string, string>();
let calls: { url: string; init: RequestInit | undefined }[] = [];

const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
});

beforeEach(() => {
  tab.clear();
  kept.clear();
  calls = [];
  const g = globalThis as Record<string, unknown>;
  g["localStorage"] = storage(kept);
  g["sessionStorage"] = storage(tab);
  // A client's site on its own domain: no silent member sign-in in play.
  g["location"] = { href: "https://shop.test/", origin: "https://shop.test", hostname: "shop.test", pathname: "/", search: "" };
  g["window"] = globalThis;
  g["fetch"] = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/sessions")) {
      const body = JSON.parse(String(init!.body));
      return new Response(
        JSON.stringify({
          sessionToken: "tok",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          refreshableUntil: new Date(Date.now() + 43_200_000).toISOString(),
          reviewer: { id: "rev_1", name: body.identity?.name ?? "Anonymous", kind: "guest" },
          permissions: ["thread:create", "comment:create"],
        }),
        { status: 201 },
      );
    }
    if (String(url).endsWith("/config")) {
      return new Response(JSON.stringify({ features: { screenshots: false, uploads: false }, rounds: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [], nextCursor: null, serverTime: new Date().toISOString() }), { status: 200 });
  };
});

const exchanges = () => calls.filter((c) => c.url.endsWith("/sessions"));
const lists = () => calls.filter((c) => c.url.includes("/threads?"));
const settle = () => new Promise((r) => setTimeout(r, 0));
const UID = "prj_abc123456789";

test("a first load exchanges ONCE, however many calls race for a session", async () => {
  const a = createHttpAdapter("https://review.test", UID, undefined);
  await Promise.all([a.init({ uid: UID, env: "default" }), a.listThreads(), a.listThreads()]);
  await settle();
  assert.equal(exchanges().length, 1);
});

test("the config is asked bare — no bearer, no header — so the stub's cached answer serves it", async () => {
  const a = createHttpAdapter("https://review.test", UID, undefined);
  await a.init({ uid: UID, env: "default" });
  const config = calls.find((c) => c.url.endsWith("/config"))!;
  assert.equal(config.init, undefined, "exactly the stub's request: a CORS simple GET");
});

test("a first visit's list does not wait for the exchange, and carries no header to preflight", async () => {
  const a = createHttpAdapter("https://review.test", UID, undefined);
  await a.listThreads();
  const first = lists()[0]!;
  assert.deepEqual(first.init, { credentials: "omit" });
  await settle();
  assert.equal(exchanges().length, 1, "the exchange still ran, for the writes");
  // Once a session is held, the list goes with it, as before.
  await a.listThreads();
  const second = lists()[1]!;
  assert.match(String((second.init!.headers as Record<string, string>)["Authorization"]), /^Bearer tok$/);
});

test("a named guest's next page in the same tab does not exchange again", async () => {
  writeIdentity({ name: "Ana at Acme" });
  const a = createHttpAdapter("https://review.test", UID, undefined);
  await a.listThreads();
  await a.listThreads();
  assert.equal(exchanges().length, 1);
  assert.equal(JSON.parse(String(exchanges()[0]!.init!.body)).identity.name, "Ana at Acme");

  // The reload: a new adapter over the same tab's storage.
  const b = createHttpAdapter("https://review.test", UID, undefined);
  await b.listThreads();
  assert.equal(exchanges().length, 1, "the session remembers the name it was minted with");

  // …and a name changed since still reaches the server.
  writeIdentity({ name: "Ana Ferreira" });
  await b.listThreads();
  assert.equal(exchanges().length, 2);
});

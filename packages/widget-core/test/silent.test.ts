import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHttpAdapter, sameSiteHint } from "../src/storage/http.ts";

/**
 * The silent member sign-in, the widget's half: WHEN it asks, and what
 * it does with each answer. The server's checks are member-session.test.ts's.
 */

const local = new Map<string, string>();
const tab = new Map<string, string>();
let calls: { url: string; init: RequestInit }[] = [];
let silentStatus = 201;

const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
});

function installEnv(pageHost: string): void {
  calls = [];
  const g = globalThis as Record<string, unknown>;
  g["localStorage"] = storage(local);
  g["sessionStorage"] = storage(tab);
  g["location"] = { href: `https://${pageHost}/`, origin: `https://${pageHost}`, hostname: pageHost, pathname: "/", search: "" };
  g["window"] = globalThis;
  g["fetch"] = async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const session = (name: string) =>
      new Response(
        JSON.stringify({
          sessionToken: `tok-${name}`,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          refreshableUntil: new Date(Date.now() + 43_200_000).toISOString(),
          reviewer: { id: "rev_1", name, kind: name === "Anonymous" ? "guest" : "verified" },
          permissions: ["thread:create"],
          moderator: true,
        }),
        { status: 201 },
      );
    if (String(url).endsWith("/sessions/member/silent")) {
      return silentStatus === 201 ? session("Edith") : new Response("{}", { status: silentStatus });
    }
    if (String(url).endsWith("/sessions")) return session("Anonymous");
    return new Response(JSON.stringify({ data: [], nextCursor: null, deleted: [], serverTime: new Date().toISOString() }), { status: 200 });
  };
}

beforeEach(() => {
  local.clear();
  tab.clear();
  silentStatus = 201;
});

const silentCalls = () => calls.filter((c) => c.url.endsWith("/sessions/member/silent"));
const exchanges = () => calls.filter((c) => c.url.endsWith("/sessions"));

test("sameSiteHint: the last two labels, IPs only with themselves", () => {
  assert.equal(sameSiteHint("acme.example.dev", "snagset.example.dev"), true);
  assert.equal(sameSiteHint("localhost", "localhost"), true);
  assert.equal(sameSiteHint("acme.com", "snagset.example.dev"), false);
  assert.equal(sameSiteHint("127.0.0.1", "127.0.0.2"), false);
  assert.equal(sameSiteHint("10.0.0.1", "10.0.0.1"), true);
  // Deliberately naive: the server refuses these (shared suffix, registry),
  // and a refused request is all a wrong "yes" here costs.
  assert.equal(sameSiteHint("a.vercel.app", "b.vercel.app"), true);
  assert.equal(sameSiteHint("acme.co.uk", "evil.co.uk"), true);
});

test("same site, nobody signed in: one silent request, then the member's session — no guest exchange", async () => {
  installEnv("acme.studio.test");
  const a = createHttpAdapter("https://snagset.studio.test", "prj_abc123456789", "production");
  await Promise.all([a.listThreads(), a.listThreads()]);
  assert.equal(silentCalls().length, 1, "one attempt, shared by the racing calls");
  const req = silentCalls()[0]!.init;
  assert.equal(req.credentials, "include");
  assert.equal(req.headers, undefined, "no custom header — a CORS simple request");
  assert.equal(JSON.parse(String(req.body)).environment, "production");
  assert.equal(exchanges().length, 0, "the member is never exchanged as a guest first");
  assert.equal(a.member!(), "Edith");
  assert.equal(a.canModerate!(), true);
  assert.ok(local.get("snag:session:prj_abc123456789"), "kept for the browser, like a popup sign-in");
  // Only the silent call carries credentials.
  for (const c of calls.filter((c) => !c.url.endsWith("/silent"))) assert.equal(c.init.credentials, "omit", c.url);
});

test("a client's page on another domain never asks", async () => {
  installEnv("acme.com");
  const a = createHttpAdapter("https://snagset.studio.test", "prj_abc123456789", undefined);
  await a.listThreads();
  assert.equal(silentCalls().length, 0);
  assert.equal(exchanges().length, 1);
});

test("a 'no' changes nothing visible, and is remembered by the tab", async () => {
  installEnv("acme.studio.test");
  silentStatus = 401;
  const a = createHttpAdapter("https://snagset.studio.test", "prj_abc123456789", undefined);
  await a.listThreads();
  await a.listThreads();
  assert.equal(silentCalls().length, 1);
  assert.equal(exchanges().length, 1, "a guest, as before");
  assert.equal(a.member!(), null);
  assert.equal(silentCalls()[0]!.init.body, undefined, "no environment, no body");

  // The next page of the same site, in the same tab: not asked again.
  const b = createHttpAdapter("https://snagset.studio.test", "prj_abc123456789", undefined);
  await b.listThreads();
  assert.equal(silentCalls().length, 1);
});

test("a review link being presented is not overridden", async () => {
  installEnv("acme.studio.test");
  const a = createHttpAdapter("https://snagset.studio.test", "prj_abc123456789", undefined, { reviewToken: "x".repeat(43) });
  await a.listThreads();
  assert.equal(silentCalls().length, 0);
});

test("after 'Not you? Sign out' it stays out — until the popup is used again", async () => {
  installEnv("acme.studio.test");
  const a = createHttpAdapter("https://snagset.studio.test", "prj_abc123456789", undefined);
  await a.listThreads();
  assert.equal(a.member!(), "Edith");
  a.signOut!();

  const b = createHttpAdapter("https://snagset.studio.test", "prj_abc123456789", undefined);
  await b.listThreads();
  assert.equal(silentCalls().length, 1, "not asked again after signing out");
  assert.equal(b.member!(), null);

  b.adoptSession!({
    sessionToken: "tok-popup",
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshableUntil: new Date(Date.now() + 43_200_000).toISOString(),
    reviewer: { id: "rev_1", name: "Edith" },
    permissions: [],
  });
  assert.equal(local.get("snag:silent:prj_abc123456789"), undefined, "the popup lifts the sign-out");
});

test("a member's session at the cap is renewed silently, with no 'expired'", async () => {
  installEnv("acme.studio.test");
  local.set(
    "snag:session:prj_abc123456789",
    JSON.stringify({ token: "old", expiresAt: Date.now() - 1000, refreshableUntil: Date.now() - 1, reviewerId: "rev_1", permissions: [], member: "Edith" }),
  );
  const ended: string[] = [];
  const a = createHttpAdapter("https://snagset.studio.test", "prj_abc123456789", undefined, { onSessionEnded: (r) => ended.push(r) });
  await a.listThreads();
  assert.equal(silentCalls().length, 1);
  assert.deepEqual(ended, []);
  assert.equal(a.member!(), "Edith");
  assert.equal(exchanges().length, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { callerMiddleware, callerOf, FORGOTTEN_PROXY, resolveCaller } from "../src/net/caller.ts";

test("with no trusted hop the header is ignored entirely: the caller is the connection", () => {
  assert.equal(resolveCaller("198.51.100.1", "203.0.113.5", 0), "203.0.113.5");
  assert.equal(resolveCaller("198.51.100.1, 198.51.100.2", undefined, 0), "local", "and with no connection to ask, nobody in particular");
  assert.equal(resolveCaller(undefined, undefined, 0), "local");
});

test("with n trusted hops the caller is the entry n from the right: what the caller wrote to its left is not believed", () => {
  // One proxy: it appended the address it saw. Whatever came before is the caller's own say-so.
  assert.equal(resolveCaller("203.0.113.5", "10.0.0.2", 1), "203.0.113.5");
  assert.equal(resolveCaller("1.1.1.1, 203.0.113.5", "10.0.0.2", 1), "203.0.113.5", "a forged first entry buys nothing");
  // Two proxies (a CDN in front of the platform's own).
  assert.equal(resolveCaller("1.1.1.1, 203.0.113.5, 172.16.0.9", "10.0.0.2", 2), "203.0.113.5");
  // Fewer entries than hops: the leftmost is the best there is.
  assert.equal(resolveCaller("203.0.113.5", "10.0.0.2", 2), "203.0.113.5");
  // No header behind a trusted hop: the connection.
  assert.equal(resolveCaller("", "10.0.0.2", 1), "10.0.0.2");
  assert.equal(resolveCaller(" , ", "10.0.0.2", 1), "10.0.0.2");
});

test("an IPv6 caller is its /64, a mapped IPv4 is its IPv4 self, and spelling does not make a new caller", () => {
  const a = resolveCaller(undefined, "2001:db8:aa:bb:1:2:3:4", 0);
  assert.equal(a, "2001:db8:aa:bb::/64");
  assert.equal(resolveCaller(undefined, "2001:0DB8:00aa:00bb:ffff:ffff:ffff:ffff", 0), a, "the same subscriber, another of its 2^64 addresses");
  assert.equal(resolveCaller(undefined, "[2001:db8:aa:bb::1]", 0), a);
  assert.equal(resolveCaller(undefined, "2001:db8::1", 0), "2001:db8:0:0::/64");
  assert.notEqual(resolveCaller(undefined, "2001:db8:aa:bc::1", 0), a);
  assert.equal(resolveCaller(undefined, "::ffff:203.0.113.7", 0), "203.0.113.7");
  assert.equal(resolveCaller(undefined, "fe80::1%en0", 0), "fe80:0:0:0::/64");
  assert.equal(resolveCaller(undefined, "::1", 0), "0:0:0:0::/64");
  assert.equal(resolveCaller("not an address at all", "10.0.0.2", 1), "not an address at all", "kept as sent: still one key per string");
  // A port is not part of who is calling.
  assert.equal(resolveCaller("203.0.113.7:51234", "10.0.0.2", 1), "203.0.113.7");
  assert.equal(resolveCaller("[2001:db8:aa:bb::1]:443", "10.0.0.2", 1), a);
  // An IPv4 inside an IPv6, however it is spelled, is that IPv4 — not one shared /64 for all of them.
  for (const spelled of ["::ffff:cb00:7107", "0:0:0:0:0:ffff:203.0.113.7", "::FFFF:203.0.113.7", "::ffff:0:203.0.113.7", "64:ff9b::203.0.113.7", "64:ff9b::cb00:7107"]) {
    assert.equal(resolveCaller(undefined, spelled, 0), "203.0.113.7", spelled);
  }
  assert.notEqual(resolveCaller(undefined, "::ffff:203.0.113.8", 0), resolveCaller(undefined, "::1", 0));
  // Not an address after all: kept, never thrown on.
  for (const odd of [":::::", "1::2::3", "12345::1", "gg::1", ":"]) assert.equal(typeof resolveCaller(odd, undefined, 1), "string", odd);
});

test("the middleware works it out once, from the live setting, and a route mounted without it is nobody in particular", async () => {
  let hops = 0;
  const app = new Hono();
  app.get("/bare", (c) => c.text(callerOf(c)));
  app.use("*", callerMiddleware(() => hops, () => {}));
  app.get("/who", (c) => c.text(callerOf(c)));
  const ask = async (path: string) => (await app.request(path, { headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.5" } }, { incoming: { socket: { remoteAddress: "::ffff:10.0.0.2" } } })).text();
  assert.equal(await ask("/who"), "10.0.0.2");
  hops = 1;
  assert.equal(await ask("/who"), "203.0.113.5");
  assert.equal(await ask("/bare"), "local");
});

test("a proxy's header with the setting at 0 is said in the log once, and never when the setting is set or no header came", async () => {
  const build = (hops: number) => {
    const said: string[] = [];
    const app = new Hono();
    app.use("*", callerMiddleware(() => hops, (line) => void said.push(line)));
    app.get("/who", (c) => c.text(callerOf(c)));
    const ask = (xff?: string) => app.request("/who", xff ? { headers: { "x-forwarded-for": xff } } : {}, { incoming: { socket: { remoteAddress: "10.0.0.2" } } });
    return { said, ask };
  };

  const forgotten = build(0);
  await forgotten.ask();
  assert.deepEqual(forgotten.said, [], "no header: nothing to say");
  assert.equal(await (await forgotten.ask("203.0.113.5")).text(), "10.0.0.2", "the header is still ignored");
  await forgotten.ask("203.0.113.6");
  await forgotten.ask("203.0.113.7");
  assert.deepEqual(forgotten.said, [FORGOTTEN_PROXY], "once, however many arrive");
  assert.match(FORGOTTEN_PROXY, /SNAGSET_TRUST_PROXY/);

  const set = build(1);
  await set.ask("203.0.113.5");
  assert.deepEqual(set.said, [], "told about its proxy: nothing to say");
});

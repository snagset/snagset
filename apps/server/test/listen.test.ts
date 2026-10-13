import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { listenFailure } from "../src/listen.ts";

test("a port already in use is one sentence naming SNAGSET_PORT, not a stack trace", async () => {
  // Take a real port, then try to take it again: the error Node hands back is
  // the one the bin receives, not a hand-made object.
  const holder = createServer();
  await new Promise<void>((r) => holder.listen(0, "127.0.0.1", () => r()));
  const port = (holder.address() as { port: number }).port;
  const err = await new Promise<unknown>((resolve) => {
    const second = createServer();
    second.on("error", (e) => resolve(e));
    second.listen(port, "127.0.0.1");
  });
  holder.close();
  const said = listenFailure(err, port, "127.0.0.1");
  assert.ok(said, "the failure is explained");
  assert.match(said!, new RegExp(`port ${port} is already in use`));
  assert.match(said!, /SNAGSET_PORT/);
  assert.match(said!, /SNAGSET_BASE_URL/);
  assert.ok(!/at .*\(node:/.test(said!), "no stack trace");
});

test("an unknown listen error is not explained away", () => {
  assert.equal(listenFailure(new Error("boom"), 8080, "0.0.0.0"), null);
  assert.equal(listenFailure(null, 8080, "0.0.0.0"), null);
});

test("privileged and unroutable addresses get their own sentence", () => {
  assert.match(listenFailure({ code: "EACCES" }, 80, "0.0.0.0")!, /above 1023/);
  assert.match(listenFailure({ code: "EADDRNOTAVAIL" }, 8080, "10.9.8.7")!, /SNAGSET_BIND_ADDRESS/);
});

test("with nothing pinned the server roams to the next free port; with either variable set it does not", async () => {
  const { freePort, pinned } = await import("../src/listen.ts");
  const holder = createServer();
  await new Promise<void>((r) => holder.listen(0, "127.0.0.1", () => r()));
  const taken = (holder.address() as { port: number }).port;
  assert.equal(await freePort(taken, "127.0.0.1", 5), taken + 1, "the next port up");
  holder.close();
  assert.equal(await freePort(taken, "127.0.0.1", 5), taken, "free again, so the port asked for");

  assert.equal(pinned({}), false);
  assert.equal(pinned({ SNAGSET_PORT: "8080" }), true);
  assert.equal(pinned({ SNAGSET_BASE_URL: "https://review.example.com" }), true);
  assert.equal(pinned({ SNAGSET_PUBLIC_URL: "https://review.example.com" }), true, "the alias pins too");
  assert.equal(pinned({ PORT: "3000" }), true, "a platform's PORT is a pin — it routes there");
});

test("ten taken ports in a row is a null, and then the sentence", async () => {
  const { freePort } = await import("../src/listen.ts");
  const holders = [];
  let base = 0;
  for (let i = 0; i < 3; i++) {
    const h = createServer();
    await new Promise<void>((r) => h.listen(base === 0 ? 0 : base + i, "127.0.0.1", () => r()));
    if (base === 0) base = (h.address() as { port: number }).port;
    holders.push(h);
  }
  assert.equal(await freePort(base, "127.0.0.1", 3), null);
  for (const h of holders) h.close();
});

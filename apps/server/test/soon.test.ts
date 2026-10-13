import { test } from "node:test";
import assert from "node:assert/strict";
import { createDrainer, noteQueued, watchQueue } from "../src/jobs/soon.ts";
import { platformWaitUntil } from "../src/serverless.ts";

/**
 * The two moving parts, with no database: the note a writer leaves for its
 * request, and the one-drain-per-process rule. The end-to-end half, a real
 * route whose transaction queues a row that reaches a fake tracker with no
 * sweep in between, is in `integrations.test.ts`.
 */

const tick = () => new Promise<void>((r) => setImmediate(r));

test("a note made several awaits deep inside the request is seen; outside any request it is a no-op", async () => {
  noteQueued(); // no scope: must not throw, must not leak into the next one
  const queued = await watchQueue(async () => {
    await tick();
    await new Promise<void>((r) => setTimeout(r, 5));
    await Promise.resolve().then(() => noteQueued());
  });
  assert.equal(queued, true);
  assert.equal(await watchQueue(async () => { await tick(); }), false, "a request that queued nothing");
});

test("two requests in flight at once do not see each other's notes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const a = watchQueue(async () => {
    await gate;
    noteQueued();
  });
  const b = watchQueue(async () => {
    await gate;
  });
  release();
  assert.deepEqual(await Promise.all([a, b]), [true, false]);
});

test("writes that ask while a drain runs share it, and it goes round exactly once more for them", async () => {
  let rounds = 0;
  let release!: () => void;
  let gate = new Promise<void>((r) => (release = r));
  const drain = createDrainer(async () => {
    rounds++;
    await gate;
  }, () => {});

  const first = drain();
  await tick();
  assert.equal(rounds, 1);
  // Three more writes queue while the first round is blocked.
  const second = drain();
  const third = drain();
  const fourth = drain();
  assert.equal(second, first, "the running drain's promise, not a new drain");
  assert.equal(rounds, 1, "nobody started a second drain beside the first");

  const firstRound = release;
  gate = Promise.resolve(); // the extra round does not block
  firstRound();
  await Promise.all([first, second, third, fourth]);
  assert.equal(rounds, 2, "one extra round covers every write that asked during the first");

  // Idle again: the next write starts a fresh drain.
  await drain();
  assert.equal(rounds, 3);
});

test("a drain that throws is logged and resolves: the response has gone, and the sweep will retry", async () => {
  const said: string[] = [];
  const drain = createDrainer(async () => {
    throw new Error("the provider said 503");
  }, (m) => said.push(m));
  await drain(); // must not reject
  assert.equal(said.length, 1);
  assert.match(said[0]!, /the provider said 503/);
  assert.match(said[0]!, /sweep/);
});

const SYMBOL = Symbol.for("@vercel/request-context");

test("Vercel's waitUntil is found on its request context and called as a method; elsewhere there is none", () => {
  const g = globalThis as Record<symbol, unknown>;
  assert.equal(platformWaitUntil(), null, "no Vercel runtime, no waitUntil");

  const handed: Promise<unknown>[] = [];
  const context = {
    handed,
    waitUntil(this: { handed: Promise<unknown>[] }, p: Promise<unknown>) {
      // `this` must be the context, as it is when `@vercel/functions` calls it.
      this.handed.push(p);
    },
  };
  g[SYMBOL] = { get: () => context };
  try {
    const waitUntil = platformWaitUntil();
    assert.ok(waitUntil);
    const task = Promise.resolve();
    waitUntil(task);
    assert.deepEqual(handed, [task]);

    // A store that answers for no invocation, which is what one outside a request does.
    g[SYMBOL] = { get: () => undefined };
    assert.equal(platformWaitUntil(), null);
  } finally {
    delete g[SYMBOL];
  }
});

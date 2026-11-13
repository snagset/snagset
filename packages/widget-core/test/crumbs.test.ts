import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain .mjs, deliberately outside the package's type graph.
import { installEarly, reduceArg, type PreRecord } from "../src/loader/crumbs-early.ts";
import { BreadcrumbBuffer, installTierC, serialise } from "../src/crumbs/index.ts";
import { redactObject } from "../src/redact/object.ts";
import { isSensitiveKey } from "../src/redact/predicates.ts";

/**
 * The unit half. The co-existence and purity claims are E2E (a real page,
 * a real Sentry-shaped stranger); what lives here is everything with an exact
 * numeric contract — the byte bound, the flood guard, the reducer and
 * serializer tables, and the corpus routed through the recorder.
 */

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeWin {
  console: Record<string, (...a: unknown[]) => unknown>;
  location: { href: string };
  document: { addEventListener: (...a: unknown[]) => void };
  setTimeout: typeof setTimeout;
  addEventListener: (type: string, fn: (e: unknown) => void, o?: unknown) => void;
  handlers: Record<string, (e: unknown) => void>;
}

function fakeWin(): FakeWin {
  const handlers: Record<string, (e: unknown) => void> = {};
  return {
    console: {
      log: () => "log-out",
      info: () => {},
      debug: () => {},
      warn: () => "warn-out",
      error: () => "error-out",
    },
    location: { href: "https://site.test/page?token=tok_live_abcdef123456" },
    document: { addEventListener: () => {} },
    setTimeout,
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    handlers,
  };
}

const asWin = (w: FakeWin): Window & typeof globalThis => w as unknown as Window & typeof globalThis;

// ── — the shallow reducer ─────────────────────────────────────────────

test("reducer: every input class lands in its table row, nothing throws", () => {
  assert.equal(reduceArg("x".repeat(600)).length, 512);
  assert.equal(reduceArg(42), "42");
  assert.equal(reduceArg(null), "null");
  assert.equal(reduceArg(undefined), "undefined");
  const err = new TypeError("bad thing");
  const red = reduceArg(err);
  assert.match(red, /^TypeError: bad thing/);
  assert.ok(red.split("\n").length <= 11, "first 10 stack frames only");
  assert.equal(reduceArg([1, 2, 3]), "[Array(3)]");
  assert.equal(reduceArg({ a: 1 }), "[Object]");
  assert.equal(reduceArg(Promise.resolve()), "[Promise]");
  // A DOM-shaped object: tag only — never id, class, children or text.
  assert.equal(reduceArg({ nodeType: 1, tagName: "BUTTON", id: "buy", innerText: "Buy now" }), "<button>");
  // A throwing getter on a duck-typed `name` must not break console.error.
  const hostile = Object.defineProperty({ message: "m" }, "name", {
    get() {
      throw new Error("gotcha");
    },
  });
  assert.equal(reduceArg(hostile), "[unreadable]");
});

// ── stub side — PreBuffer, flood guard, Tier A/B ───────────────────────

test("Tier A records the initial URL, script errors, resource failures and rejections", () => {
  const w = fakeWin();
  const early = installEarly(asWin(w), { early: true }, new AbortController().signal);

  w.handlers["error"]!({ target: w, message: "boom", filename: "https://site.test/app.js", lineno: 3, colno: 7, error: new Error("boom") });
  w.handlers["error"]!({ target: { tagName: "IMG", src: "https://cdn.test/hero.png" } });
  w.handlers["unhandledrejection"]!({ reason: new TypeError("nope") });

  const { records } = early.drain(() => {});
  assert.equal(records[0]![1], "navigation");
  assert.equal(records[0]![3], w.location.href, "unredacted until seeding — the boundary rule");
  assert.match(records[1]![3], /boom.*app\.js:3:7/s);
  assert.equal(records[2]![3], "Failed to load <img> https://cdn.test/hero.png");
  assert.match(records[3]![3], /^Unhandled rejection: TypeError: nope/);
});

test("Tier B wraps console.error/warn, calls through, and unwinds on destroy", () => {
  const w = fakeWin();
  const origError = w.console.error;
  const early = installEarly(asWin(w), { early: true }, new AbortController().signal);
  assert.notEqual(w.console.error, origError, "wrapped");
  assert.equal(w.console.error.name, origError.name, "P3");

  const out = w.console.error("hydration %s mismatch", { nodeType: 1, tagName: "DIV" });
  assert.equal(out, "error-out", "P2 — the host's return value is untouched");
  const { records } = early.drain(() => {});
  const crumb = records.find((r) => r[1] === "console");
  assert.ok(crumb);
  // Format strings are NOT interpolated; args are reduced and appended.
  assert.equal(crumb![3], "hydration %s mismatch <div>");
  assert.equal(crumb![2], "error");

  early.destroy();
  assert.equal(w.console.error, origError, "identity restore");
});

test("breadcrumbs.early: false suppresses Tier B and only Tier B", () => {
  const w = fakeWin();
  const orig = w.console.error;
  installEarly(asWin(w), { early: false }, new AbortController().signal);
  assert.equal(w.console.error, orig, "console untouched");
  assert.ok(w.handlers["error"], "Tier A unaffected");
});

test("flood guard: a render-loop console.error stores 50 a window and counts the rest", () => {
  const w = fakeWin();
  const early = installEarly(asWin(w), { early: true }, new AbortController().signal);
  for (let i = 0; i < 80; i++) w.console.error(`spam ${i}`);
  const { records } = early.drain(() => {});
  // 1 navigation + 49 stored before the 50/window gate closes.
  assert.equal(records.length, 50);
});

test("the 100-slot ring drops oldest and counts what it dropped", () => {
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    const w = fakeWin();
    const early = installEarly(asWin(w), { early: true }, new AbortController().signal);
    for (let i = 0; i < 120; i++) {
      if (i % 40 === 0) t += 300; // step past the flood window
      w.console.error(`e${i}`);
    }
    const { records, dropped } = early.drain(() => {});
    assert.equal(records.length, 100);
    assert.ok(dropped >= 20, `dropped=${dropped}`);
  } finally {
    Date.now = realNow;
  }
});

test("after drain, the sink receives records directly and the ring stays empty", () => {
  const w = fakeWin();
  const early = installEarly(asWin(w), { early: true }, new AbortController().signal);
  const sunk: PreRecord[] = [];
  early.drain((r) => sunk.push(r));
  w.console.error("late");
  assert.equal(sunk.length, 1);
  assert.equal(sunk[0]![3], "late");
  const second = early.drain(() => {});
  assert.equal(second.records.length, 0, "nothing accumulates behind the sink");
});

// ── — the bounded serializer ──────────────────────────────────────────

test("serializer: depth, key, item, leaf and total bounds all hold", () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.match(serialise(deep), /\[Object\]/, "depth 3 stops the walk");

  const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
  assert.match(serialise(wide), /…\+10 more/, "20 keys, then a count");

  const long = Array.from({ length: 15 }, (_, i) => i);
  assert.match(serialise(long), /…\+5 more/, "10 items, then a count");

  assert.match(serialise({ s: "x".repeat(400) }), /x{256}…/, "leaf cap 256");
  assert.ok(serialise(wide, 3, 100).length <= 101, "total budget is hard");

  const circ: Record<string, unknown> = {};
  circ.self = circ;
  assert.match(serialise(circ), /\[Circular\]/);

  const hostile = Object.defineProperty({ ok: 1 }, "bad", {
    enumerable: true,
    get() {
      throw new Error("x");
    },
  });
  assert.match(serialise(hostile), /bad: \[throws\]/, "per-property try/catch");
});

// ── runtime side — the byte-budgeted buffer ────────────────────────────

const crumb = (msg: string, i = 0): Parameters<BreadcrumbBuffer["push"]>[0] => ({
  t: new Date(1_700_000_000_000 + i * 2000).toISOString(), // 2 s apart — never de-duped
  type: "console",
  level: "log",
  message: msg,
});

test("DoD: 100 entries of 2 KB self-trim to ≤ 64 KB of serialised bytes", () => {
  const buf = new BreadcrumbBuffer();
  for (let i = 0; i < 100; i++) buf.push(crumb(`${i}-${"x".repeat(2048)}`, i));
  const kept = buf.drain().filter((b) => b.type !== "system");
  const bytes = kept.reduce((n, b) => n + JSON.stringify(b).length, 0);
  assert.ok(bytes <= 65_536, `serialised bytes ${bytes} must be ≤ 65536`);
  assert.ok(kept.length < 100, "the bound that bit was BYTES, not the entry count");
  assert.ok(buf.dropped > 0);
  assert.match(buf.drain()[0]!.message, /\d+ earlier breadcrumbs dropped/);
});

test("de-dupe: identical (type, level, message) within 1 s becomes one entry with a count", () => {
  const buf = new BreadcrumbBuffer();
  const t = 1_700_000_000_000;
  for (let i = 0; i < 5; i++)
    buf.push({ t: new Date(t + i * 100).toISOString(), type: "console", level: "log", message: "same" });
  const out = buf.drain();
  assert.equal(out.length, 1);
  assert.equal(out[0]!.data?.count, 5);
});

test("one entry may not own more than a quarter of the buffer", () => {
  const buf = new BreadcrumbBuffer();
  buf.push({ ...crumb("y".repeat(40_000)), data: { blob: "z".repeat(10_000) } });
  const [only] = buf.drain();
  assert.ok(JSON.stringify(only).length <= 16_384 + 64);
  assert.equal(only!.data, undefined, "hard truncate sheds data first");
});

// ── redactObject ──────────────────────────────────────────────────

test("redactObject: key-first, then text rules on leaves, redactUrl on URL leaves", () => {
  assert.ok(isSensitiveKey("DB_PASSWORD") && isSensitiveKey("refreshToken") && !isSensitiveKey("username"));
  const out = redactObject({
    password: "hunter2", // innocent-looking value; the key condemns it
    credentials: { user: "a", pass: "b" }, // condemned wholesale, never walked for salvage
    url: "https://api.test/x?session=abc123&page=2",
    note: "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef1234567890abcdef",
    count: 7,
  }) as Record<string, unknown>;
  assert.equal(out.password, "[redacted]");
  assert.equal(out.credentials, "[redacted]");
  assert.ok(!String(out.url).includes("abc123"), `url leaf went through redactUrl: ${String(out.url)}`);
  assert.ok(String(out.url).includes("page"), "non-sensitive param survives as a name");
  assert.ok(!String(out.note).includes("eyJhbGciOiJIUzI1NiJ9"), "text leaf went through redactText");
  assert.equal(out.count, 7, "numbers pass untouched");
});

// ── the recorder end-to-end, corpus included ────────────────────────────────

function liveHandle(w = fakeWin()): { w: FakeWin; h: ReturnType<typeof installTierC> } {
  return { w, h: installTierC({ win: asWin(w) }) };
}

test("Tier C console: log and debug record (debug as info), call-through preserved", () => {
  const { w, h } = liveHandle();
  assert.equal(w.console.log("shipped %d units", 3), "log-out");
  w.console.debug("noise");
  // FILTERED, and the filter is the point. The 4 ms redaction guard emits a
  // `system` notice, and on a cold JIT under a 2-core runner the FIRST record
  // of a fresh handle blows that budget legitimately — so an exact-list assert
  // here is really an assert about how fast the machine is. It failed the
  // 0.0.3 publish on 2026-09-01 having passed every local run, which is the
  // same shape as the seeding bug documented below. The two tests either side
  // of this one already filter by type; this one just never did.
  const out = h.drain().filter((b) => b.type !== "system");
  assert.deepEqual(out.map((b) => [b.type, b.level]), [["console", "log"], ["console", "info"]]);
  assert.equal(out[0]!.message, "shipped %d units 3");
  h.destroy();
});

test("Blowing the 4 ms redaction budget truncates to 256 and says so ONCE", () => {
  // The guard above had no test at all — it only ever fired by accident, on
  // machines slow enough to make some OTHER test fail. Pinned here by the
  // technique the seeding test documents: a clock that jumps 5 ms per read
  // puts every record over budget by construction, on any machine.
  const real = performance.now.bind(performance);
  let t = 0;
  (performance as unknown as { now: () => number }).now = () => (t += 5);
  try {
    const { w, h } = liveHandle();
    w.console.log("x".repeat(600));
    w.console.log("second record, same handle");
    const all = h.drain();
    const notes = all.filter((b) => b.type === "system");
    assert.equal(notes.length, 1, "noted once per handle, not once per record");
    assert.match(notes[0]!.message, /exceeded the redaction budget/);
    const logs = all.filter((b) => b.type === "console");
    assert.equal(logs.length, 2, "the records themselves still land — truncated, never dropped");
    // `cap` keeps 256 and then APPENDS `…[+n]`, so a truncated message is
    // longer than its own cap. Asserting `length <= 256` would be asserting
    // the marker away.
    assert.match(logs[0]!.message, /^x{256}…\[\+\d+\]$/, "cut to 256, and it says how much it lost");
    assert.equal(
      logs[1]!.message,
      "second record, same handle",
      "a short record is untouched — the budget truncates, it does not mangle",
    );
    h.destroy();
  } finally {
    (performance as unknown as { now: () => number }).now = real;
  }
});

test("fetch: metadata recorded off the DERIVED promise, rejection rethrown, self-traffic skipped", async () => {
  const w = fakeWin();
  (w as unknown as { fetch: unknown }).fetch = (input: string) =>
    input.includes("fail")
      ? Promise.reject(Object.assign(new Error("down"), { name: "TypeError" }))
      : Promise.resolve({ ok: false, status: 503, url: input, type: "basic", redirected: false });
  const h = installTierC({ win: asWin(w), backendOrigin: "https://api.snagset.test" });

  const res = (await (w as unknown as { fetch: (u: string) => Promise<{ status: number }> }).fetch(
    "https://site.test/data?apikey=k123456",
  )) as { status: number };
  assert.equal(res.status, 503, "rule 2 of P2 — the response reaches the host unchanged");
  await assert.rejects(
    (w as unknown as { fetch: (u: string) => Promise<unknown> }).fetch("https://site.test/fail"),
    /down/,
    "rule 5 — the rejection still reaches the host",
  );
  await (w as unknown as { fetch: (u: string) => Promise<unknown> }).fetch("https://api.snagset.test/v1/threads");

  const net = h.drain().filter((b) => b.type === "network");
  assert.equal(net.length, 2, "self-traffic never recorded (rule 10)");
  assert.equal(net[0]!.data?.status, 503);
  assert.ok(!JSON.stringify(net[0]).includes("k123456"), "URL redacted in message and data");
  assert.equal(net[1]!.data?.aborted, false);
  h.destroy();
});

test("navigation: subscribed, recorded redacted — never a second history patch", () => {
  let cb: ((from: string, to: string) => void) | null = null;
  const { w } = { w: fakeWin() };
  const h = installTierC({
    win: asWin(w),
    subscribeNav: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
  });
  cb!("https://site.test/a?token=secret123token456", "https://site.test/b");
  const nav = h.drain().filter((b) => b.type === "navigation");
  assert.equal(nav.length, 1);
  assert.ok(!nav[0]!.message.includes("secret123token456"));
  h.destroy();
  assert.equal(cb, null, "unsubscribed on destroy");
});

/**
 * Let the CHUNKED seeding finish, then drain.
 *
 * `installTierC` seeds the stub's backlog in "≤ 100 entries in ≤ 4 ms slices",
 * and every slice after the first runs as a macrotask — deliberately, so a
 * slow redaction cannot jank activation. A synchronous `drain()`
 * therefore races it. On an unloaded laptop both records land in the first
 * slice; when the budget expires first, the drain returns only the
 * dropped-count notice, `out.find(b => b.type === "navigation")` is undefined,
 * and the assertion below dies on `.message`.
 *
 * That is not a flaky product. It is a test reading a buffer that is still
 * filling — and it failed a release on 2026-08-28 after passing every local
 * run. Reproduced deterministically by making `performance.now()` jump 5 ms a
 * call: the synchronous drain saw 1 record of 3.
 *
 * `drain()` copies rather than clears, so polling it has no side effects.
 */
async function seeded(
  h: { drain(): { type: string; message: string }[] },
  want: number,
): Promise<{ type: string; message: string }[]> {
  for (let i = 0; i < 50; i++) {
    const out = h.drain();
    if (out.length >= want) return out;
    await new Promise((r) => setTimeout(r, 0));
  }
  return h.drain();
}

test("seeding: the stub backlog crosses into the buffer REDACTED, with losses counted", async () => {
  const w = fakeWin();
  const pre: PreRecord[] = [
    [1_700_000_000_000, "navigation", "info", "https://site.test/?sid=abc123def456"],
    [1_700_000_000_100, "console", "error", "login failed password=hunter2 for jane"],
  ];
  const early = {
    drain: (_sink: (r: PreRecord) => void) => ({ records: pre, dropped: 3 }),
    destroy: () => {},
  };
  const h = installTierC({ win: asWin(w), early });
  // Two seeded records, plus the dropped-count notice `drain()` unshifts.
  const out = await seeded(h, 3);
  assert.match(out[0]!.message, /3 earlier breadcrumbs dropped/);
  const nav = out.find((b) => b.type === "navigation")!;
  assert.ok(!nav.message.includes("abc123def456"), "navigation backlog through redactUrl");
  const con = out.find((b) => b.type === "console")!;
  assert.ok(!con.message.includes("hunter2"), "console backlog through redactText");
  assert.ok(con.message.includes("for jane"), "the rest of the line is untouched");
  assert.equal(h.status(), "truncated", "pre-activation losses make the status honest");
  h.destroy();
});

test("destroy: wrappers unwound, buffer emptied, drain yields nothing", () => {
  const w = fakeWin();
  const orig = w.console.log; // captured BEFORE install — the identity to restore
  const h = installTierC({ win: asWin(w) });
  w.console.log("kept?");
  h.destroy();
  assert.equal(w.console.log, orig);
  assert.deepEqual(h.drain(), []);
});

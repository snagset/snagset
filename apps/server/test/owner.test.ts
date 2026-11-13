import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/routes/owner.ts";

/**
 * Owner auth's password half.
 *
 * NO DATABASE. These are the two functions that decide whether somebody gets
 * into the dashboard, and they are pure, so they get tested where a failure is
 * unambiguous rather than inside a request where a wrong answer looks like a
 * wrong fixture.
 *
 * The cookie, session-row and CSRF halves are exercised end to end in
 * reviewlink.test.ts's harness shape and by the live check recorded in the
 * commit; what cannot be automated cheaply is the timing property below, which
 * is asserted structurally instead — see the third test.
 */

test("a password round-trips, and only that password", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", stored), true);
  assert.equal(verifyPassword("correct horse battery stapl", stored), false);
  assert.equal(verifyPassword("Correct horse battery staple", stored), false);
  assert.equal(verifyPassword("", stored), false);
});

test("the same password hashes differently every time — the salt is real", () => {
  const a = hashPassword("correct horse battery staple");
  const b = hashPassword("correct horse battery staple");
  assert.notEqual(a, b, "two hashes of one password must differ");
  // Both still verify: a salt that is not stored is a salt that does not work.
  assert.equal(verifyPassword("correct horse battery staple", a), true);
  assert.equal(verifyPassword("correct horse battery staple", b), true);
  assert.match(a, /^scrypt\$[\w-]+\$[\w-]+$/, "the format carries its own algorithm name");
});

/**
 * The account-enumeration property.
 *
 * A user with no password (OAuth-only) and an email with no user at all must
 * both cost what a real verification costs. The natural implementation —
 * `if (!stored) return false` — answers those two in microseconds and a real
 * one in ~100 ms, which is an oracle anybody can read over a few hundred
 * requests: it tells an attacker which addresses have accounts.
 *
 * Asserted as a RATIO with a generous bound rather than an absolute time,
 * because this runs on whatever machine CI has that day. Anything under ~10×
 * means the work is being done; the natural bug is a factor of ten thousand.
 */
test("a missing hash costs the same as a real one — no enumeration oracle", () => {
  const stored = hashPassword("correct horse battery staple");

  const t0 = performance.now();
  for (let i = 0; i < 3; i++) verifyPassword("whatever", stored);
  const real = performance.now() - t0;

  const t1 = performance.now();
  for (let i = 0; i < 3; i++) verifyPassword("whatever", null);
  const missing = performance.now() - t1;

  assert.equal(verifyPassword("whatever", null), false);
  assert.ok(
    missing > real / 10,
    `a missing hash took ${missing.toFixed(0)} ms against ${real.toFixed(0)} ms for a real one — ` +
      "that difference is readable over a few hundred requests and tells an attacker which " +
      "email addresses have accounts",
  );
});

test("a malformed stored hash is refused, not thrown on", () => {
  // A row written by a future argon2 path, or a truncated column, must fail
  // closed. Throwing here would be a 500 on the login route, which is both an
  // outage and a signal that this particular account is interesting.
  for (const bad of ["", "scrypt$", "scrypt$onlytwo", "argon2id$x$y$z", "not-a-hash"]) {
    assert.equal(verifyPassword("anything", bad), false, `refused: ${JSON.stringify(bad)}`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeEmail, MAX_EMAIL_LENGTH } from "../src/email.ts";

/**
 * The one question six routes ask of a string somebody typed. No database:
 * what is being held here is an ORDER — the length before the pattern.
 */

test("an address is something, an @, something, a dot, something — and no longer than an address can be", () => {
  for (const ok of ["ada@kilnwork.test", "a@b.c", "ada+snags@mail.kilnwork.test", "ada.l@kilnwork.co.uk"]) assert.equal(looksLikeEmail(ok), true, ok);
  for (const no of ["", "ada", "ada@", "@kilnwork.test", "ada@kilnwork", "ada @kilnwork.test", "ada@kiln work.test", "ada@@kilnwork.test"]) {
    assert.equal(looksLikeEmail(no), false, JSON.stringify(no));
  }
  const local = "a".repeat(MAX_EMAIL_LENGTH - "@kilnwork.test".length);
  assert.equal(looksLikeEmail(`${local}@kilnwork.test`), true, "exactly the longest an address can be");
  assert.equal(looksLikeEmail(`a${local}@kilnwork.test`), false, "one character more");
});

test("an address is one plain address: nothing a mail program reads as a name, a list or a comment, and no dot at the end", () => {
  // Each of these was an address to the looser pattern. `a<b@c.d>` is a
  // display name and the address `b@c.d` to whatever sends it, so what was
  // counted and stored as one mailbox was delivered to another.
  for (const no of [
    "a<victim@corp.test>",
    '"victim"@corp.test',
    "victim(x)@corp.test",
    "victim@corp.test.",
    "victim@corp.test,",
    "a;victim@corp.test",
    "a:victim@corp.test",
    "a\\victim@corp.test",
    "victim@[corp.test]",
    "victim@corp.test>",
    "victim\u0000@corp.test",
    "victim@corp\u007f.test",
  ]) {
    assert.equal(looksLikeEmail(no), false, JSON.stringify(no));
  }
  for (const ok of ["o'neil@corp.test", "first.last+tag@sub.corp.test", "a_b-c@corp.co.uk", "x!#$%&*/=?^`{|}~y@corp.test"]) assert.equal(looksLikeEmail(ok), true, ok);
});

test("a string built to make the pattern backtrack is refused by its length, at once", () => {
  // `a@.a.a.a…@`: the pattern tries every dot as the last one and fails at
  // the final `@` each time, so the work is the square of the length — a
  // second and a half at 64 KB, 25 seconds at the 256 KB a JSON body may be.
  const hostile = `a@${".a".repeat(120_000)}@`;
  const began = performance.now();
  assert.equal(looksLikeEmail(hostile), false);
  const took = performance.now() - began;
  assert.ok(took < 250, `answered in ${took.toFixed(1)} ms`);
});

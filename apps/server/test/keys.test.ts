import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyring, keyId, KeyError, type KeyPurpose } from "../src/keys.ts";

/**
 * Key derivation.
 *
 * The vectors below are the enforcement the design asks for. Their value is not
 * that these particular hex strings are right; it is that a change to the
 * salt, the `info` encoding or the output length breaks them LOUDLY.
 *
 * Without a committed vector, such a change ships silently: the server signs
 * with a different key, every widget session fails to verify, and no component
 * anywhere reports an error — the token is well-formed, the signature is
 * genuine, it is simply a signature by someone else. That is the failure this
 * file exists to make impossible.
 */

const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ"; // 32 bytes, base64url
const OTHER = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ";

test("GOLDEN VECTOR: a fixed secret derives fixed keys — change this and you have changed derivation", () => {
  const ring = createKeyring(SECRET);
  const got = Object.fromEntries(
    (["reviewer-session", "credential-enc", "attachment-url", "webhook-sign", "unsubscribe"] as KeyPurpose[]).map(
      (p) => [p, ring.derive(p).toString("hex")],
    ),
  );

  // PINNED. If this fails and you did not intend to change the salt, the info
  // encoding or the output length, then something changed one of them for you
  // — do not update the vector, find the change. Updating it is how a
  // derivation break gets committed as a passing test.
  assert.deepEqual(got, {
    "reviewer-session": "346a667c585f0fab3b7157728590ad16952c37876eeedd7f65d814e6bc44310a",
    "credential-enc": "a2642791584b914d424ec186a0eaabb33645e6e65a21dadbbca62371e3bf7d5a",
    "attachment-url": "1f7c7b74d974d95e41f8aded1ba024f46d8a07c2930388f8e1b7ab5c695243c5",
    "webhook-sign": "188c522d0cf3b2a95ee1daeff716c5c24272e2412f9a33a34089ff3124bf1288",
    // Added with the purpose itself (B2). Pinned on the day it was introduced,
    // which is the only day the number can be established without suspicion.
    unsubscribe: "6514fa033643299bed7bc89d162c4d305e99b4d6df86795f06e3444f48bfb37a",
  });
  assert.equal(ring.kid, "Iq9hnSYCzYN");

  // The properties that actually matter, asserted directly:
  for (const [purpose, hex] of Object.entries(got)) {
    assert.equal(hex.length, 64, `${purpose} is 32 bytes`);
  }
  assert.equal(new Set(Object.values(got)).size, 5, "all five purposes derive DIFFERENT keys");
});

test("derivation is deterministic across keyrings — two processes agree", () => {
  // The whole point: an instance behind a load balancer signs on one process
  // and verifies on another.
  assert.deepEqual(
    createKeyring(SECRET).derive("reviewer-session"),
    createKeyring(SECRET).derive("reviewer-session"),
  );
});

test("a different secret derives a different key for the same purpose", () => {
  assert.notDeepEqual(
    createKeyring(SECRET).derive("reviewer-session"),
    createKeyring(OTHER).derive("reviewer-session"),
  );
});

test("the purpose union is CLOSED — an unknown one throws rather than deriving", () => {
  // "A purpose not on this list is a boot failure, not a warning
  // an unrecognised derivation silently produces a valid key for the wrong
  // thing." `'session'` is the specific one draft 3 shipped, .4's
  // `'reviewer-session'`, so nothing it signed verified.
  const ring = createKeyring(SECRET);
  for (const bad of ["session", "review-link", "ip-hash", "Reviewer-Session", ""]) {
    assert.throws(() => ring.derive(bad as KeyPurpose), KeyError, `"${bad}" must be refused`);
  }
});

test("kid is 11 chars, stable, and different per secret", () => {
  assert.equal(keyId(SECRET).length, 11);
  assert.equal(keyId(SECRET), keyId(SECRET));
  assert.notEqual(keyId(SECRET), keyId(OTHER));
  assert.match(keyId(SECRET), /^[A-Za-z0-9_-]{11}$/, "base64url, url-safe");
  assert.equal(createKeyring(SECRET).kid, keyId(SECRET));
});

test("kid resolves to its OWN key, and to the previous one during rotation", () => {
  const ring = createKeyring(SECRET, OTHER);
  assert.deepEqual(ring.forKid(keyId(SECRET), "reviewer-session"), createKeyring(SECRET).derive("reviewer-session"));
  assert.deepEqual(ring.forKid(keyId(OTHER), "reviewer-session"), createKeyring(OTHER).derive("reviewer-session"));
});

test("an unknown kid resolves to NOTHING — never 'try both keys'", () => {
  // Trying every key makes `kid` decorative and keeps a retired key live past
  // the 24-hour overlap it exists to bound. Rejecting is what lets rotation
  // finish.
  const ring = createKeyring(SECRET, OTHER);
  assert.equal(ring.forKid("notarealkid", "reviewer-session"), null);
  assert.equal(ring.forKid("", "reviewer-session"), null);
});

test("without SNAGSET_SECRET_KEY_PREVIOUS, the old kid stops resolving", () => {
  // The end of the overlap window is a configuration change, not a timer, and
  // this is what makes removing the variable actually retire the key.
  const rotated = createKeyring(SECRET);
  assert.equal(rotated.forKid(keyId(OTHER), "reviewer-session"), null);
});

test("an empty secret is refused at construction, not at first use", () => {
  // A server that boots and then fails to sign the first session is a server
  // whose failure arrives in front of a reviewer.
  assert.throws(() => createKeyring(""), KeyError);
});

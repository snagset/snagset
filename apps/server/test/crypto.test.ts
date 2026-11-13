import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyring } from "../src/keys.ts";
import { seal, open } from "../src/crypto.ts";
import { storageKeyFor } from "../src/storage/bucket.ts";

/**
 * Secrets at rest — AES-256-GCM under `credential-enc`.
 *
 * The tampering test is the one that matters. GCM was chosen over CBC
 * precisely so a modified ciphertext FAILS rather than decrypting to garbage
 * that some later `JSON.parse` has to survive — and "fails" here has to mean
 * a null, not a thrown exception that takes the boot down, because the
 * lost-key case must degrade to "storage disconnected" rather than "the
 * server will not start".
 */

const KEYS = createKeyring("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ");
const OTHER = createKeyring("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ");
const SECRET = JSON.stringify({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t/value+here" });

test("a sealed secret opens again, byte for byte", () => {
  const sealed = seal(KEYS, SECRET);
  assert.equal(open(KEYS, sealed), SECRET);
});

test("the ciphertext does not contain the plaintext", () => {
  const sealed = seal(KEYS, SECRET);
  assert.equal(sealed.ciphertext.toString("utf8").includes("s3cr3t"), false);
  assert.equal(sealed.ciphertext.toString("base64").includes("s3cr3t"), false);
});

test("two seals of the same value differ — the IV is fresh each time", () => {
  // Deterministic ciphertext leaks equality: an operator reusing one key
  // across two projects would be visible in a `pg_dump` diff.
  const a = seal(KEYS, SECRET);
  const b = seal(KEYS, SECRET);
  assert.notDeepEqual(a.iv, b.iv);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert.equal(open(KEYS, a), open(KEYS, b));
});

test("the IV is 12 bytes — GCM's canonical nonce length", () => {
  assert.equal(seal(KEYS, SECRET).iv.length, 12);
});

test("TAMPERING is detected, and returns null rather than garbage", () => {
  // The whole reason for GCM over CBC. Without the tag, a flipped byte
  // decrypts to something, and that something reaches a JSON parser.
  const sealed = seal(KEYS, SECRET);
  const bent = Buffer.from(sealed.ciphertext);
  bent[0] = bent[0]! ^ 0xff;
  assert.equal(open(KEYS, { ciphertext: bent, iv: sealed.iv }), null);
});

test("a truncated ciphertext is null, not a throw", () => {
  const sealed = seal(KEYS, SECRET);
  assert.equal(open(KEYS, { ciphertext: sealed.ciphertext.subarray(0, 8), iv: sealed.iv }), null);
});

test("the WRONG KEY returns null — the lost-key case, degrading not crashing", () => {
  // "Without it, integration credentials and identity secrets are
  // unrecoverable ciphertext." The server must still boot and report storage
  // as disconnected; a throw here would be a server that will not start.
  const sealed = seal(KEYS, SECRET);
  assert.equal(open(OTHER, sealed), null);
});

test("a wrong IV is null", () => {
  const sealed = seal(KEYS, SECRET);
  assert.equal(open(KEYS, { ciphertext: sealed.ciphertext, iv: Buffer.alloc(12, 1) }), null);
});

test("storage keys are content HASHES, never a reviewer's filename", () => {
  // "storage keys are hashes ". A key derived from user
  // input is a path traversal, a collision and an information leak in one
  // field.
  const bytes = new TextEncoder().encode("pretend this is a webp");
  const key = storageKeyFor("11111111-2222-3333-4444-555555555555", bytes, "webp");
  assert.match(key, /^11111111-2222-3333-4444-555555555555\/[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/);
  assert.equal(key.includes(".."), false);
});

test("identical bytes produce ONE key — the same screenshot is stored once", () => {
  const a = new TextEncoder().encode("same pixels");
  const b = new TextEncoder().encode("same pixels");
  const p = "11111111-2222-3333-4444-555555555555";
  assert.equal(storageKeyFor(p, a, "webp"), storageKeyFor(p, b, "webp"));
  assert.notEqual(storageKeyFor(p, a, "webp"), storageKeyFor(p, new TextEncoder().encode("other"), "webp"));
});

test("…and the project prefixes it, so erasure can list by prefix", () => {
  const bytes = new TextEncoder().encode("x");
  assert.notEqual(
    storageKeyFor("11111111-2222-3333-4444-555555555555", bytes, "webp"),
    storageKeyFor("99999999-2222-3333-4444-555555555555", bytes, "webp"),
  );
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_KEY } from "@snagset/types/names";

/**
 * `snag:identity` — the project map, and the collision that made it.
 *
 * The bug these tests exist for shipped and reached a live database: two
 * modules wrote this one key with different shapes, the composer wrote last,
 * and the "holder secret" became the reviewer's DISPLAY NAME. Since
 * `reviewers.holder_secret_hash` is `sha256(secret)` under a unique index that
 * the design calls "one row per PERSON", two people who both typed "the maintainer"
 * collapsed into one reviewer.
 *
 * So the assertions below are not about the shape for its own sake. Two of
 * them state the property directly: writing a name must not destroy a secret,
 * and two identities that share a name must not share a secret.
 */

// A localStorage that behaves like the real one, including throwing.
let store: Map<string, string>;
let throwOnAccess = false;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => {
    if (throwOnAccess) throw new DOMException("denied");
    return store.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    if (throwOnAccess) throw new DOMException("denied");
    store.set(k, v);
  },
  removeItem: (k: string) => void store.delete(k),
};
if (!globalThis.crypto?.getRandomValues) {
  throw new Error("this suite needs WebCrypto — Node 20+ provides it globally");
}

const { readIdentity, writeIdentity, holderId, holderSecretOrUndefined, rememberHolder, rememberHolderId } =
  await import("../src/storage/identity.ts");

/** A server-minted secret, in the shape the server actually returns. */
const SECRET_A = "a".repeat(43);
const SECRET_B = "b".repeat(43);

const raw = (): string | null => store.get(IDENTITY_KEY) ?? null;

beforeEach(() => {
  store = new Map();
  throwOnAccess = false;
});

test("the secret is what the SERVER returned, stored verbatim", () => {
  // The server mints it and returns it once. This module does not
  // mint — a client-minted secret is one the server never agreed to, and the
  // first version of this file did exactly that because the exchange did not
  // exist yet.
  rememberHolder("prj_aaaaaaaaaaaa", "rev_0123456789ab", SECRET_A);
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), SECRET_A);
  assert.equal(holderId("prj_aaaaaaaaaaaa"), "rev_0123456789ab");
});

test("nothing stored yet means nothing presented — the first exchange is anonymous", () => {
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), undefined);
  assert.equal(holderId("prj_aaaaaaaaaaaa"), undefined);
});

test("THE BUG: writing a name does not destroy the secret beside it", () => {
  // Two modules, one key, last writer wins — and the composer wrote last, so
  // the stored secret became the literal text `{"name":"the maintainer"}`.
  rememberHolder("prj_aaaaaaaaaaaa", "rev_0123456789ab", SECRET_A);
  writeIdentity({ name: "Edith", email: "mail@example.test" });
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), SECRET_A, "the secret survived the name write");
  assert.equal(readIdentity().name, "Edith");
  assert.equal(readIdentity().email, "mail@example.test");
});

test("THE BUG: a display name is never mistaken for a secret", () => {
  // `reviewers.holder_secret_hash` is sha256(secret) under a unique index that
  // the design calls "one row per PERSON". With the name as the secret, two
  // people who both typed "the maintainer" hashed identically and became one row.
  writeIdentity({ name: "Edith" });
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), undefined, "a name is not a credential");
});

test("a malformed stored secret is DROPPED rather than presented", () => {
  // The exact broken state a live browser was left in. Presenting it would
  // fail a hash comparison; dropping it mints a fresh identity, which the design
  // requires ("a stale storage entry must never lock a reviewer out").
  store.set(
    IDENTITY_KEY,
    JSON.stringify({ projects: { prj_aaaaaaaaaaaa: { holderSecret: '{"name":"Edith"}' } } }),
  );
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), undefined);
});

test("the secret is stable across reads — a returning reviewer is the same person", () => {
  rememberHolder("prj_aaaaaaaaaaaa", "rev_0123456789ab", SECRET_A);
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), SECRET_A);
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), SECRET_A);
});

test("…and scoped PER PROJECT, so two servers cannot correlate one reviewer", () => {
  rememberHolder("prj_aaaaaaaaaaaa", "rev_0123456789ab", SECRET_A);
  rememberHolder("prj_bbbbbbbbbbbb", "rev_ba9876543210", SECRET_B);
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), SECRET_A);
  assert.equal(holderSecretOrUndefined("prj_bbbbbbbbbbbb"), SECRET_B);
  assert.notEqual(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), holderSecretOrUndefined("prj_bbbbbbbbbbbb"));
});

test("a legacy bare-name value is read, not discarded", () => {
  // Pre- machines hold exactly this, some with a real comment on them.
  store.set(IDENTITY_KEY, "Edith");
  assert.equal(readIdentity().name, "Edith");
  rememberHolder("prj_aaaaaaaaaaaa", "rev_0123456789ab", SECRET_A);
  assert.equal(readIdentity().name, "Edith", "and the name survived the holder write");
});

test("a legacy {name,email} value keeps both when a holder arrives", () => {
  store.set(IDENTITY_KEY, JSON.stringify({ name: "Edith", email: "mail@example.test" }));
  rememberHolder("prj_aaaaaaaaaaaa", "rev_0123456789ab", SECRET_A);
  const id = readIdentity();
  assert.equal(id.name, "Edith");
  assert.equal(id.email, "mail@example.test");
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), SECRET_A);
});

test("the holder id can be updated without replacing the secret", () => {
  rememberHolder("prj_aaaaaaaaaaaa", "rev_0123456789ab", SECRET_A);
  rememberHolderId("prj_aaaaaaaaaaaa", "rev_ffffffffffff");
  assert.equal(holderId("prj_aaaaaaaaaaaa"), "rev_ffffffffffff");
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), SECRET_A);
});

test("storage denied is a working widget, not a thrown one", () => {
  throwOnAccess = true;
  assert.doesNotThrow(() => readIdentity());
  assert.doesNotThrow(() => writeIdentity({ name: "Edith" }));
  assert.doesNotThrow(() => rememberHolder("prj_aaaaaaaaaaaa", "rev_1", SECRET_A));
  assert.equal(holderSecretOrUndefined("prj_aaaaaaaaaaaa"), undefined, "no session persists, and nothing breaks");
});

test("ONE module owns this key — a second writer is how the bug happened", async () => {
  // A source check, because the defect was not visible in either file alone.
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = new URL("../src/", import.meta.url).pathname;
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : [],
    );
  const writers = walk(src).filter(
    (f) => !f.endsWith("storage/identity.ts") && /setItem\(\s*IDENTITY_KEY/.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(writers, [], "only storage/identity.ts may write snag:identity");
});

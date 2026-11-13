import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSecretKey, tokenHash, unclaimedBanner } from "../src/boot.ts";
import { loadConfig } from "../src/config.ts";

/**
 * The parts that need no database.
 *
 * The claim flow's DATABASE half is exercised by `test/setup.test.ts`, which
 * skips without a live `DATABASE_URL` — this file holds what must hold on
 * every machine, including a CI runner with no Postgres.
 */

const DB = "postgres://localhost:5432/snagset";
const tmp = (): string => mkdtempSync(join(tmpdir(), "snagset-boot-"));

test("the banner points at the instance, and a box that actually closes", () => {
  // The URL and the recovery command are both gone from this banner, because
  // both were about a token nothing mints any more. What it must still
  // do is name the address to open and stay a box — a banner that misaligns
  // is the one piece of output the whole self-host install depends on being
  // read.
  const base = "https://review.example.com";
  const lines = unclaimedBanner(base).split("\n");
  assert.ok(lines.some((l) => l.includes(`${base}/`)), "the instance address is in the banner");
  assert.equal(new Set(lines.map((l) => [...l].length)).size, 1, "every line is the same width");
  assert.ok(
    /first person/i.test(unclaimedBanner(base)),
    "and it says the part that matters: whoever opens it first owns it",
  );
  assert.ok(!/claim=/.test(unclaimedBanner(base)), "no token, because none is minted");
});

test("the claim token is stored as a HASH — never the token itself", () => {
  // "Store **only** sha256(token)". This is why a lost claim URL
  // cannot be re-printed and `bootstrap` mints a new one instead.
  const token = "Yx7fabcdef";
  const h = tokenHash(token);
  assert.equal(h.length, 32);
  assert.notEqual(h.toString("base64url"), token);
  assert.deepEqual(tokenHash(token), h, "and it is deterministic, or the compare never matches");
});

test("a generated signing key lands at <data>/secret.key, mode 0600", () => {
  const dir = tmp();
  const cfg = loadConfig({ DATABASE_URL: DB });
  const logged: string[] = [];
  const key = resolveSecretKey(cfg, dir, (_l, m) => logged.push(m));

  const path = join(dir, "secret.key");
  assert.ok(existsSync(path), "the key file exists");
  assert.equal(statSync(path).mode & 0o777, 0o600, "0600 — not readable by anyone else");
  assert.equal(readFileSync(path, "utf8").trim(), key);
  assert.ok(Buffer.from(key, "base64url").length >= 32, "base64url, ≥ 32 B");
  // The WARN matters as much as the file: The design lists this key as the one thing
  // a backup that omits it cannot recover from.
  assert.match(logged.join(" "), /BACK THIS UP/);
});

test("a second boot REUSES the key on disk — a new one kills every session", () => {
  const dir = tmp();
  const cfg = loadConfig({ DATABASE_URL: DB });
  const first = resolveSecretKey(cfg, dir, () => {});
  const second = resolveSecretKey(cfg, dir, () => {});
  assert.equal(second, first);
});

test("the env form wins over generation, and _FILE wins over the env form", () => {
  const dir = tmp();
  // "Where both are set, `_FILE` wins and a WARN is logged" — a key
  // in an environment variable ends up in config dashboards and crash dumps.
  const inline = loadConfig({ DATABASE_URL: DB, SNAGSET_SECRET_KEY: "from-env" });
  assert.equal(resolveSecretKey(inline, dir, () => {}), "from-env");
  assert.ok(!existsSync(join(dir, "secret.key")), "and nothing was generated");

  const keyFile = join(tmp(), "key");
  writeFileSync(keyFile, "from-file\n");
  const logged: string[] = [];
  const both = loadConfig({
    DATABASE_URL: DB,
    SNAGSET_SECRET_KEY: "from-env",
    SNAGSET_SECRET_KEY_FILE: keyFile,
  });
  assert.equal(resolveSecretKey(both, dir, (_l, m) => logged.push(m)), "from-file");
  assert.match(logged.join(" "), /_FILE form wins/);
});

test("on serverless, a missing key is FATAL and says why", () => {
  // The filesystem is ephemeral, so generating one would mint a
  // different key on every cold start — every session dead, every stored
  // credential unreadable. Failing at boot is the kind outcome.
  const cfg = loadConfig({ DATABASE_URL: DB });
  assert.throws(
    () => resolveSecretKey(cfg, null, () => {}),
    /required on serverless[\s\S]*cold start/,
  );
});

test("SNAGSET_DATA_DIR is registered, and defaults to something that works", () => {
  // It is `<data>` in five places in 08 and was registered nowhere, so the one
  // path the bin writes to had no name the boot validator would accept.
  assert.equal(loadConfig({ DATABASE_URL: DB }).get("SNAGSET_DATA_DIR"), "./.snagset");
  assert.equal(
    loadConfig({ DATABASE_URL: DB, SNAGSET_DATA_DIR: "/var/lib/snagset" }).get("SNAGSET_DATA_DIR"),
    "/var/lib/snagset",
  );
});

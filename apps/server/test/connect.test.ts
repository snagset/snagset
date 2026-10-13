import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalHost, sslFor } from "../src/db/connect.ts";

/**
 * `SNAGSET_DATABASE_SSL`: `auto` = require unless the host is
 * local. Registered from the first draft and read by nothing until 2026-10,
 * which meant a Supabase string (no `sslmode` in it) connected in plaintext.
 * These are the rules, pinned, so the setting cannot go unread again.
 */

const SUPABASE_POOLER = "postgres://postgres.abcdefghijklmnop:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
const NEON = "postgres://neondb_owner:pw@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const LOCAL = "postgres://postgres@127.0.0.1:54329/snagset_test";

test("auto requires TLS for a public host whose URL says nothing — the Supabase string", () => {
  assert.equal(sslFor(SUPABASE_POOLER), "require");
  assert.equal(sslFor(SUPABASE_POOLER, "auto"), "require");
});

test("auto leaves a URL that carries its own sslmode to postgres.js — the Neon string", () => {
  // `undefined` means "do not override": postgres.js reads `sslmode` itself,
  // and a provider that wrote it into the string knew its endpoint.
  assert.equal(sslFor(NEON), undefined);
  assert.equal(sslFor(LOCAL + "?sslmode=disable"), undefined);
  assert.equal(sslFor(LOCAL + "?ssl=true"), undefined);
});

test("auto stays plaintext for local hosts, where a dev or a CI Postgres has no certificate", () => {
  for (const url of [
    LOCAL,
    "postgres://u@localhost/db",
    "postgres://u@db.localhost/db",
    "postgres://u@[::1]:5432/db",
    "postgres://u@10.0.3.4/db",
    "postgres://u@172.20.0.2/db",
    "postgres://u@192.168.1.10/db",
    "postgres://u@postgres:5432/db", // a compose service name
  ]) {
    assert.equal(sslFor(url), undefined, url);
  }
});

test("require and disable are the operator's word, whatever the URL says", () => {
  assert.equal(sslFor(LOCAL, "require"), "require");
  assert.equal(sslFor(NEON, "disable"), false);
  assert.equal(sslFor(SUPABASE_POOLER, "disable"), false);
});

test("an unparseable URL is left for loadConfig to refuse", () => {
  assert.equal(sslFor("not a url"), undefined);
});

test("isLocalHost draws the line at the private ranges and single-label names", () => {
  for (const h of ["localhost", "127.0.0.1", "127.9.9.9", "::1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "fd12::1", "fe80::1", "db", "/var/run/postgresql"]) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ["172.32.0.1", "11.0.0.1", "8.8.8.8", "aws-0-eu-central-1.pooler.supabase.com", "db.abcdefghijklmnop.supabase.co", "ep-x.neon.tech", "2600:1f18::1"]) {
    assert.equal(isLocalHost(h), false, h);
  }
});

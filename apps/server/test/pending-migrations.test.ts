import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type postgres from "postgres";
import { connect } from "../src/db/connect.ts";
import { migrate, pendingMigrations, forgetPendingMigrations } from "../src/db/migrate.ts";

/**
 * "Is the database behind this build?" — the dashboard's banner and the log
 * line. Found upgrading a production instance to 0.1.11 on Vercel, where nothing
 * migrates by itself and the new code ran against the old schema unnoticed.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the pending-migration tests";

let sql: postgres.Sql;
const shipped = readdirSync(join(import.meta.dirname, "..", "src", "db", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  }
  sql = connect(URL_!, { max: 2 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

test("a database nobody has migrated is behind by every file", { skip }, async () => {
  forgetPendingMigrations();
  assert.deepEqual(await pendingMigrations(sql), shipped);
});

test("a migrated database is behind by nothing", { skip }, async () => {
  await migrate(sql, () => {});
  forgetPendingMigrations();
  assert.deepEqual(await pendingMigrations(sql), []);
});

test("a release's new file not yet run is named — and the answer is cached a minute", { skip }, async () => {
  const last = shipped[shipped.length - 1]!;
  await sql`DELETE FROM _migrations WHERE name = ${last}`;
  forgetPendingMigrations();
  const t = Date.now();
  assert.deepEqual(await pendingMigrations(sql, t), [last]);
  // Put it back: within the minute the cached answer stands, after it the truth.
  await sql`INSERT INTO _migrations (name, checksum, duration_ms) VALUES (${last}, 'x', 0)`;
  assert.deepEqual(await pendingMigrations(sql, t + 30_000), [last]);
  assert.deepEqual(await pendingMigrations(sql, t + 61_000), []);
});

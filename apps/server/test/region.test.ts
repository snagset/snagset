import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseRegion, regionMismatch } from "../src/instance/region.ts";

/**
 * Functions in one region, the database in another — found on a real
 * deployment whose vercel.json set no `regions`: Washington functions, a
 * London database, every query across the Atlantic.
 */

const NEON_LONDON = "postgresql://u:p@ep-cool-name-a1b2c3-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
const SUPABASE_FRANKFURT = "postgresql://postgres.abc:p@aws-1-eu-central-1.pooler.supabase.com:6543/postgres";

test("the database's region is read from a Neon or Supabase pooler host, and nothing else is guessed", () => {
  assert.equal(databaseRegion(NEON_LONDON), "eu-west-2");
  assert.equal(databaseRegion(SUPABASE_FRANKFURT), "eu-central-1");
  assert.equal(databaseRegion("postgresql://u:p@db.abc.supabase.co:5432/postgres"), null);
  assert.equal(databaseRegion("postgresql://u:p@localhost:5432/snagset"), null);
  assert.equal(databaseRegion("not a url"), null);
  assert.equal(databaseRegion(undefined), null);
});

test("Washington functions and a London database are a mismatch, with lhr1 as the fix", () => {
  assert.deepEqual(regionMismatch("iad1", NEON_LONDON), {
    functions: "iad1 (Washington)",
    database: "eu-west-2 (London)",
    suggest: "lhr1",
  });
});

test("the same region, or anything unknown, says nothing", () => {
  assert.equal(regionMismatch("lhr1", NEON_LONDON), null);
  assert.equal(regionMismatch("fra1", SUPABASE_FRANKFURT), null);
  assert.equal(regionMismatch(undefined, NEON_LONDON), null, "not on Vercel");
  assert.equal(regionMismatch("iad1", "postgresql://u:p@localhost/x"), null, "a database we cannot place");
  assert.equal(regionMismatch("zzz9", NEON_LONDON), null, "a Vercel region we do not know");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPlatformDefaults } from "../src/platform.ts";

test("a platform's PORT becomes ours when we were given none", () => {
  const env: Record<string, string | undefined> = { PORT: "3000" };
  assert.equal(applyPlatformDefaults(env).port, "3000");
  assert.equal(env.SNAGSET_PORT, "3000");
  const ours: Record<string, string | undefined> = { PORT: "3000", SNAGSET_PORT: "8080" };
  assert.equal(applyPlatformDefaults(ours).port, null, "what the operator set wins");
  assert.equal(ours.SNAGSET_PORT, "8080");
  const junk: Record<string, string | undefined> = { PORT: "eighty" };
  assert.equal(applyPlatformDefaults(junk).port, null, "not a number, not a port");
});

test("the public address comes from the platform's own variable, https, no trailing slash", () => {
  for (const [vars, want, from] of [
    [{ VERCEL_PROJECT_PRODUCTION_URL: "review.kilnwork.studio" }, "https://review.kilnwork.studio", "VERCEL_PROJECT_PRODUCTION_URL"],
    [{ VERCEL_URL: "snagset-abc123.vercel.app" }, "https://snagset-abc123.vercel.app", "VERCEL_URL"],
    [{ RAILWAY_PUBLIC_DOMAIN: "snagset.up.railway.app" }, "https://snagset.up.railway.app", "RAILWAY_PUBLIC_DOMAIN"],
    [{ RENDER_EXTERNAL_URL: "https://snagset.onrender.com/" }, "https://snagset.onrender.com", "RENDER_EXTERNAL_URL"],
    [{ FLY_APP_NAME: "snagset" }, "https://snagset.fly.dev", "FLY_APP_NAME"],
  ] as const) {
    const env: Record<string, string | undefined> = { ...vars };
    const got = applyPlatformDefaults(env);
    assert.deepEqual(got.baseUrl, { value: want, from });
    assert.equal(env.SNAGSET_BASE_URL, want);
  }
});

test("the stable Vercel domain beats the per-deployment one, and anything the operator set beats both", () => {
  const both: Record<string, string | undefined> = { VERCEL_PROJECT_PRODUCTION_URL: "review.kilnwork.studio", VERCEL_URL: "snagset-abc123.vercel.app" };
  assert.equal(applyPlatformDefaults(both).baseUrl?.from, "VERCEL_PROJECT_PRODUCTION_URL");
  const set: Record<string, string | undefined> = { VERCEL_URL: "snagset-abc123.vercel.app", SNAGSET_BASE_URL: "https://review.studio" };
  assert.equal(applyPlatformDefaults(set).baseUrl, null);
  assert.equal(set.SNAGSET_BASE_URL, "https://review.studio");
  const legacy: Record<string, string | undefined> = { VERCEL_URL: "x.vercel.app", SNAGSET_PUBLIC_URL: "https://old.spelling" };
  assert.equal(applyPlatformDefaults(legacy).baseUrl, null, "the retired spelling still counts as set — the validator explains it");
});

test("nothing set is nothing done — a laptop stays a laptop", () => {
  const env: Record<string, string | undefined> = {};
  assert.deepEqual(applyPlatformDefaults(env), { port: null, baseUrl: null, database: null });
  assert.equal(Object.keys(env).length, 0);
});

test("the database comes from POSTGRES_URL when DATABASE_URL is unset — Vercel's Supabase integration", () => {
  const pooled = "postgres://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
  const env: Record<string, string | undefined> = { POSTGRES_URL: pooled, POSTGRES_URL_NON_POOLING: "postgres://direct" };
  assert.equal(applyPlatformDefaults(env).database, "POSTGRES_URL");
  assert.equal(env.DATABASE_URL, pooled, "the pooled name, never the direct one");
  const ours: Record<string, string | undefined> = { POSTGRES_URL: pooled, DATABASE_URL: "postgres://mine" };
  assert.equal(applyPlatformDefaults(ours).database, null, "what the operator set wins");
  assert.equal(ours.DATABASE_URL, "postgres://mine");
  const blank: Record<string, string | undefined> = { POSTGRES_URL: "  " };
  assert.equal(applyPlatformDefaults(blank).database, null);
  assert.equal(blank.DATABASE_URL, undefined);
});

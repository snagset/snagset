import { test } from "node:test";
import assert from "node:assert/strict";
import { envBucketConfig } from "../src/storage/settings.ts";

/**
 * Bucket configuration from the environment.
 *
 * Draft 4 retired these six variables and required the bucket to be connected
 * in a UI. That was overturned by the obvious question: `DATABASE_URL` is an
 * environment variable, and the stated reason for moving S3 out — a secret in
 * a `.env` reaches every backup and CI log — applies to it verbatim. A rule
 * that holds for one of two identical secrets is a preference.
 *
 * No database and no network: this is the pure decision the server makes
 * before it will talk to a bucket at all.
 */

const FULL = {
  SNAGSET_STORAGE_S3_ENDPOINT: "https://ams3.digitaloceanspaces.com",
  SNAGSET_STORAGE_S3_BUCKET: "snagset",
  SNAGSET_STORAGE_S3_ACCESS_KEY_ID: "DO00EXAMPLE",
  SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY: "s3cr3t",
};

test("no storage variables at all means no environment bucket — not an error", () => {
  // Annotation mode is a supported, complete product (A9b), so silence here is
  // the correct answer rather than a missing-config complaint.
  assert.equal(envBucketConfig({}), null);
  assert.equal(envBucketConfig({ DATABASE_URL: "postgres://x" }), null);
});

test("a full set builds the config, and region defaults to auto", () => {
  const got = envBucketConfig(FULL);
  assert.ok(got);
  assert.equal(got.config.endpoint, "https://ams3.digitaloceanspaces.com");
  assert.equal(got.config.bucket, "snagset");
  assert.equal(got.config.region, "auto", "auto suits R2, which is the common case");
  assert.equal(got.creds.accessKeyId, "DO00EXAMPLE");
  assert.equal(got.creds.secretAccessKey, "s3cr3t");
});

test("an explicit region is kept — Spaces and AWS both need a real one", () => {
  const got = envBucketConfig({ ...FULL, SNAGSET_STORAGE_S3_REGION: "ams3" });
  assert.equal(got?.config.region, "ams3");
});

test("a PARTIAL set is an error that names every missing variable", () => {
  // The failure this prevents: three of four set, the fourth typo'd, and the
  // instance silently in annotation mode — an operator told nothing at all,
  // wondering why screenshots do not appear.
  const { SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY: _drop, ...partial } = FULL;
  assert.throws(
    () => envBucketConfig(partial),
    (e: Error) => {
      assert.match(e.message, /SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY/);
      assert.match(e.message, /missing/);
      return true;
    },
  );

  assert.throws(
    () => envBucketConfig({ SNAGSET_STORAGE_S3_ENDPOINT: FULL.SNAGSET_STORAGE_S3_ENDPOINT }),
    (e: Error) => {
      // All three, not just the first — an operator fixing them one boot at a
      // time is an operator restarting three times.
      assert.match(e.message, /SNAGSET_STORAGE_S3_BUCKET/);
      assert.match(e.message, /SNAGSET_STORAGE_S3_ACCESS_KEY_ID/);
      assert.match(e.message, /SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY/);
      return true;
    },
  );
});

test("the public base URL rides along when set, and is absent when not", () => {
  assert.equal(envBucketConfig(FULL)?.config.publicBaseUrl, undefined);
  assert.equal(
    envBucketConfig({ ...FULL, SNAGSET_STORAGE_S3_PUBLIC_BASE_URL: "https://cdn.example" })?.config
      .publicBaseUrl,
    "https://cdn.example",
  );
});

test("a secret containing a slash needs no escaping — which is why these are six variables", () => {
  // The reason this is NOT one packed URL like SNAGSET_MAIL_URL: S3 secrets
  // routinely contain `/`, which cannot appear literally in a URL's userinfo.
  // An operator who missed the percent-encoding would see an auth failure that
  // reads as a wrong key.
  const awkward = "abc/def+ghi=jkl";
  const got = envBucketConfig({ ...FULL, SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY: awkward });
  assert.equal(got?.creds.secretAccessKey, awkward);
});

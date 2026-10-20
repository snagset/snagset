import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";

/**
 * Per-identity revocation, on the REQUEST path.
 *
 * The design says `identity_valid_after` is checked "on refresh AND on the
 * 10-second cache miss path". Only the refresh half was built, so calling a
 * host app's logout hook left the signed-out person working until their token
 * next refreshed — up to the full 15-minute sliding TTL rather than the ten
 * seconds that sentence describes.
 *
 * Project-wide revocation was never affected: `session_epoch` rides the
 * project cache and is compared at no cost on every request, so revoking a
 * LINK has always been ~10 s. It is the per-PERSON case — one reviewer signed
 * out while the round carries on — that ran wide.
 *
 * Its own fixtures on purpose. Doing this inside reviewlink.test.ts failed on
 * a session an earlier test had deliberately revoked, which is the same
 * shared-state trap the notification tests hit today.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the revocation tests";
const SECRET = Buffer.alloc(32, 13).toString("base64url");
const ORIGIN = "https://revoke.test";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let token: string;
let reviewerId: string;

before(async () => {
  if (skip) return;
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  app = createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
  });

  const orgId = randomUUID();
  const projectId = randomUUID();
  uid = "prj_07enw3ahrz6d";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Org', 'org')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt)
      VALUES (${projectId}, ${orgId}, ${uid}, 'P', ${Buffer.alloc(32, 1)})`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    await tx`INSERT INTO project_origins (id, org_id, project_id, pattern) VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${ORIGIN})`;
  });

  const res = await app.request(`/api/v1/projects/${uid}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      identity: { kind: "guest", name: "Ada", secret: "0123456789abcdef0123456789abcdef" },
    }),
  });
  const b = (await res.json()) as { sessionToken: string; reviewer: { id: string } };
  token = b.sessionToken;
  reviewerId = b.reviewer.id.replace(/^rev_/, "");
});

after(async () => {
  if (!skip) await sql.end();
});

const list = () =>
  app.request(`/api/v1/projects/${uid}/threads`, {
    headers: { authorization: `Bearer ${token}`, Origin: ORIGIN },
  });

test("the session works before anyone signs it out", { skip }, async () => {
  const res = await list();
  assert.equal(res.status, 200, await res.clone().text());
});

test("a signed-out reviewer is refused ONCE THE CACHE TURNS OVER", { skip }, async () => {
  /**
   * The window is the point, and my first version of this test got it wrong:
   * it asserted "on the next request", which the cache correctly refused to
   * deliver. The promise is the ten-second cache-miss path — the same
   * window a link revoke already lives in — not immediacy. Asserting
   * immediacy would have meant either a database read per request (the
   * property `bearerAuth` exists to avoid) or a test that passes by accident.
   *
   * So this drives the cache on its own clock rather than sleeping ten
   * seconds in a suite that runs hundreds of times a day.
   */
  const { createReviewerCache } = await import("../src/reviewerCache.ts");
  let clock = 1_000;
  const cache = createReviewerCache(sql, { ttlMs: 10_000, now: () => clock });

  assert.equal(await cache.validAfter(reviewerId), null, "not signed out to begin with");

  await sql`UPDATE reviewers SET identity_valid_after = now() WHERE id = ${reviewerId}::uuid`;

  // Inside the window the cached answer stands — that IS the bargain.
  assert.equal(await cache.validAfter(reviewerId), null, "a cached answer holds for its window");

  clock += 10_001;
  const after = await cache.validAfter(reviewerId);
  assert.ok(after instanceof Date, "past the window, the revoke is visible");
});

test("an operator revoking sees it at once on THIS node", { skip }, async () => {
  // `invalidate` is why a dashboard click does not feel like a ten-second lag
  // to the person who made it, even though the guarantee elsewhere is the
  // window.
  const { createReviewerCache } = await import("../src/reviewerCache.ts");
  const cache = createReviewerCache(sql);
  assert.ok(await cache.validAfter(reviewerId), "already signed out from the test above");

  await sql`UPDATE reviewers SET identity_valid_after = NULL WHERE id = ${reviewerId}::uuid`;
  cache.invalidate(reviewerId);
  assert.equal(await cache.validAfter(reviewerId), null, "invalidate re-reads rather than waiting");
});

test("a middleware holding a revoked verdict refuses with session_revoked", { skip }, async () => {
  // The wiring, without the clock: given a cache that says "signed out", the
  // request path must produce F-19's code rather than a silent downgrade to
  // read-only that looks like the widget quietly breaking.
  await sql`UPDATE reviewers SET identity_valid_after = now() WHERE id = ${reviewerId}::uuid`;
  const fresh = createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
  });
  const res = await fresh.request(`/api/v1/projects/${uid}/threads`, {
    headers: { authorization: `Bearer ${token}`, Origin: ORIGIN },
  });
  assert.equal(res.status, 401, await res.clone().text());
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "session_revoked");
});

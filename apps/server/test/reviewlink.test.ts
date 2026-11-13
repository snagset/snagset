import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { connect } from "../src/db/connect.ts";
import { randomUUID, createHash } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { DASHBOARD_SESSION_COOKIE, DASHBOARD_CSRF_COOKIE, HTTP_HEADER } from "@snagset/types/names";

/**
 * The share link, end to end against a real Postgres.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL`, and it drops the schema, so the
 * two guards in setup.test.ts apply here too.
 *
 * `--test-concurrency=1` in package.json is load-bearing for this file. Both
 * integration suites own the same schema, and node:test runs FILES in
 * parallel by default — so run together they dropped it out from under each
 * other and every assertion here failed while both passed alone.
 *
 * The assertions that carry the most weight are the two revocation ones. The decision
 * makes the link the ENTIRE access-control system, so "revoked" has to mean
 * both "cannot be redeemed again" and "everyone who already redeemed it is
 * out". A build that only did the first would pass a naive test and leave a
 * dismissed contractor commenting for twelve hours.
 *
 * MINT/LIST/DELETE NOW GO THROUGH REAL OWNER AUTH. They were previously
 * called with no cookie and no CSRF header at all — which meant this suite
 * was exercising `requireOwner()`'s absence, not its presence, and never
 * would have caught the missing org check that motivated T2. `login()` below
 * signs in for real and every mutating call carries the session + CSRF pair.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the share-link tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let projectId: string;
let orgId: string;
/** Owner auth for org A's project — {Cookie, x-snagset-csrf} to send on every mutating call. */
let auth: { cookie: string; csrf: string };
/** A second org's owner — used only by the cross-org 404 test. */
let auth2: { cookie: string; csrf: string };

const SECRET = Buffer.alloc(32, 9).toString("base64url");
const PASSWORD = "correct horse battery staple";

/**
 * Signs in and returns the {Cookie, csrf} pair every subsequent owner call
 * needs — the pair `requireOwner()` checks: the session cookie
 * proves who is asking, the `x-snagset-csrf` header (echoing the non-HttpOnly
 * csrf cookie) proves the request came from the dashboard's own JS and not a
 * cross-site page riding the cookie.
 */
async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  // FIX: `assert.equal(res.status, 200, \`...${await res.text()}\`)` evaluates its
  // template-literal third argument BEFORE assert runs, so the body was consumed
  // on every call regardless of whether the assertion failed. The next line then
  // threw "TypeError: Body is unusable: Body has already been read" reading
  // `res.json()` — every one of this suite's 17 cases crashed inside login()
  // before any route code ran. Read the body once, to text, and derive both the
  // failure message and the parsed JSON from that same string.
  const text = await res.text();
  assert.equal(res.status, 200, `login failed for ${email}: ${text}`);
  const cookie = res.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  assert.ok(cookie.includes(DASHBOARD_SESSION_COOKIE) && cookie.includes(DASHBOARD_CSRF_COOKIE));
  const { csrfToken } = JSON.parse(text) as { csrfToken: string };
  return { cookie, csrf: csrfToken };
}

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  }
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});

  // A claimed project, built directly: this suite is about links, and going
  // through /setup again would only re-test setup.
  orgId = randomUUID();
  projectId = randomUUID();
  uid = "prj_aaaaaaaaaaaa";
  const userId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, password_hash)
      VALUES (${userId}, ${orgId}, 'o@e.test', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt)
      VALUES (${projectId}, ${orgId}, ${uid}, 'Site', ${Buffer.alloc(32, 1)})`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, 'preview', 'Preview', false)`;
    await tx`
      INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, 1, 'Round 1', ${userId})`;
  });

  // A second org, with nothing to do with the first — the only fixture
  // needed to prove the cross-org 404 (T2's new test).
  const orgId2 = randomUUID();
  const userId2 = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId2}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId2}, 'Other Studio', 'other-studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, password_hash)
      VALUES (${userId2}, ${orgId2}, 'o2@e.test', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId2}, ${userId2}, 'owner')`;
  });

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

  auth = await login("o@e.test");
  auth2 = await login("o2@e.test");
});

after(async () => {
  // Hand the database back EMPTY. setup.test.ts refuses to run against a
  // database holding a claimed instance — that guard is the one that stops a
  // dev database being dropped — and this suite claims one, so leaving it
  // behind makes the two suites unrunnable together in either order. The
  // guard is right; the suite has to clean up after itself.
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>;

const mint = (body: Record<string, unknown>, as: { cookie: string; csrf: string } = auth) =>
  app.request(`/api/v1/projects/${uid}/review-links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: as.cookie,
      [HTTP_HEADER.csrf]: as.csrf,
    },
    body: JSON.stringify(body),
  });

const redeem = (body: Record<string, unknown>, bearer?: string) =>
  app.request(`/api/v1/projects/${uid}/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

let token: string;
let linkId: string;

test("mint returns the raw token ONCE, with a 43-char base64url shape", { skip }, async () => {
  const res = await mint({ name: "Client review — round 1" });
  assert.equal(res.status, 201);
  const b = await json(res);
  assert.match(b.token, /^[A-Za-z0-9_-]{43}$/, "32 bytes, unpadded base64url");
  assert.equal(b.fragment, `#snag_k=${b.token}`);
  assert.match(b.id, /^lnk_/);
  assert.equal(b.useCount, 0);
  token = b.token;
  linkId = b.id;

  // 14 days by default.
  const days = (Date.parse(b.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 13.9 && days < 14.1, `default TTL is 14 days, got ${days}`);
});

test("…and NO later response can produce it — the property", { skip }, async () => {
  const res = await app.request(`/api/v1/projects/${uid}/review-links`, { headers: { Cookie: auth.cookie } });
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(body.includes(linkId), "the link is listed");
  assert.ok(!body.includes(token), "but its token is not in the response");
  assert.equal(/[A-Za-z0-9_-]{43}/.test(body), false, "no 43-char token anywhere in the serialised body");
});

test("expiry is CLAMPED to 90 days on write, not trusted from the request", { skip }, async () => {
  const b = await json(await mint({ name: "Too generous", expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() }));
  const days = (Date.parse(b.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 89.9 && days < 90.1, `clamped to the 90-day ceiling, got ${days}`);
});

test("an unknown permission is refused rather than stored", { skip }, async () => {
  // Stored, it would be silently dropped at exchange — which reads to the
  // operator as "I granted it and it did nothing".
  const res = await mint({ name: "Typo", permissions: ["thread:privat"] });
  assert.equal(res.status, 422);
});

test("an owner from a DIFFERENT org gets 404 minting on this project — T2's cross-org fix", { skip }, async () => {
  // Before T2, `requireOwner()` only proved SOME org's owner was signed in;
  // nothing compared `owner.orgId` to the project's, so org B's owner could
  // mint/list/revoke org A's links by uid. 404, not 403 — a project uid
  // existing at all is not information another org gets to learn.
  const res = await mint({ name: "Should not exist" }, auth2);
  assert.equal(res.status, 404);
  assert.equal((await json(res)).error.code, "project_not_found");

  const list = await app.request(`/api/v1/projects/${uid}/review-links`, { headers: { Cookie: auth2.cookie } });
  assert.equal(list.status, 404);
});

let sessionToken: string;
let holderSecret: string;
let reviewerId: string;

test("redeeming the link mints a session and a reviewer", { skip }, async () => {
  const res = await redeem({
    environment: "production",
    identity: { kind: "link", token, name: "Ada" },
    client: { widget: "test", schema: "snagset.v1" },
  });
  assert.equal(res.status, 201);
  const b = await json(res);

  assert.ok(b.sessionToken.split(".").length === 3, "a JWT");
  assert.match(b.reviewer.id, /^rev_/);
  assert.equal(b.reviewer.kind, "link");
  // Returned ONCE, on first creation of this person.
  assert.match(b.holderSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(b.permissions, ["thread:create", "comment:create", "thread:resolve", "thread:delete:own"]);
  assert.equal(b.environment.key, "production");

  sessionToken = b.sessionToken;
  holderSecret = b.holderSecret;
  reviewerId = b.reviewer.id;

  // Hashed in JS, not with `digest()`: pgcrypto is not installed (
  // zero extensions), so that call errors, and the `.catch()` fallback this
  // originally had quietly selected "the first link" instead — a test that
  // passes by looking at the wrong row.
  const [link] = await sql<{ use_count: number; last_used_at: Date | null }[]>`
    SELECT use_count, last_used_at FROM review_links
    WHERE token_hash = ${createHash("sha256").update(token, "utf8").digest()}
  `;
  assert.ok(link, "the link is found by its hash");
  assert.equal(link!.use_count, 1, "use_count counts people");
  assert.ok(link!.last_used_at, "last_used_at is stamped");
});

test("the SAME holder redeeming again is ONE person, and use_count does not move", { skip }, async () => {
  // The ON CONFLICT … DO NOTHING RETURNING id: the increment happens only
  // on a returned id, which is what makes the count people rather than
  // exchanges.
  const b = await json(
    await redeem({
      environment: "production",
      identity: { kind: "link", token, holderId: reviewerId, holderSecret, name: "Ada" },
      client: { widget: "test", schema: "snagset.v1" },
    }),
  );
  assert.equal(b.reviewer.id, reviewerId, "same person");
  assert.equal(b.holderSecret, undefined, "the secret is NOT re-issued");

  const [n] = await sql<{ c: number }[]>`SELECT count(*)::int c FROM reviewers WHERE project_id = ${projectId}`;
  assert.equal(n!.c, 1, "one reviewer row");
});

test("a DIFFERENT holder on the same link is a second person", { skip }, async () => {
  const b = await json(
    await redeem({
      environment: "production",
      identity: { kind: "link", token, name: "Grace" },
      client: { widget: "test", schema: "snagset.v1" },
    }),
  );
  assert.notEqual(b.reviewer.id, reviewerId);
  const [n] = await sql<{ c: number }[]>`SELECT count(*)::int c FROM reviewers WHERE project_id = ${projectId}`;
  assert.equal(n!.c, 2);
});

test("a stale holder secret mints a NEW identity rather than locking anyone out", { skip }, async () => {
  // Verbatim: "a mismatch does not error — it silently mints a new
  // guest identity, because a stale storage entry must never lock a reviewer
  // out."
  const res = await redeem({
    environment: "production",
    identity: { kind: "link", token, holderId: reviewerId, holderSecret: "x".repeat(43), name: "Ada" },
    client: { widget: "test", schema: "snagset.v1" },
  });
  assert.equal(res.status, 201, "not an error");
  const b = await json(res);
  assert.notEqual(b.reviewer.id, reviewerId, "a new person");
});

test("a request that tries to grant itself visibility is 422", { skip }, async () => {
  // Nothing about visibility is ever taken from the request. Refused
  // rather than ignored — dropping it silently teaches the caller it worked.
  for (const field of ["role", "isTeam", "includePrivate", "permissions"]) {
    const res = await redeem({
      environment: "production",
      identity: { kind: "link", token },
      [field]: field === "permissions" ? ["thread:private"] : true,
      client: { widget: "test", schema: "snagset.v1" },
    });
    assert.equal(res.status, 422, field);
  }
});

test("a TEAM link carries thread:private and thread:assign; a client link never does", { skip }, async () => {
  const team = await json(
    await mint({
      name: "Team link",
      permissions: ["thread:create", "comment:create", "thread:resolve", "thread:private", "thread:assign"],
    }),
  );
  const b = await json(
    await redeem({
      environment: "production",
      identity: { kind: "link", token: team.token, name: "Studio" },
      client: { widget: "test", schema: "snagset.v1" },
    }),
  );
  assert.ok(b.permissions.includes("thread:private"));
  assert.ok(b.permissions.includes("thread:assign"));
});

test("a GUEST session never gets thread:private, whatever it asks for", { skip }, async () => {
  const b = await json(
    await redeem({
      environment: "production",
      identity: { kind: "guest", name: "Passer-by" },
      client: { widget: "test", schema: "snagset.v1" },
    }),
  );
  assert.equal(b.reviewer.kind, "guest");
  assert.equal(b.permissions.includes("thread:private"), false);
  assert.equal(b.permissions.includes("thread:assign"), false);
});

test("the wrong environment is refused with its own code", { skip }, async () => {
  const scoped = await json(await mint({ name: "Preview only", environments: ["preview"] }));
  const res = await redeem({
    environment: "production",
    identity: { kind: "link", token: scoped.token },
    client: { widget: "test", schema: "snagset.v1" },
  });
  assert.equal(res.status, 401);
  assert.equal((await json(res)).error.code, "token_wrong_environment");
});

test("max_uses counts PEOPLE — an existing holder still gets in", { skip }, async () => {
  const one = await json(await mint({ name: "Single seat", maxUses: 1 }));
  const first = await json(
    await redeem({
      environment: "production",
      identity: { kind: "link", token: one.token, name: "First" },
      client: { widget: "test", schema: "snagset.v1" },
    }),
  );
  // A brand-new person is refused…
  const second = await redeem({
    environment: "production",
    identity: { kind: "link", token: one.token, name: "Second" },
    client: { widget: "test", schema: "snagset.v1" },
  });
  assert.equal(second.status, 401);
  assert.equal((await json(second)).error.code, "token_exhausted");

  // …but the person who already has a row is readmitted, or a reviewer with a
  // comment in flight loses their own session on a page refresh.
  const again = await redeem({
    environment: "production",
    identity: { kind: "link", token: one.token, holderId: first.reviewer.id, holderSecret: first.holderSecret },
    client: { widget: "test", schema: "snagset.v1" },
  });
  assert.equal(again.status, 201);
});

test("refresh is silent: a bearer, no identity, same session, new token", { skip }, async () => {
  const res = await redeem({ environment: "production", client: { widget: "test", schema: "snagset.v1" } }, sessionToken);
  assert.equal(res.status, 200);
  const b = await json(res);
  assert.notEqual(b.sessionToken, sessionToken, "a new token");
  assert.equal(b.holderSecret, undefined, "and no credential re-issued");
  sessionToken = b.sessionToken;
});

test("REVOKE stops new redemptions AND signs out everyone already in", { skip }, async () => {
  // Revoking the link is the whole access-control story, so both halves
  // have to hold. A build that only set revoked_at would pass the first
  // assertion and leave a dismissed contractor commenting for 12 hours.
  const before = await redeem({ environment: "production", client: { widget: "test", schema: "snagset.v1" } }, sessionToken);
  assert.equal(before.status, 200, "the live session works before the revoke");

  const del = await app.request(`/api/v1/review-links/${linkId}`, {
    method: "DELETE",
    headers: { Cookie: auth.cookie, [HTTP_HEADER.csrf]: auth.csrf },
  });
  assert.equal(del.status, 204);

  const fresh = await redeem({
    environment: "production",
    identity: { kind: "link", token },
    client: { widget: "test", schema: "snagset.v1" },
  });
  assert.equal(fresh.status, 401);
  assert.equal((await json(fresh)).error.code, "token_revoked", "no new redemptions");

  const after = await redeem({ environment: "production", client: { widget: "test", schema: "snagset.v1" } }, sessionToken);
  assert.equal(after.status, 401, "and the session already issued is dead");
  assert.equal((await json(after)).error.code, "session_revoked");
});

test("revoking bumps session_epoch, which is what kills the OTHER links' sessions too", { skip }, async () => {
  // Stated so the blast radius is not a surprise: the epoch is per PROJECT, so
  // revoking one link signs out every reviewer in the project. The dialog
  // has to say so.
  const [p] = await sql<{ session_epoch: number }[]>`SELECT session_epoch FROM projects WHERE id = ${projectId}`;
  assert.ok(p!.session_epoch > 1, "the epoch moved");
});

/**
 * The FK that let a CHECK refuse a DELETE — found 2026-08-21 by deleting a
 * throwaway owner after a test, and repaired.
 *
 * `user_id` is not decoration on a `verified` reviewer, it IS the verification
 * ("vouched for by the host app OR one of our own dashboard users"). It used to
 * be `ON DELETE SET NULL`, so deleting a studio member who had replied nulled
 * the column, tripped `reviewers_check`, and failed the DELETE with a
 * constraint violation instead of a sentence. RESTRICT says the same thing at
 * the right layer, and `users.deleted_at` is the path that works.
 */
test("a studio member who has replied cannot be HARD-deleted, and CAN be soft-deleted", { skip }, async () => {
  const userId = randomUUID();
  const reviewerId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO users (id, org_id, email) VALUES (${userId}, ${orgId}, 'leaver@e.test')`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, user_id)
      VALUES (${reviewerId}, ${orgId}, ${projectId}, 'verified', 'Leaver', ${userId})`;
  });

  // RESTRICT, so the refusal names the foreign key rather than the CHECK the
  // nulled column would have broken.
  await assert.rejects(
    () => sql`DELETE FROM users WHERE id = ${userId}`,
    (e: Error) => /violates (foreign key|RESTRICT)/i.test(e.message),
    "the FK refuses, and says so",
  );

  const [soft] = await sql<{ id: string }[]>`
    UPDATE users SET deleted_at = now() WHERE id = ${userId} RETURNING id`;
  assert.equal(soft?.id, userId, "soft delete is the supported path");

  // And the reviewer keeps its name, which is the point: their replies do not
  // become anonymous because they left.
  const [kept] = await sql<{ name: string; user_id: string }[]>`
    SELECT name, user_id FROM reviewers WHERE id = ${reviewerId}`;
  assert.equal(kept?.name, "Leaver");
  assert.equal(kept?.user_id, userId);

  await sql`DELETE FROM reviewers WHERE id = ${reviewerId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
});

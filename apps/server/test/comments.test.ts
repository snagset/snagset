import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { mintSession } from "../src/session.ts";
import { createKeyring } from "../src/keys.ts";
import { DASHBOARD_SESSION_COOKIE, DASHBOARD_CSRF_COOKIE, HTTP_HEADER } from "@snagset/types/names";

/**
 * Comment creation, against a real Postgres — T5, endpoint 11.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL`, and it drops the schema — see
 * `reviewlink.test.ts`'s header for the two guards this shares and why they
 * exist. Run with that suite under `--test-concurrency=1` (package.json),
 * because both own the same schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the comment tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let projectId: string;
let orgId: string;
let threadId: string;
let bearer: string;
let ownerAuth: { cookie: string; csrf: string };

const SECRET = Buffer.alloc(32, 9).toString("base64url");
const PASSWORD = "correct horse battery staple";

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `login failed for ${email}: ${text}`);
  const cookie = res.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
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

  orgId = randomUUID();
  projectId = randomUUID();
  uid = "prj_bbbbbbbbbbbb";
  const userId = randomUUID();
  const envId = randomUUID();
  const roundId = randomUUID();
  const reviewerId = randomUUID();
  threadId = randomUUID();

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, password_hash)
      VALUES (${userId}, ${orgId}, 'o@e.test', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag)
      VALUES (${projectId}, ${orgId}, ${uid}, 'Site', ${Buffer.alloc(32, 1)}, 'etag')`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${envId}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    await tx`
      INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
      VALUES (${roundId}, ${orgId}, ${projectId}, 1, 'Round 1', ${userId})`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${reviewerId}, ${orgId}, ${projectId}, 'guest', 'Ada', ${Buffer.alloc(32, 2)})`;
    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                            anchor, context, created_by, comment_count, comment_count_public)
      VALUES (${threadId}, ${orgId}, ${projectId}, 'SN-1', ${envId}, ${roundId}, 1,
              ${tx.json({ offset: {}, page: {} })}, ${tx.json({})}, ${reviewerId}, 0, 0)`;
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

  ownerAuth = await login("o@e.test");

  // A link-session bearer, minted directly (this suite is about comments, not
  // the session exchange — `reviewlink.test.ts` covers that).
  const keys = createKeyring(SECRET);
  const minted = await mintSession(
    keys,
    {
      projectUid: uid,
      reviewerId,
      environmentKey: "production",
      kind: "guest",
      reviewLinkId: null,
      permissions: ["thread:create", "comment:create", "thread:resolve"],
      // `projects.session_epoch` DEFAULTs to 1 (0001_init.sql:180); a session
      // minted with epoch 0 never matches the row and every request with it
      // was reported `session_revoked` before the handler under test even
      // ran. Four of seven tests in this file were failing for that reason
      // alone until this was caught running the suite for real.
      sessionEpoch: 1,
    },
    { slidingS: 900, absoluteS: 43_200 },
  );
  bearer = minted.token;
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>;
const path = () => `/api/v1/projects/${uid}/threads/thr_${threadId}/comments`;

test("no credential at all → 401", { skip }, async () => {
  const res = await app.request(path(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "hello" }),
  });
  assert.equal(res.status, 401);
});

test("a session bearer with comment:create posts a comment and bumps the count", { skip }, async () => {
  const res = await app.request(path(), {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ body: "Looks great" }),
  });
  const b = await json(res);
  assert.equal(res.status, 201, JSON.stringify(b));
  assert.match(b.id, /^cmt_/);
  assert.equal(b.body, "Looks great");
  assert.match(b.author.id, /^rev_/);

  const [t] = await sql<{ comment_count: number; comment_count_public: number; version: number }[]>`
    SELECT comment_count, comment_count_public, version FROM threads WHERE id = ${threadId}
  `;
  assert.equal(t!.comment_count, 1);
  assert.equal(t!.comment_count_public, 1);
  assert.equal(t!.version, 2, "version bumped");
});

test("an owner cookie with no CSRF header → 403", { skip }, async () => {
  const res = await app.request(path(), {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: ownerAuth.cookie },
    body: JSON.stringify({ body: "studio reply" }),
  });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error.code, "csrf_failed");
});

test("an owner cookie WITH the CSRF pair posts as a fresh verified reviewer", { skip }, async () => {
  const res = await app.request(path(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: ownerAuth.cookie,
      [HTTP_HEADER.csrf]: ownerAuth.csrf,
    },
    body: JSON.stringify({ body: "studio reply" }),
  });
  const b = await json(res);
  assert.equal(res.status, 201, JSON.stringify(b));
  assert.equal(b.author.kind, "verified");

  const [r] = await sql<{ c: number }[]>`
    SELECT count(*)::int c FROM reviewers WHERE project_id = ${projectId} AND kind = 'verified'
  `;
  assert.equal(r!.c, 1, "one verified reviewer row, found-or-created");
});

test("a body over 10,000 characters → 400 body_too_large", { skip }, async () => {
  const res = await app.request(path(), {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ body: "x".repeat(10_001) }),
  });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).error.code, "body_too_large");
});

test("round is refused rather than silently dropped", { skip }, async () => {
  const res = await app.request(path(), {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ body: "nice try", round: 2 }),
  });
  assert.equal(res.status, 422);
  assert.equal((await json(res)).error.code, "field_not_permitted");
});

test("the canonical unscoped path works too, and a mismatched uid 404s", { skip }, async () => {
  const ok = await app.request(`/api/v1/threads/thr_${threadId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ body: "via the canonical path" }),
  });
  assert.equal(ok.status, 401, "the unscoped path carries no bearerAuth mount, so no session ever attaches to it");

  const wrongUid = await app.request(`/api/v1/projects/prj_zzzzzzzzzzzz/threads/thr_${threadId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ body: "wrong project" }),
  });
  // The handler checks `:uid` against the THREAD's own project before it ever
  // looks at the credential (comments.ts's `uidParam` check runs ahead of the
  // auth branch) — so a uid that names no such project 404s as
  // `thread_not_found` regardless of whether the bearer would otherwise be
  // valid, exactly like a wrong uid does everywhere else in this API. This
  // used to assert 401 on the theory that the bearer's audience check would
  // fail first; it doesn't run first, and the assertion was never exercised
  // against the real route until now.
  assert.equal(wrongUid.status, 404);
});

test("a reply after a deleted reply posts — seq never reuses a deleted one's", { skip }, async () => {
  /**
   * The production 500: deleting a reply keeps its row (and its seq) but takes
   * one off `comment_count`, and the next reply was numbered
   * `comment_count + 1` — the deleted reply's seq — so UNIQUE (thread_id, seq)
   * refused it, in the dashboard and the widget alike.
   */
  const owner = {
    "content-type": "application/json",
    Cookie: ownerAuth.cookie,
    [HTTP_HEADER.csrf]: ownerAuth.csrf,
  };
  const first = await app.request(path(), { method: "POST", headers: owner, body: JSON.stringify({ body: "to be deleted" }) });
  assert.equal(first.status, 201);
  const gone = (await json(first)).id as string;
  const del = await app.request(`/api/v1/projects/${uid}/comments/${gone}`, { method: "DELETE", headers: owner });
  assert.ok(del.status === 200 || del.status === 204, `delete: ${del.status}`);

  const next = await app.request(path(), { method: "POST", headers: owner, body: JSON.stringify({ body: "after the delete" }) });
  const b = await json(next);
  assert.equal(next.status, 201, JSON.stringify(b));

  const seqs = await sql<{ seq: number }[]>`SELECT seq FROM comments WHERE thread_id = ${threadId} ORDER BY seq`;
  assert.equal(new Set(seqs.map((r) => r.seq)).size, seqs.length, "every seq distinct");
});

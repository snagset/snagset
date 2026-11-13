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
      INSERT INTO projects (id, org_id, uid, name, ip_salt)
      VALUES (${projectId}, ${orgId}, ${uid}, 'Site', ${Buffer.alloc(32, 1)})`;
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
                            anchor, context, created_by)
      VALUES (${threadId}, ${orgId}, ${projectId}, 'SN-1', ${envId}, ${roundId}, 1,
              ${tx.json({ offset: {}, page: {} })}, ${tx.json({})}, ${reviewerId})`;
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

/** `commentCount` as the thread detail route reports it to this caller. */
async function wireCount(headers: Record<string, string>): Promise<number> {
  const res = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { headers });
  const b = await json(res);
  assert.equal(res.status, 200, JSON.stringify(b));
  return b.commentCount as number;
}

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

  // The count a client is shown, not a column: it is counted from the
  // comments on read now (commentTotal in threads.ts), so the API is the only
  // place it exists to assert.
  assert.equal(await wireCount({ Authorization: `Bearer ${bearer}` }), 1);
  const [t] = await sql<{ version: number }[]>`SELECT version FROM threads WHERE id = ${threadId}`;
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

/** The detail route's whole answer, for checking the count against the array beside it. */
async function detail(headers: Record<string, string>): Promise<{ status: number; body: Record<string, any> }> {
  const res = await app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, { headers });
  return { status: res.status, body: await json(res) };
}

/** What `commentCount` promises to be: the live entries of the `comments` this reader got. */
const liveIn = (t: Record<string, any>) => (t.comments as { body: string | null }[]).filter((c) => c.body !== null).length;

test("commentCount follows a reply, a private reply and a delete — public for a guest, everything for the studio", { skip }, async () => {
  /**
   * The count used to be two stored columns bumped by hand (reply +1, delete
   * -1, the private case decrementing one and not the other). It is counted
   * on read now, so this is the regression net for the three writes that used
   * to keep it right.
   *
   * TWO NUMBERS, ONE RULE. A guest is told the public total, exactly as
   * before. The studio reads team-only replies in `comments`, so its count
   * includes them: whichever reader it is, the count is the live length of
   * the array that reader was sent, and every assertion below checks both.
   */
  const guest = { Authorization: `Bearer ${bearer}` };
  const owner = { Cookie: ownerAuth.cookie, [HTTP_HEADER.csrf]: ownerAuth.csrf };
  const post = (body: Record<string, unknown>) =>
    app.request(path(), { method: "POST", headers: { "content-type": "application/json", ...owner }, body: JSON.stringify(body) });
  const agree = async (headers: Record<string, string>, expected: number, why: string) => {
    const { status, body } = await detail(headers);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.commentCount, expected, why);
    assert.equal(body.commentCount, liveIn(body), `${why} — and it is the length of the comments this reader got`);
  };
  const start = await wireCount(guest);
  await agree(guest, start, "the guest's public total");
  await agree(owner, start, "nothing private yet, so the studio's total is the same");

  const reply = await post({ body: "a public reply" });
  assert.equal(reply.status, 201);
  await agree(guest, start + 1, "a reply counts");
  await agree(owner, start + 1, "for the studio too");

  const priv = await post({ body: "team only", private: true });
  const pb = await json(priv);
  assert.equal(priv.status, 201, JSON.stringify(pb));
  await agree(guest, start + 1, "a private reply is not in the guest's count");
  await agree(owner, start + 2, "it is in the studio's, which reads it");
  assert.ok(
    ((await detail(owner)).body.comments as { id: string }[]).some((c) => c.id === pb.id),
    "the studio reads the private reply itself",
  );

  const del = await app.request(`/api/v1/projects/${uid}/comments/${(await json(reply)).id}`, { method: "DELETE", headers: owner });
  assert.ok(del.status === 200 || del.status === 204, `delete: ${del.status}`);
  await agree(guest, start, "a deleted reply stops counting");
  // The studio's array keeps the deleted reply as a tombstone (body null),
  // which is a hole in the conversation, not a comment: it does not count.
  await agree(owner, start + 1, "for the studio too, though it still holds the tombstone");

  // The list route agrees with the detail route, for each reader.
  for (const [who, expected] of [[guest, start], [owner, start + 1]] as const) {
    const list = await json(await app.request(`/api/v1/projects/${uid}/threads?key=SN-1`, { headers: who }));
    const rows = (list.data ?? list.threads) as Record<string, any>[];
    assert.equal(rows[0]!.commentCount, expected);
    assert.equal(rows[0]!.commentCount, liveIn(rows[0]!), "the list's count is its own array's length");
  }
});

test("a deleted OPENING comment reaches a client as an empty placeholder, never promoting a reply", { skip }, async () => {
  /**
   * Clients are sent no deleted comments, so a deleted opener used to vanish
   * and the widget drew the first reply as the opening comment, one reply
   * short. It now comes as a placeholder with no words and no name; deleted
   * replies stay absent.
   */
  const guest = { Authorization: `Bearer ${bearer}` };
  const owner = { Cookie: ownerAuth.cookie, [HTTP_HEADER.csrf]: ownerAuth.csrf };
  const before = (await detail(owner)).body.comments as { id: string; body: string | null }[];
  const opener = before[0]!;
  assert.ok(opener.body !== null, "the opener is live before the delete");
  const del = await app.request(`/api/v1/projects/${uid}/comments/${opener.id}`, { method: "DELETE", headers: owner });
  assert.ok(del.status === 200 || del.status === 204, `delete: ${del.status}`);

  for (const who of [guest, owner]) {
    const { body } = await detail(who);
    const cs = body.comments as { id: string; body: string | null; author: { name: string } }[];
    assert.equal(cs[0]!.id, opener.id, "the opener keeps its place");
    assert.equal(cs[0]!.body, null);
    assert.equal(cs[0]!.author.name, "", "and carries no name");
    assert.equal(body.commentCount, liveIn(body), "the placeholder is not counted");
  }
  const g = (await detail(guest)).body.comments as { body: string | null }[];
  assert.equal(g.filter((c) => c.body === null).length, 1, "a client sees only the opener's placeholder, no deleted replies");
});

test("a private thread counts 0 for a guest (who cannot see it) and every live comment for the studio", { skip }, async () => {
  const guest = { Authorization: `Bearer ${bearer}` };
  const owner = { Cookie: ownerAuth.cookie, [HTTP_HEADER.csrf]: ownerAuth.csrf };
  const before = (await detail(owner)).body;
  const patch = (priv: boolean) =>
    app.request(`/api/v1/projects/${uid}/threads/thr_${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify({ private: priv }),
    });

  // The PATCH response is a thread like any other, counted for its reader.
  const flipped = await patch(true);
  const fb = await json(flipped);
  assert.equal(flipped.status, 200, JSON.stringify(fb));
  assert.equal(fb.commentCount, before.commentCount, "going private hides nothing from the studio");
  assert.equal(fb.commentCount, liveIn(fb));
  const after = (await detail(owner)).body;
  assert.equal(after.commentCount, liveIn(after), "and the detail route says the same");
  assert.equal((await detail(guest)).status, 404, "while a guest cannot see the thread at all");

  const list = await json(await app.request(`/api/v1/projects/${uid}/threads?key=SN-1`, { headers: owner }));
  const rows = (list.data ?? list.threads) as Record<string, any>[];
  assert.equal(rows[0]!.commentCount, liveIn(rows[0]!));

  // Back to public for whatever runs after; the replies stay team-only (the
  // flip does not un-private them), so the guest's count is what is public.
  const back = await patch(false);
  assert.equal(back.status, 200);
  const g = (await detail(guest)).body;
  assert.equal(g.commentCount, liveIn(g), "the guest's count is still exactly what it can read");
});

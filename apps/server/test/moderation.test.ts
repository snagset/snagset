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
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * The studio's moderation, through the real routes: deleting a whole thread
 * (05 endpoint 10; a reviewer only for a thread nobody else has written in), and the two comment fixes that came
 * with the dashboard's per-comment menu — an owner editing their OWN reply
 * (refused for every dashboard comment until now) and the owner reading a
 * deleted comment as a tombstone rather than losing it on the next poll.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the moderation tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let orgId: string;
let projectId: string;
let doomedId: string;
let keptId: string;
let adaCommentId: string;
let shotId: string;
let bearer: string;
let owner: { cookie: string; csrf: string };
let stranger: { cookie: string; csrf: string };

const SECRET = Buffer.alloc(32, 9).toString("base64url");
const PASSWORD = "correct horse battery staple";

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return {
    cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "),
    csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken,
  };
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
  const userId = randomUUID();
  const envId = randomUUID();
  const roundId = randomUUID();
  const adaId = randomUUID();
  doomedId = randomUUID();
  keptId = randomUUID();
  adaCommentId = randomUUID();
  shotId = randomUUID();
  uid = "prj_dddddddddddd";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email, name, password_hash) VALUES (${userId}, ${orgId}, 'o@e.test', 'Olu', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag, thread_seq)
      VALUES (${projectId}, ${orgId}, ${uid}, 'Kilnwork', ${Buffer.alloc(32, 1)}, 'etag', 2)`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${envId}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    await tx`
      INSERT INTO rounds (id, org_id, project_id, number, name, created_by, thread_seq)
      VALUES (${roundId}, ${orgId}, ${projectId}, 1, 'Round 1', ${userId}, 2)`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash, thread_count, comment_count)
      VALUES (${adaId}, ${orgId}, ${projectId}, 'guest', 'Ada', ${Buffer.alloc(32, 2)}, 2, 2)`;
    for (const [id, key, n, body, cid] of [
      [doomedId, "SN-1", 1, "Spam, please remove.", randomUUID()],
      [keptId, "SN-2", 2, "The pricing table wraps at 1280.", adaCommentId],
    ] as const) {
      await tx`
        INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                             anchor, context, created_by, comment_count, comment_count_public)
        VALUES (${id}, ${orgId}, ${projectId}, ${key}, ${envId}, ${roundId}, ${n},
                ${tx.json({ label: "table", page: { origin: "https://kilnwork.studio", pathname: "/pricing", route: "/pricing" }, offset: {} })},
                ${tx.json({ url: "https://kilnwork.studio/pricing" })},
                ${adaId}, 1, 1)`;
      await tx`
        INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
        VALUES (${cid}, ${orgId}, ${projectId}, ${id}, 1, ${adaId}, ${body})`;
    }
    // The doomed thread's screenshot, and a "new comment" mail still inside
    // its debounce window — the two things that must not outlive the thread.
    await tx`
      INSERT INTO attachments (id, org_id, project_id, thread_id, kind, state, bound_at, storage_key,
                               content_type, bytes, sha256)
      VALUES (${shotId}, ${orgId}, ${projectId}, ${doomedId}, 'screenshot', 'bound', now(), 'k/doomed',
              'image/webp', 10, ${Buffer.alloc(32, 3)})`;
    await tx`
      INSERT INTO outbox (id, org_id, project_id, thread_id, provider, topic, dedupe_key, event)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${doomedId}, 'email', 'comment.created',
              'comment.created:x:owner', ${tx.json({ threadKey: "SN-1", body: "Spam, please remove." })})`;
  });

  // Another studio on the same instance, whose owner must not reach ours.
  const otherOrg = randomUUID();
  const otherUser = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${otherOrg}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${otherOrg}, 'Elsewhere', 'elsewhere')`;
    await tx`INSERT INTO users (id, org_id, email, password_hash) VALUES (${otherUser}, ${otherOrg}, 'x@e.test', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${otherOrg}, ${otherUser}, 'owner')`;
  });

  app = createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET, SNAGSET_BASE_URL: "https://review.example.dev" }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
  });
  owner = await login("o@e.test");
  stranger = await login("x@e.test");
  // Ada's session carries `thread:delete:own` — the default for a guest and
  // a new link — and the route still requires every comment to be hers.
  bearer = (
    await mintSession(
      createKeyring(SECRET),
      {
        projectUid: uid,
        reviewerId: adaId,
        environmentKey: "production",
        kind: "guest",
        reviewLinkId: null,
        permissions: ["thread:create", "comment:create", "thread:delete:own"],
        sessionEpoch: 1,
      },
      { slidingS: 900, absoluteS: 43_200 },
    )
  ).token;
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const asOwner = () => ({ Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf });
const asStranger = () => ({ Cookie: stranger.cookie, [HTTP_HEADER.csrf]: stranger.csrf });
const asGuest = () => ({ Authorization: `Bearer ${bearer}` });
const threadUrl = (id: string) => `/api/v1/projects/${uid}/threads/thr_${id}`;
const listKeys = async (headers: Record<string, string>) => {
  const res = await app.request(`/api/v1/projects/${uid}/threads`, { headers });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { data: { key: string }[] }).data.map((t) => t.key).sort();
};

test("a reviewer deletes a thread they started until someone else replies to it", { skip }, async () => {
  // Two threads of Ada's own: one only she wrote in, one Bob answered.
  const mine = randomUUID();
  const answered = randomUUID();
  const bob = randomUUID();
  const ada = (await sql`SELECT author_id FROM comments WHERE id = ${adaCommentId}`)[0]!.author_id as string;
  const [kept] = await sql<{ environment_id: string; round_id: string }[]>`
    SELECT environment_id, round_id FROM threads WHERE id = ${keptId}`;
  const { environment_id: envId, round_id: roundId } = kept!;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${bob}, ${orgId}, ${projectId}, 'guest', 'Bob', ${Buffer.alloc(32, 4)})`;
    for (const [id, key, n] of [[mine, "SN-3", 3], [answered, "SN-4", 4]] as const) {
      await tx`
        INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                             anchor, context, created_by, comment_count, comment_count_public)
        VALUES (${id}, ${orgId}, ${projectId}, ${key}, ${envId}, ${roundId}, ${n},
                ${tx.json({ label: "h1", page: { origin: "https://kilnwork.studio", pathname: "/", route: "/" }, offset: {} })},
                ${tx.json({ url: "https://kilnwork.studio/" })}, ${ada}, 1, 1)`;
      await tx`
        INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
        VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${id}, 1, ${ada}, 'Wrong element, sorry.')`;
    }
    await tx`
      INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${answered}, 2, ${bob}, 'I see it too.')`;
  });

  // Bob's reply is in it: deleting the thread would delete his words.
  const refused = await app.request(threadUrl(answered), { method: "DELETE", headers: asGuest() });
  assert.equal(refused.status, 403, await refused.clone().text());
  // Only she wrote in it: hers to take back. A bearer needs no CSRF header.
  const ok = await app.request(threadUrl(mine), { method: "DELETE", headers: asGuest() });
  assert.equal(ok.status, 204, await ok.clone().text());
  assert.deepEqual(await listKeys(asGuest()), ["SN-1", "SN-2", "SN-4"]);

  // Tidy: the remaining extra goes, so the tests below see the fixture.
  assert.equal((await app.request(threadUrl(answered), { method: "DELETE", headers: asOwner() })).status, 204);
  assert.deepEqual(await listKeys(asOwner()), ["SN-1", "SN-2"]);
});

test("another studio's owner is refused, and no credential at all is 401", { skip }, async () => {
  const res = await app.request(threadUrl(doomedId), { method: "DELETE", headers: asStranger() });
  assert.equal(res.status, 403, await res.clone().text());
  assert.equal((await app.request(threadUrl(doomedId), { method: "DELETE" })).status, 401);
  assert.deepEqual(await listKeys(asOwner()), ["SN-1", "SN-2"]);
});

test("the owner cookie without its CSRF header is refused", { skip }, async () => {
  const res = await app.request(threadUrl(doomedId), { method: "DELETE", headers: { Cookie: owner.cookie } });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "csrf_failed");
});

test("the owner deletes a thread: 204, gone from every read, picture and pending mail with it", { skip }, async () => {
  // The cursor a dashboard or widget would be polling from.
  const before_ = await app.request(`/api/v1/projects/${uid}/threads`, { headers: asOwner() });
  const { serverTime } = (await before_.json()) as { serverTime: string };

  const res = await app.request(threadUrl(doomedId), { method: "DELETE", headers: asOwner() });
  assert.equal(res.status, 204, await res.clone().text());

  assert.deepEqual(await listKeys(asOwner()), ["SN-2"], "the dashboard's list");
  assert.deepEqual(await listKeys(asGuest()), ["SN-2"], "the widget's list");
  assert.equal((await app.request(threadUrl(doomedId), { headers: asOwner() })).status, 404, "the detail");

  // An open tab polling with ?since= is TOLD, rather than keeping it.
  const poll = await app.request(`/api/v1/projects/${uid}/threads?since=${encodeURIComponent(serverTime)}`, {
    headers: asOwner(),
  });
  const delta = (await poll.json()) as { data: unknown[]; deleted: string[] };
  // Among them: the minute of overlap may re-send earlier tombstones too.
  assert.ok(delta.deleted.includes(`thr_${doomedId}`), "the deleted thread is tombstoned");

  const feed = await app.request("/api/v1/activity?status=all", { headers: asOwner() });
  assert.equal(feed.status, 200);
  const keys = ((await feed.json()) as { data: { key: string }[] }).data.map((r) => r.key);
  assert.ok(!keys.includes("SN-1"), "gone from Activity");
  assert.ok(keys.includes("SN-2"));

  const [shot] = await sql<{ deleted_at: Date | null }[]>`SELECT deleted_at FROM attachments WHERE id = ${shotId}`;
  assert.ok(shot?.deleted_at, "the screenshot is marked deleted");
  assert.equal((await app.request(`/api/v1/attachments/att_${shotId}/blob`)).status, 404, "and no longer served");

  const [mail] = await sql<{ status: string }[]>`SELECT status FROM outbox WHERE thread_id = ${doomedId}`;
  assert.equal(mail?.status, "dropped", "the queued mail does not go out");

  // Soft: the row and its words are still there for an operator to restore.
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM comments WHERE thread_id = ${doomedId} AND body IS NOT NULL`;
  assert.equal(row?.n, 1);
});

test("deleting again is 204; a thread that never existed is 404", { skip }, async () => {
  assert.equal((await app.request(threadUrl(doomedId), { method: "DELETE", headers: asOwner() })).status, 204);
  assert.equal((await app.request(threadUrl(randomUUID()), { method: "DELETE", headers: asOwner() })).status, 404);
});

test("a comment in a deleted thread cannot be edited or deleted", { skip }, async () => {
  const [c] = await sql<{ id: string }[]>`SELECT id FROM comments WHERE thread_id = ${doomedId}`;
  const res = await app.request(`/api/v1/comments/cmt_${c!.id}`, { method: "DELETE", headers: asOwner() });
  assert.equal(res.status, 404);
});

test("an owner edits their own reply, and only their own", { skip }, async () => {
  const posted = await app.request(`/api/v1/threads/thr_${keptId}/comments`, {
    method: "POST",
    headers: { ...asOwner(), "content-type": "application/json" },
    body: JSON.stringify({ id: randomUUID(), body: "On it — teh fix is in staging." }),
  });
  assert.equal(posted.status, 201, await posted.clone().text());
  const mine = (await posted.json()) as { id: string };

  const edit = await app.request(`/api/v1/comments/${mine.id}`, {
    method: "PATCH",
    headers: { ...asOwner(), "content-type": "application/json" },
    body: JSON.stringify({ body: "On it — the fix is in staging." }),
  });
  assert.equal(edit.status, 200, await edit.clone().text());
  assert.equal(((await edit.json()) as { body: string }).body, "On it — the fix is in staging.");

  const theirs = await app.request(`/api/v1/comments/cmt_${adaCommentId}`, {
    method: "PATCH",
    headers: { ...asOwner(), "content-type": "application/json" },
    body: JSON.stringify({ body: "Something Ada never said." }),
  });
  assert.equal(theirs.status, 403, "an owner may delete a reviewer's words, never rewrite them");
});

test("the owner deletes a reviewer's comment and still sees where it was; the widget does not", { skip }, async () => {
  const res = await app.request(`/api/v1/comments/cmt_${adaCommentId}`, { method: "DELETE", headers: asOwner() });
  assert.equal(res.status, 200, await res.clone().text());

  const detail = await app.request(threadUrl(keptId), { headers: asOwner() });
  const t = (await detail.json()) as { comments: { id: string; body: string | null; deletedAt?: string; author: Record<string, unknown> }[] };
  const hole = t.comments.find((c) => c.id === `cmt_${adaCommentId}`);
  assert.ok(hole, "the tombstone is on the owner's copy");
  assert.equal(hole.body, null);
  assert.ok(hole.deletedAt);
  assert.deepEqual(hole.author, { name: "Ada" }, "the name survives, nothing else does");

  const guest = await app.request(`/api/v1/projects/${uid}/threads`, { headers: asGuest() });
  const rows = ((await guest.json()) as { data: { key: string; comments: { id: string }[] }[] }).data;
  const kept = rows.find((r) => r.key === "SN-2")!;
  assert.ok(!kept.comments.some((c) => c.id === `cmt_${adaCommentId}`), "a reviewer's copy simply loses it");
});

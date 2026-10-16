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
import { createProject } from "../src/projects.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * `?since=` delta polling and the tombstone array, A36.
 *
 * A10 makes polling the ENTIRE realtime story, so this route runs forever in
 * every reviewer's background tab. Two things have to be true and neither is
 * visible from a single request:
 *
 *   · a poll returns only what changed, and
 *   · a thread that becomes INVISIBLE is reported, not merely omitted.
 *
 * The second is A36 and it is the one that silently rots: with the privacy
 * predicate in the WHERE clause a newly-private thread simply stops being
 * returned, which is indistinguishable from "nothing changed" — and a poll
 * returning nothing is the normal case, so the client keeps showing it forever.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the polling tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let projectId: string;
let orgId: string;
let reviewerId: string;
let bearer: string;
let owner: { cookie: string; csrf: string };

const SECRET = Buffer.alloc(32, 11).toString("base64url");
const PASSWORD = "correct horse battery staple";

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
  const userId = randomUUID();
  reviewerId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, password_hash)
      VALUES (${userId}, ${orgId}, 'o@e.test', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    const p = await createProject(tx, {
      orgId,
      name: "Poll",
      createdBy: userId,
      origins: ["https://poll.test"],
      graceHours: 24,
    });
    projectId = p.id;
    uid = p.uid;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${reviewerId}, ${orgId}, ${projectId}, 'guest', 'Ada', ${Buffer.alloc(32, 2)})`;
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

  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "o@e.test", password: PASSWORD }),
  });
  const text = await login.text();
  owner = {
    cookie: login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "),
    csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken,
  };

  bearer = (
    await mintSession(
      createKeyring(SECRET),
      {
        projectUid: uid,
        reviewerId,
        environmentKey: "production",
        kind: "guest",
        reviewLinkId: null,
        permissions: ["thread:create", "comment:create", "thread:resolve"],
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

const json = (r: Response) => r.json() as Promise<Record<string, any>>;

/**
 * The first row, non-null.
 *
 * `const [{ n }] = await sql<{ n: number }[]>\`…\`` reads well and does not
 * typecheck — postgres.js types the result as possibly-empty, so the
 * destructuring is `{ n: number } | undefined`. It was fixed inline four times
 * in this file before it became a helper, which is three times too many.
 */
const one = <T>(rows: readonly T[]): T => {
  assert.ok(rows[0], "expected a row");
  return rows[0];
};
const asOwner = () => ({ "content-type": "application/json", Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf });
const asReviewer = () => ({
  "content-type": "application/json",
  Origin: "https://poll.test",
  Authorization: `Bearer ${bearer}`,
});

/**
 * A reply, through the PROJECT-SCOPED route, with its status asserted.
 *
 * Both of these matter and the second was found by the first. `bearerAuth`
 * reads `:uid` off the path, so a reviewer bearer on the UNSCOPED
 * `/api/v1/threads/{id}/comments` is never attached — `app.ts` documents that
 * mount as a no-op today. Two tests here posted a reply that way, got a 401,
 * and then asserted "no public comments remain", which was true because the
 * reply never existed. Green over nothing, again.
 */
async function reply(threadId: string, body: string): Promise<void> {
  const res = await app.request(`/api/v1/projects/${uid}/threads/${threadId}/comments`, {
    method: "POST",
    headers: asReviewer(),
    body: JSON.stringify({ body }),
  });
  assert.equal(res.status, 201, `reply failed: ${await res.text()}`);
}

/** A thread, through the real route. */
async function makeThread(body: string): Promise<{ id: string; key: string }> {
  const res = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: asReviewer(),
    body: JSON.stringify({
      comment: { body },
      anchor: {
        offset: { x: 0.5, y: 0.5 },
        page: { route: "/", pathname: "/", origin: "https://poll.test" },
      },
      context: { url: "https://poll.test/" },
    }),
  });
  const t = await json(res);
  assert.equal(res.status, 201, JSON.stringify(t));
  return { id: t.id, key: t.key };
}

const list = async (query = "", headers: Record<string, string> = asReviewer()) =>
  json(await app.request(`/api/v1/projects/${uid}/threads${query}`, { headers }));

// ── the delta ────────────────────────────────────────────────────────────

test("a poll with no changes returns nothing — that is the hot path", { skip }, async () => {
  await makeThread("first");
  const full = await list();
  assert.equal(full.data.length, 1);

  // `serverTime` reaches back a minute (the overlap that catches a write
  // still committing), so a quiet poll right after a change may hand that
  // thread back once more — and nothing else.
  const quiet = await list(`?since=${encodeURIComponent(full.serverTime)}`);
  assert.ok(quiet.data.every((t: any) => t.key === full.data[0].key), "only the recent change, if anything");
  assert.deepEqual(quiet.deleted, []);
  // An idle project — nothing changed for longer than the overlap — costs one empty response.
  const later = await list(`?since=${encodeURIComponent(new Date(Date.now() + 5_000).toISOString())}`);
  assert.deepEqual(later.data, [], "the whole point: an idle project costs one empty response");
});

test("a poll returns only what changed since", { skip }, async () => {
  // The database's own clock, not `serverTime` (which reaches back a minute).
  const before = (await sql<{ now: Date }[]>`SELECT now() AS now`)[0]!.now.toISOString();
  const second = await makeThread("second");

  const delta = await list(`?since=${encodeURIComponent(before)}`);
  assert.deepEqual(
    delta.data.map((t: any) => t.key),
    [second.key],
    "the thread created before `since` must not come back",
  );
});

test("serverTime comes from POSTGRES, not this process", { skip }, async () => {
  /**
   * The client hands `serverTime` straight back as `since`, and `since` is
   * compared against `updated_at` — which Postgres wrote. If the app server
   * ran ahead of the database, every thread updated inside the skew would be
   * skipped on the next poll and never returned again.
   */
  const [db] = await sql<{ now: Date }[]>`SELECT now() AS now`;
  const reported = new Date((await list()).serverTime).getTime();
  // A minute behind it, on purpose — the overlap (see the next test).
  assert.ok(
    Math.abs(reported - (db!.now.getTime() - 60_000)) < 2000,
    "serverTime should track the database clock, a minute back",
  );
});

test("a round trip loses nothing — poll, change, poll again", { skip }, async () => {
  // The actual client loop, which is the only way to catch an off-by-one on
  // the boundary: `updated_at > since` must not drop a thread written in the
  // same instant the previous response was stamped.
  let cursor = (await list()).serverTime;
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const made = await makeThread(`round ${i}`);
    const delta = await list(`?since=${encodeURIComponent(cursor)}`);
    for (const t of delta.data) seen.add(t.key);
    cursor = delta.serverTime;
    assert.ok(seen.has(made.key), `round ${i}: the thread just created was not in the delta`);
  }
});

test("a status change still committing when a poll reads is caught by the NEXT poll", { skip }, async () => {
  /**
   * Found on a real deployment: guests resolved comments, the database had
   * them resolved, and other screens kept showing them open until a reload.
   * `updated_at` is the writing transaction's START; a write that began
   * before a poll read the list but committed after it was invisible to that
   * read — and older than a `serverTime` stamped afterwards, so skipped by
   * every later poll.
   */
  const t = await makeThread("raced");
  let cursor = (await list()).serverTime;

  // A writer opens its transaction and changes the status — not committed yet.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  const writer = sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`UPDATE threads SET status = 'review', version = version + 1, updated_at = now()
             WHERE id = ${t.id.replace(/^thr_/, "")}::uuid`;
    started();
    await gate;
  });
  await begun;

  // A poll runs while the write is open: it cannot see it.
  const during = await list(`?since=${encodeURIComponent(cursor)}`);
  const stale = during.data.find((x: any) => x.key === t.key);
  assert.ok(!stale || stale.status !== "review", "the uncommitted write is invisible");
  cursor = during.serverTime;

  release();
  await writer;

  // The next poll, from the cursor the racing poll handed out, must see it.
  const after = await list(`?since=${encodeURIComponent(cursor)}`);
  const caught = after.data.find((x: any) => x.key === t.key);
  assert.equal(caught?.status, "review", "the committed change must reach the next poll");
});

test("a link-only site shows its comments to a link, never to a bare request", { skip }, async () => {
  // Open sites: the widget reads the list with no credential, as before.
  assert.equal((await app.request(`/api/v1/projects/${uid}/threads`)).status, 200);

  // A second site, link-only, made fresh so no cached row says otherwise.
  const [user] = await sql<{ id: string }[]>`SELECT id FROM users WHERE org_id = ${orgId}::uuid LIMIT 1`;
  const userId = user!.id;
  const locked = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    const p = await createProject(tx, { orgId, name: "Locked", createdBy: userId, origins: ["https://locked.test"], graceHours: 24 });
    await tx`UPDATE projects SET write_mode = 'link-required' WHERE id = ${p.id}::uuid`;
    return p;
  });
  const bare = await app.request(`/api/v1/projects/${locked.uid}/threads`);
  assert.equal(bare.status, 401, "anyone with the uid used to read every comment");
  assert.equal(((await bare.json()) as { error: { code: string } }).error.code, "link_required");

  // The studio still reads it.
  const studio = await app.request(`/api/v1/projects/${locked.uid}/threads`, { headers: asOwner() });
  assert.equal(studio.status, 200, await studio.clone().text());
});

// ── A36, the tombstone ───────────────────────────────────────────────────

test("a thread that BECOMES private lands in deleted[], not silence", { skip }, async () => {
  const t = await makeThread("about to be team-only");
  const cursor = (await list()).serverTime;

  const patch = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ private: true }),
  });
  assert.equal(patch.status, 200, JSON.stringify(await patch.clone().json()));

  const delta = await list(`?since=${encodeURIComponent(cursor)}`);
  assert.ok(!delta.data.some((x: any) => x.id === t.id), "and it is not in data");
  assert.ok(
    delta.deleted.includes(t.id),
    "silently omitting it is indistinguishable from 'nothing changed' — the client would keep it forever",
  );
});

test("the OWNER still sees a private thread in data, not deleted[]", { skip }, async () => {
  const t = await makeThread("studio only");
  const cursor = (await list("", asOwner())).serverTime;
  await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ private: true }),
  });
  const delta = await list(`?since=${encodeURIComponent(cursor)}`, { Cookie: owner.cookie });
  assert.ok(delta.data.some((x: any) => x.id === t.id));
  assert.deepEqual(delta.deleted, []);
});

test("a tombstone carries the id and NOTHING else", { skip }, async () => {
  const t = await makeThread("secret plans for the client");
  const cursor = (await list()).serverTime;
  await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ private: true }),
  });
  const delta = await list(`?since=${encodeURIComponent(cursor)}`);
  // The client already has the id. A body would hand back the private content
  // that made it invisible in the first place. (The minute of overlap may
  // re-send an earlier test's tombstone too; this one must be among them.)
  assert.ok(delta.deleted.includes(t.id));
  assert.ok(!delta.data.some((x: any) => x.id === t.id), "a tombstone, never a body");
  assert.ok(!JSON.stringify(delta).includes("secret plans"));
});

// ── the three consequences ────────────────────────────────────────────

test("going private hides the replies too, and zeroes the public count", { skip }, async () => {
  const t = await makeThread("root");
  await reply(t.id, "a public reply");

  await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ private: true }),
  });

  const row = t.id.replace("thr_", "");
  const [thread] = await sql<{ private: boolean; comment_count_public: number }[]>`
    SELECT private, comment_count_public FROM threads WHERE id = ${row}::uuid`;
  assert.equal(thread!.private, true);
  assert.equal(thread!.comment_count_public, 0, "a private thread has no public replies to count");

  const [pub] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM comments WHERE thread_id = ${row}::uuid AND private = false`;
  assert.equal(pub!.n, 0, "a public reply under a team-only thread is unreachable content");
});

test("making it public again does NOT un-private the replies", { skip }, async () => {
  // "Share the thread" and "share what we said about it internally" are
  // different decisions, and conflating them is the expensive direction.
  const t = await makeThread("root");
  await reply(t.id, "reply");
  const path = `/api/v1/projects/${uid}/threads/${t.id}`;
  for (const priv of [true, false]) {
    await app.request(path, { method: "PATCH", headers: asOwner(), body: JSON.stringify({ private: priv }) });
  }
  const row = t.id.replace("thr_", "");
  const [priv] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM comments WHERE thread_id = ${row}::uuid AND private = true`;
  assert.equal(priv!.n, 2, "both the root comment and the reply stay team-only");
  const [thread] = await sql<{ comment_count_public: number }[]>`
    SELECT comment_count_public FROM threads WHERE id = ${row}::uuid`;
  assert.equal(thread!.comment_count_public, 0, "and the recomputed count agrees with them");
});

// ── the input ────────────────────────────────────────────────────────────

test("a reviewer cannot make a thread team-only", { skip }, async () => {
  const t = await makeThread("mine");
  const res = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH",
    headers: asReviewer(),
    body: JSON.stringify({ private: true }),
  });
  assert.equal(res.status, 403);
  const b = await json(res);
  assert.equal(b.error.code, "field_not_permitted");
  // Registers `details.field` for this code, and a client cannot mark the
  // offending input without it.
  assert.equal(b.error.details.field, "private");
});

test("a nonsense `since` is refused with a fixable sentence", { skip }, async () => {
  const res = await app.request(`/api/v1/projects/${uid}/threads?since=yesterday`);
  assert.equal(res.status, 400);
  assert.match((await json(res)).error.message, /serverTime/);
});

test("a PATCH with neither status nor private is refused", { skip }, async () => {
  const t = await makeThread("x");
  const res = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("status still patches on its own, unchanged", { skip }, async () => {
  const t = await makeThread("x");
  const res = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ status: "resolved" }),
  });
  const b = await json(res);
  assert.equal(res.status, 200, JSON.stringify(b));
  assert.equal(b.status, "resolved");
});

// ── F-26: no silent overwrite ───────────────────────

/** One thread, read the only way there is: out of the list. */
async function threadById(id: string): Promise<Record<string, any>> {
  const list = await json(await app.request(`/api/v1/projects/${uid}/threads`, { headers: asOwner() }));
  const row = (list.data as Record<string, any>[]).find((x) => x.id === id);
  assert.ok(row, `thread ${id} is not in the list`);
  return row!;
}

test("a thread carries its `version` on the list AND the detail", { skip }, async () => {
  // The dashboard patches straight from a list row. Without the version on
  // the list, every Resolve would need a detail fetch first just to learn it.
  const t = await makeThread("versioned");
  const list = await json(await app.request(`/api/v1/projects/${uid}/threads`, { headers: asOwner() }));
  const row = list.data.find((x: { id: string }) => x.id === t.id);
  assert.equal(typeof row.version, "number", "version must be on the list row");

  const patched = await json(
    await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
      method: "PATCH",
      headers: asOwner(),
      body: JSON.stringify({ status: "progress" }),
    }),
  );
  assert.equal(typeof patched.version, "number");
  assert.ok(patched.version > row.version, "a write must move the version");
});

test("the SECOND of two writers is refused, and told the current version", { skip }, async () => {
  /**
   * And the guarantee this column was added for in 0001 and then
   * read by nobody until now: two studio members with the same thread open
   * both press Resolve, and the second write lands on top of the first
   * without either of them learning the other had touched it.
   */
  const t = await makeThread("contended");
  // From the LIST, because that is the only read surface a thread has and it
  // is where the dashboard gets its copy too.
  const stale = (await threadById(t.id)).version;

  // Writer one gets there first, on the version they both read.
  const first = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ status: "resolved", version: stale }),
  });
  assert.equal(first.status, 200);

  // Writer two, holding the same now-stale copy.
  const second = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ status: "open", version: stale }),
  });
  assert.equal(second.status, 409, await second.clone().text());
  const err = (await json(second)).error;
  assert.equal(err.code, "version_conflict");
  // The refetch needs something to compare against, and "Post anyway" is
  // re-sending with this number.
  assert.equal(err.details.currentVersion, stale + 1);
  assert.equal(err.details.sentVersion, stale);

  // And the first writer's change SURVIVED — the point of the whole exercise.
  assert.equal((await threadById(t.id)).status, "resolved");
});

test("re-sending with the CURRENT version succeeds — that is Post anyway", { skip }, async () => {
  const t = await makeThread("post-anyway");
  const a = await threadById(t.id);
  await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: "resolved", version: a.version }),
  });
  const refetched = await threadById(t.id);
  const res = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: "open", version: refetched.version }),
  });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).status, "open");
});

test("a caller that sends NO version is not broken by F-26", { skip }, async () => {
  // The design is additive-only: the CLI, an agent on a fresh read and every
  // existing client must keep working. Opting in is what makes you protected.
  const t = await makeThread("unversioned");
  const res = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: "resolved" }),
  });
  assert.equal(res.status, 200);
});

test("a non-numeric version is refused rather than ignored", { skip }, async () => {
  // Silently ignoring it would turn a typo into exactly the lost update the
  // field exists to prevent.
  const t = await makeThread("typo");
  const res = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: "resolved", version: "3" }),
  });
  assert.equal(res.status, 400);
});

// ── `?key=` permalinks ───────────────────────────────────────────────────

test("a permalink resolves a thread from a CLOSED round", { skip }, async () => {
  /**
   * The bug this exists for. `?snag_t=SN-…` resolved locally against the list,
   * and the list is round-scoped — a non-owner reader gets the latest OPEN
   * round. So a permalink to a thread from a closed round found nothing and
   * showed F-the "we could not find that comment", while the thread sat one
   * round back. Those are most of the permalinks anyone shares: people share
   * the ones that mattered, and those are the ones a round closes over.
   */
  const old = await makeThread("from the first round");

  const made = await app.request(`/api/v1/projects/${uid}/rounds`, {
    method: "POST",
    headers: asOwner(),
    body: JSON.stringify({ name: "Round 2" }),
  });
  assert.equal(made.status, 201, await made.clone().text());

  // The default list no longer carries it — that is the round working.
  const def = await list();
  assert.ok(!def.data.some((t: any) => t.key === old.key), "the closed round is not the default view");

  const byKey = await list(`?key=${old.key}`);
  assert.deepEqual(byKey.data.map((t: any) => t.key), [old.key]);
});

test("`key` overrides every other filter left in the URL", { skip }, async () => {
  // A permalink pasted with a stale `status` or `route` on it must still
  // resolve: the caller named one thread, which is a stronger statement of
  // intent than a filter they did not notice.
  const t = await makeThread("findable");
  const res = await list(`?key=${t.key}&route=/nowhere&status=resolved`);
  assert.deepEqual(res.data.map((x: any) => x.key), [t.key]);
});

test("an unknown key is an empty list, not an error", { skip }, async () => {
  // F-06 is the client's sentence. The server's job is to answer honestly.
  assert.deepEqual((await list("?key=SN-9999")).data, []);
});

test("a permalink to a PRIVATE thread is empty for a reviewer, not a 403", { skip }, async () => {
  // A 403 confirms the id exists, which is the fact being withheld.
  const t = await makeThread("team only");
  await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ private: true }),
  });
  const asReviewerRes = await list(`?key=${t.key}`);
  assert.deepEqual(asReviewerRes.data, []);
  // …and the owner still finds it.
  assert.equal((await list(`?key=${t.key}`, { Cookie: owner.cookie })).data.length, 1);
});

// ── retries ──────────────────────────────────────────────────────────────

test("a double-tapped Send returns the thread, not a 500", { skip }, async () => {
  /**
   * Measured before this: first `201`, second **`500 internal_error`**, with
   * the thread in the database exactly once. The snag was saved and the person
   * who wrote it was told it had failed — which on a flaky connection is
   * exactly when they try again, or give up.
   */
  const body = JSON.stringify({
    id: `thr_${randomUUID()}`,
    comment: { body: "the button does nothing" },
    anchor: {
      offset: { x: 0.5, y: 0.5 },
      page: { route: "/", pathname: "/", origin: "https://poll.test" },
    },
    context: { url: "https://poll.test/" },
  });
  const send = () =>
    app.request(`/api/v1/projects/${uid}/threads`, { method: "POST", headers: asReviewer(), body });

  const first = await send();
  const second = await send();
  assert.equal(first.status, 201);
  assert.equal(second.status, 200, "200, not 201 — the second request created nothing");

  const a = await json(first);
  const b = await json(second);
  assert.equal(a.id, b.id, "and the same thread comes back");
  assert.equal(b.comments.length, 1, "with its comment, not an empty shell");

  const [count] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM threads WHERE key = ${a.key}`;
  assert.equal(count!.n, 1);
});

test("a retried REPLY returns the reply, not a 500", { skip }, async () => {
  const t = await makeThread("root");
  const commentId = `cmt_${randomUUID()}`;
  const post = () =>
    app.request(`/api/v1/projects/${uid}/threads/${t.id}/comments`, {
      method: "POST",
      headers: asReviewer(),
      body: JSON.stringify({ id: commentId, body: "sent twice" }),
    });

  const first = await post();
  const second = await post();
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal((await json(first)).id, (await json(second)).id);

  const row = t.id.replace("thr_", "");
  const [thread] = await sql<{ comment_count: number }[]>`
    SELECT comment_count FROM threads WHERE id = ${row}::uuid`;
  // The counter is the thing a naive retry corrupts: two increments for one
  // reply, and every count in the dashboard is wrong from then on.
  assert.equal(thread!.comment_count, 2, "the root comment and ONE reply");
});

test("an id that belongs to another project is a conflict, not a retry", { skip }, async () => {
  // Answering with somebody else's thread would be far worse than the 500
  // this replaces.
  // The owner is looked up OUTSIDE the transaction. The first version ran this
  // query on the outer `sql` from inside `sql.begin`, which asks the pool for a
  // second connection while the first is held — on `max: 3` that starves rather
  // than deadlocks, so every test passed and the suite then hung on teardown.
  const [member] = await sql<{ user_id: string }[]>`SELECT user_id FROM memberships LIMIT 1`;
  const other = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return createProject(tx, {
      orgId,
      name: "Other",
      createdBy: member!.user_id,
      origins: [],
      graceHours: 24,
    });
  });
  const mine = await makeThread("mine");
  const res = await app.request(`/api/v1/projects/${other.uid}/threads`, {
    method: "POST",
    headers: asReviewer(),
    body: JSON.stringify({
      id: mine.id,
      comment: { body: "stolen" },
      anchor: { offset: { x: 0, y: 0 }, page: { route: "/", pathname: "/", origin: "https://poll.test" } },
      context: { url: "https://poll.test/" },
    }),
  });
  assert.notEqual(res.status, 200, "must not hand back the other project's thread");
});

// ── editing and deleting a comment (endpoints 12, 13) ────────────────────

test("the author can fix a typo", { skip }, async () => {
  /**
   * The detail panel has rendered Edit and Delete now and the HTTP
   * adapter answered both `501 not_implemented`. The LOCAL adapter implemented
   * them, so the demo worked and every server-backed install did not.
   */
  const t = await makeThread("teh button does nothing");
  const [first] = await sql<{ id: string }[]>`
    SELECT id FROM comments WHERE thread_id = ${t.id.replace("thr_", "")}::uuid ORDER BY seq LIMIT 1`;
  const cid = `cmt_${first!.id}`;

  const res = await app.request(`/api/v1/projects/${uid}/comments/${cid}`, {
    method: "PATCH",
    headers: asReviewer(),
    body: JSON.stringify({ body: "the button does nothing" }),
  });
  const b = await json(res);
  assert.equal(res.status, 200, JSON.stringify(b));
  assert.equal(b.body, "the button does nothing");

  // …and the THREAD's version moved, or the correction reaches nobody polling.
  const [thread] = await sql<{ version: number }[]>`
    SELECT version FROM threads WHERE id = ${t.id.replace("thr_", "")}::uuid`;
  assert.ok(thread!.version > 1, "a poll must carry the edit");
});

test("someone else's comment is not editable", { skip }, async () => {
  const t = await makeThread("mine");
  const [first] = await sql<{ id: string }[]>`
    SELECT id FROM comments WHERE thread_id = ${t.id.replace("thr_", "")}::uuid LIMIT 1`;

  // A second reviewer, with their own session.
  const otherReviewer = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
             VALUES (${otherReviewer}, ${orgId}, ${projectId}, 'guest', 'Mallory', ${Buffer.alloc(32, 9)})`;
  });
  const theirs = (
    await mintSession(
      createKeyring(SECRET),
      { projectUid: uid, reviewerId: otherReviewer, environmentKey: "production", kind: "guest",
        reviewLinkId: null, permissions: ["comment:create"], sessionEpoch: 1 },
      { slidingS: 900, absoluteS: 43_200 },
    )
  ).token;

  const res = await app.request(`/api/v1/projects/${uid}/comments/cmt_${first!.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", Origin: "https://poll.test", Authorization: `Bearer ${theirs}` },
    body: JSON.stringify({ body: "I rewrote your comment" }),
  });
  assert.equal(res.status, 403);
});

test("the OWNER can delete anyone's comment but not rewrite it", { skip }, async () => {
  // Editing somebody else's words while their name stays on them is not a
  // moderation power, it is a forgery.
  const t = await makeThread("a client's words");
  const [first] = await sql<{ id: string }[]>`
    SELECT id FROM comments WHERE thread_id = ${t.id.replace("thr_", "")}::uuid LIMIT 1`;
  const path = `/api/v1/projects/${uid}/comments/cmt_${first!.id}`;

  const edit = await app.request(path, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ body: "what the client REALLY meant" }),
  });
  assert.equal(edit.status, 403);
  assert.match((await json(edit)).error.message, /not rewrite it/);

  const del = await app.request(path, { method: "DELETE", headers: asOwner() });
  assert.equal(del.status, 200, await del.clone().text());
});

test("delete leaves a TOMBSTONE — the conversation keeps its shape", { skip }, async () => {
  const t = await makeThread("root");
  await reply(t.id, "a reply that will go");
  const [second] = await sql<{ id: string }[]>`
    SELECT id FROM comments WHERE thread_id = ${t.id.replace("thr_", "")}::uuid ORDER BY seq DESC LIMIT 1`;

  const res = await app.request(`/api/v1/projects/${uid}/comments/cmt_${second!.id}`, {
    method: "DELETE",
    headers: asReviewer(),
  });
  const b = await json(res);
  assert.equal(res.status, 200);
  assert.equal(b.body, null, "body → NULL");
  assert.ok(b.deletedAt);
  assert.equal(b.author.name, "Ada", "the name survives so the thread still reads");
  assert.ok(!("seq" in b), "seq never crosses the wire — it would count what a client cannot read");
  assert.ok(!("id" in b.author), "and a tombstone carries no reviewer id");

  // The row is KEPT.
  const [row] = await sql<{ body: string | null; deleted_at: Date | null }[]>`
    SELECT body, deleted_at FROM comments WHERE id = ${second!.id}::uuid`;
  assert.equal(row!.body, null);
  assert.ok(row!.deleted_at);
});

test("deleting decrements BOTH counters, and never below zero", { skip }, async () => {
  // A thread showing "3 replies" above two of them is the failure this
  // prevents, and it is invisible until somebody counts.
  const t = await makeThread("root");
  await reply(t.id, "one");
  await reply(t.id, "two");
  const row = t.id.replace("thr_", "");
  const [before] = await sql<{ c: number; p: number }[]>`
    SELECT comment_count AS c, comment_count_public AS p FROM threads WHERE id = ${row}::uuid`;
  assert.equal(before!.c, 3);
  assert.equal(before!.p, 3);

  const [last] = await sql<{ id: string }[]>`
    SELECT id FROM comments WHERE thread_id = ${row}::uuid ORDER BY seq DESC LIMIT 1`;
  await app.request(`/api/v1/projects/${uid}/comments/cmt_${last!.id}`, {
    method: "DELETE",
    headers: asReviewer(),
  });
  const [after] = await sql<{ c: number; p: number }[]>`
    SELECT comment_count AS c, comment_count_public AS p FROM threads WHERE id = ${row}::uuid`;
  assert.equal(after!.c, 2);
  assert.equal(after!.p, 2);
});

test("deleting twice is the same outcome, not an error", { skip }, async () => {
  // A reviewer who taps twice on a slow connection should not be told off for
  // getting what they asked for.
  const t = await makeThread("root");
  await reply(t.id, "going");
  const [last] = await sql<{ id: string }[]>`
    SELECT id FROM comments WHERE thread_id = ${t.id.replace("thr_", "")}::uuid ORDER BY seq DESC LIMIT 1`;
  const path = `/api/v1/projects/${uid}/comments/cmt_${last!.id}`;
  assert.equal((await app.request(path, { method: "DELETE", headers: asReviewer() })).status, 200);
  assert.equal((await app.request(path, { method: "DELETE", headers: asReviewer() })).status, 200);

  const [counts] = await sql<{ c: number }[]>`
    SELECT comment_count AS c FROM threads WHERE id = ${t.id.replace("thr_", "")}::uuid`;
  assert.equal(counts!.c, 1, "and the counter moved exactly once");
});

test("past the 15-minute window the author is told to reply instead", { skip }, async () => {
  const t = await makeThread("written long ago");
  const [first] = await sql<{ id: string }[]>`
    SELECT id FROM comments WHERE thread_id = ${t.id.replace("thr_", "")}::uuid LIMIT 1`;
  // Aged in the database rather than by pinning a clock — the window is read
  // from `created_at`, and a test that moves the app's clock proves less than
  // one that moves the data.
  await sql`UPDATE comments SET created_at = now() - interval '20 minutes' WHERE id = ${first!.id}::uuid`;

  const res = await app.request(`/api/v1/projects/${uid}/comments/cmt_${first!.id}`, {
    method: "PATCH",
    headers: asReviewer(),
    body: JSON.stringify({ body: "too late" }),
  });
  assert.equal(res.status, 403);
  const b = await json(res);
  assert.equal(b.error.code, "edit_window_expired");
  assert.match(b.error.message, /Add a reply instead/);
});

test("editing cannot change a comment's audience", { skip }, async () => {
  const t = await makeThread("root");
  const [first] = await sql<{ id: string }[]>`
    SELECT id FROM comments WHERE thread_id = ${t.id.replace("thr_", "")}::uuid LIMIT 1`;
  const res = await app.request(`/api/v1/projects/${uid}/comments/cmt_${first!.id}`, {
    method: "PATCH",
    headers: asReviewer(),
    body: JSON.stringify({ body: "fixed", private: true }),
  });
  // Folding "fix the words" and "change who can read it" into one route means a
  // typo correction can silently change the audience.
  assert.equal(res.status, 422);
  assert.equal((await json(res)).error.details.field, "private");
});

test("an unauthenticated caller cannot delete a comment", { skip }, async () => {
  const t = await makeThread("root");
  const [first] = await sql<{ id: string }[]>`
    SELECT id FROM comments WHERE thread_id = ${t.id.replace("thr_", "")}::uuid LIMIT 1`;
  const res = await app.request(`/api/v1/projects/${uid}/comments/cmt_${first!.id}`, { method: "DELETE" });
  assert.equal(res.status, 401);
});

// ── notification on a NEW snag ───────────────────────────────────────────

test("creating a snag queues mail to the studio", { skip }, async () => {
  /**
   * `queueCommentNotice` was wired into the REPLY route and not into thread
   * creation, so the only comment that never generated mail was the FIRST one
   * — the one that says a client found something. Paste the tag, hand over the
   * link, and the first you hear of a round is a reply to a comment you were
   * never told about.
   *
   * This suite builds its app with no mail transport, so the enqueue is gated
   * off; `notifications` is passed explicitly here to exercise the path that
   * a configured install takes.
   */
  const mailApp = createApp({
    sql,
    cfg: loadConfig({
      DATABASE_URL: URL_!,
      SNAGSET_SECRET_KEY: SECRET,
      SNAGSET_MAIL_URL: "resend://re_test_key",
      SNAGSET_MAIL_FROM: "review@example.test",
    }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
  });

  await sql`DELETE FROM outbox`;
  const res = await mailApp.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: asReviewer(),
    body: JSON.stringify({
      comment: { body: "the checkout button does nothing" },
      anchor: {
        offset: { x: 0.5, y: 0.5 },
        page: { route: "/checkout", pathname: "/checkout", origin: "https://poll.test" },
      },
      context: { url: "https://poll.test/checkout" },
    }),
  });
  assert.equal(res.status, 201, await res.clone().text());

  const [queued] = await sql<{ topic: string; dedupe_key: string; event: Record<string, string> }[]>`
    SELECT topic, dedupe_key, event FROM outbox`;
  assert.ok(queued, "a new snag with a body must queue mail");
  // Same topic and dedupe shape as a reply — it IS a comment.created, and a
  // second topic would mean a second template and two ways to be silent.
  assert.equal(queued!.topic, "comment.created");
  assert.match(queued!.dedupe_key, /^comment\.created:[0-9a-f-]{36}$/);
  assert.equal(queued!.event["body"], "the checkout button does nothing");
  assert.equal(queued!.event["authorName"], "Ada");
  assert.equal(queued!.event["pageUrl"], "https://poll.test/checkout");
});

test("a retried create does not queue a SECOND mail", { skip }, async () => {
  // The dedupe key is the comment id, and the retry path returns the existing
  // thread without re-entering the transaction — so this holds for two
  // independent reasons, which is the right number for "we emailed your client
  // twice".
  const mailApp = createApp({
    sql,
    cfg: loadConfig({
      DATABASE_URL: URL_!,
      SNAGSET_SECRET_KEY: SECRET,
      SNAGSET_MAIL_URL: "resend://re_test_key",
      SNAGSET_MAIL_FROM: "review@example.test",
    }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
  });

  await sql`DELETE FROM outbox`;
  const body = JSON.stringify({
    id: `thr_${randomUUID()}`,
    comment: { id: `cmt_${randomUUID()}`, body: "sent twice" },
    anchor: {
      offset: { x: 0.5, y: 0.5 },
      page: { route: "/", pathname: "/", origin: "https://poll.test" },
    },
    context: { url: "https://poll.test/" },
  });
  const send = () => mailApp.request(`/api/v1/projects/${uid}/threads`, { method: "POST", headers: asReviewer(), body });
  await send();
  await send();

  const n = one(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox`).n;
  assert.equal(n, 1);
});

test("a body-less pin queues nothing — there is no sentence to send", { skip }, async () => {
  const mailApp = createApp({
    sql,
    cfg: loadConfig({
      DATABASE_URL: URL_!,
      SNAGSET_SECRET_KEY: SECRET,
      SNAGSET_MAIL_URL: "resend://re_test_key",
      SNAGSET_MAIL_FROM: "review@example.test",
    }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
  });
  await sql`DELETE FROM outbox`;
  await mailApp.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: asReviewer(),
    body: JSON.stringify({
      anchor: { offset: { x: 0, y: 0 }, page: { route: "/", pathname: "/", origin: "https://poll.test" } },
      context: { url: "https://poll.test/" },
    }),
  });
  const n = one(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox`).n;
  assert.equal(n, 0, "\"somebody pinned something\" is not worth an email");
});

test("with NO mail transport nothing is queued at all", { skip }, async () => {
  // Notifications off and say so, rather than silently accumulating
  // rows that arrive in one burst the day somebody configures Resend.
  await sql`DELETE FROM outbox`;
  await makeThread("no mailer configured");
  const n = one(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox`).n;
  assert.equal(n, 0);
});

// ── B3: the status machine, exhaustively ────────────────────────────────

const STATUSES = ["open", "progress", "review", "resolved"] as const;

test("every one of the sixteen transitions is allowed, and lands", { skip }, async () => {
  /**
   * There is no transition GRAPH, deliberately — reversed draft 3 and
   * settled on "all four statuses, both roles", because the round trip needs
   * the client to be able to move a thread on. So the thing to assert is not
   * which moves are legal but that ALL of them are, including the ones that
   * look odd (`resolved` → `open` is a reopening; `review` → `progress` is
   * somebody sending work back).
   *
   * Sixteen rather than twelve: setting a status to the one it already has is
   * a real request a double-click produces, and it must be a no-op that
   * succeeds rather than an error.
   */
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const t = await makeThread(`${from}→${to}`);
      const first = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
        method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: from }),
      });
      assert.equal(first.status, 200, `could not reach ${from}`);

      const res = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
        method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: to }),
      });
      assert.equal(res.status, 200, `${from} → ${to} was refused: ${await res.clone().text()}`);
      assert.equal((await json(res)).status, to, `${from} → ${to} did not land`);
    }
  }
});

test("resolved_at tracks the status in both directions", { skip }, async () => {
  // Set on the way in and CLEARED on the way out, or a reopened thread keeps a
  // resolution date that is no longer true — and every report built on that
  // column quietly disagrees with the status beside it.
  const t = await makeThread("resolved_at");
  const stampOf = async () => {
    const [row] = await sql<{ resolved_at: Date | null }[]>`
      SELECT resolved_at FROM threads WHERE id = ${t.id.replace(/^thr_/, "")}::uuid`;
    return row?.resolved_at ?? null;
  };

  assert.equal(await stampOf(), null, "a new thread is not resolved");
  for (const s of ["progress", "review"] as const) {
    await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
      method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: s }),
    });
    assert.equal(await stampOf(), null, `${s} must not stamp resolved_at`);
  }

  await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: "resolved" }),
  });
  assert.ok(await stampOf(), "resolved must stamp resolved_at");

  await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: "open" }),
  });
  assert.equal(await stampOf(), null, "reopening must clear resolved_at");
});

test("every status change moves the version — including a no-op re-set", { skip }, async () => {
  // The version is what F-26 compares, so a change that does not move it is a
  // change a concurrent editor cannot see.
  const t = await makeThread("versions");
  let last = (await threadById(t.id)).version as number;
  for (const s of ["progress", "progress", "resolved", "open"] as const) {
    await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
      method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: s }),
    });
    const now = (await threadById(t.id)).version as number;
    assert.ok(now > last, `setting ${s} did not move the version (${last} → ${now})`);
    last = now;
  }
});

test("a status outside the vocabulary is refused with the vocabulary", { skip }, async () => {
  const t = await makeThread("bad status");
  const res = await app.request(`/api/v1/projects/${uid}/threads/${t.id}`, {
    method: "PATCH", headers: asOwner(), body: JSON.stringify({ status: "done" }),
  });
  assert.equal(res.status, 400);
  const msg = (await json(res)).error.message as string;
  // Naming the four is what turns a refusal into an instruction.
  for (const s of STATUSES) assert.ok(msg.includes(s), `the error should name ${s}: ${msg}`);
});

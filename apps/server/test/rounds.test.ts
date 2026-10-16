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
 * Parallel rounds, through the real routes: a new thread lands in the
 * round its author is looking at, else the link's pinned round, else the
 * newest open one; the studio renames, closes, archives and deletes rounds
 * from Settings; and the last open round is never closed, archived or
 * deleted out from under the next comment.
 *
 * The fixture: Round 1 (closed), Internal QA (2, open), Client QA (3, open),
 * a link pinned to Internal QA, and an owner, an admin and a member.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the rounds tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let orgId: string;
let projectId: string;
const uid = "prj_rrrrrrrrrrrr";
const roundIds: Record<number, string> = {};
let guest: string;
let pinned: string;
type Login = { cookie: string; csrf: string };
let owner: Login;
let admin: Login;
let member: Login;

const SECRET = Buffer.alloc(32, 7).toString("base64url");
const PASSWORD = "correct horse battery staple";

async function login(email: string): Promise<Login> {
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

const as = (l: Login) => ({ Cookie: l.cookie, [HTTP_HEADER.csrf]: l.csrf, "content-type": "application/json" });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, "content-type": "application/json" });

async function session(reviewerId: string, linkId: string | null): Promise<string> {
  return (
    await mintSession(
      createKeyring(SECRET),
      {
        projectUid: uid,
        reviewerId,
        environmentKey: "production",
        kind: linkId ? "link" : "guest",
        reviewLinkId: linkId,
        permissions: ["thread:create", "comment:create", "thread:delete:own"],
        sessionEpoch: 1,
      },
      { slidingS: 900, absoluteS: 43_200 },
    )
  ).token;
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
  const ownerId = randomUUID();
  const adaId = randomUUID();
  const bobId = randomUUID();
  const linkId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    for (const [email, role, id] of [
      ["o@e.test", "owner", ownerId],
      ["a@e.test", "admin", randomUUID()],
      ["m@e.test", "member", randomUUID()],
    ] as const) {
      await tx`INSERT INTO users (id, org_id, email, password_hash) VALUES (${id}, ${orgId}, ${email}, ${hashPassword(PASSWORD)})`;
      await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${id}, ${role})`;
    }
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag)
      VALUES (${projectId}, ${orgId}, ${uid}, 'Kilnwork', ${Buffer.alloc(32, 1)}, 'etag')`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    for (const [n, name, closed] of [
      [1, "Round 1", true],
      [2, "Internal QA", false],
      [3, "Client QA", false],
    ] as const) {
      roundIds[n] = randomUUID();
      await tx`
        INSERT INTO rounds (id, org_id, project_id, number, name, created_by, closed_at)
        VALUES (${roundIds[n]!}, ${orgId}, ${projectId}, ${n}, ${name}, ${ownerId}, ${closed ? new Date() : null})`;
    }
    for (const [id, name, fill] of [[adaId, "Ada", 2], [bobId, "Bob", 3]] as const) {
      await tx`
        INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
        VALUES (${id}, ${orgId}, ${projectId}, 'guest', ${name}, ${Buffer.alloc(32, fill)})`;
    }
    await tx`
      INSERT INTO review_links (id, org_id, project_id, round_id, token_hash, name, expires_at)
      VALUES (${linkId}, ${orgId}, ${projectId}, ${roundIds[2]!}, ${Buffer.alloc(32, 5)}, 'Internal pass',
              now() + interval '7 days')`;
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
  admin = await login("a@e.test");
  member = await login("m@e.test");
  guest = await session(adaId, null);
  pinned = await session(bobId, linkId);
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

/** A thread through the real route; returns the response and, on success, its round's number. */
async function post(token: string, round?: unknown): Promise<{ status: number; code?: string; round?: number; id?: string }> {
  const res = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({
      comment: { body: "The hero image is cropped." },
      anchor: { offset: { x: 0.5, y: 0.5 }, page: { route: "/", pathname: "/", origin: "https://kilnwork.studio" } },
      context: { url: "https://kilnwork.studio/" },
      ...(round !== undefined ? { scope: { round } } : {}),
    }),
  });
  const body = (await res.json()) as { id?: string; error?: { code: string } };
  if (res.status !== 201) return { status: res.status, code: body.error?.code ?? "" };
  const [row] = await sql<{ number: number }[]>`
    SELECT rd.number FROM threads t JOIN rounds rd ON rd.id = t.round_id WHERE t.id = ${body.id!.slice(4)}::uuid`;
  return { status: 201, round: row!.number, id: body.id! };
}

const configRounds = async () => {
  const res = await app.request(`/api/v1/projects/${uid}/config`);
  return ((await res.json()) as { rounds: { number: number; closed: boolean }[] }).rounds.map((r) => r.number);
};

const patch = (who: Login, n: number, body: unknown) =>
  app.request(`/api/v1/rounds/rnd_${roundIds[n]}`, { method: "PATCH", headers: as(who), body: JSON.stringify(body) });

const del = (who: Login, n: number, confirm?: string) =>
  app.request(`/api/v1/rounds/rnd_${roundIds[n]}`, {
    method: "DELETE",
    headers: as(who),
    body: JSON.stringify(confirm === undefined ? {} : { confirm }),
  });

test("a new thread goes to the round asked for, else the link's round, else the newest open one", { skip }, async () => {
  assert.equal((await post(guest, 2)).round, 2, "the round being viewed");
  assert.equal((await post(guest)).round, 3, "no round: the newest open one");
  assert.equal((await post(pinned)).round, 2, "a link pinned to Internal QA lands there");
  assert.equal((await post(pinned, 3)).round, 3, "and may still choose another open round");
});

test("a closed, unknown or malformed round is refused, not quietly rerouted", { skip }, async () => {
  assert.deepEqual(await post(guest, 1), { status: 409, code: "round_closed" });
  assert.deepEqual(await post(guest, 99), { status: 409, code: "round_not_found" });
  assert.deepEqual(await post(guest, "two"), { status: 400, code: "validation_failed" });
});

test("starting a round leaves the open ones open, and only the studio's managers reshape them", { skip }, async () => {
  const made = await app.request(`/api/v1/projects/${uid}/rounds`, {
    method: "POST",
    headers: as(member),
    body: JSON.stringify({ name: "Launch week" }),
  });
  assert.equal(made.status, 201, "a member may still start a round");
  const round = (await made.json()) as { id: string; number: number; closed: boolean; archived: boolean };
  assert.equal(round.number, 4);
  roundIds[4] = round.id.slice(4);
  const open = await sql<{ number: number }[]>`
    SELECT number FROM rounds WHERE project_id = ${projectId} AND closed_at IS NULL ORDER BY number`;
  assert.deepEqual(open.map((r) => r.number), [2, 3, 4], "nothing was closed by starting round 4");

  assert.equal((await patch(member, 4, { name: "Nope" })).status, 403);
  assert.equal((await del(member, 4, "Launch week")).status, 403);
  const renamed = await patch(admin, 4, { name: "Launch" });
  assert.equal(renamed.status, 200);
  assert.equal(((await renamed.json()) as { name: string }).name, "Launch");
});

test("archive hides a round from the widget and from new threads; restore brings it back as it was", { skip }, async () => {
  const res = await patch(owner, 3, { archived: true });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { archived: boolean; closed: boolean };
  assert.equal(body.archived, true);
  assert.equal(body.closed, false, "archiving does not close");
  assert.deepEqual(await configRounds(), [4, 2, 1]);
  assert.deepEqual(await post(guest, 3), { status: 409, code: "round_closed" });
  assert.equal((await post(guest)).round, 4, "the default skips it");

  const listed = await app.request(`/api/v1/projects/${uid}/rounds`, { headers: as(owner) });
  const rows = ((await listed.json()) as { data: { number: number; archived: boolean }[] }).data;
  assert.equal(rows.find((r) => r.number === 3)?.archived, true, "Settings still lists it");

  assert.equal((await patch(owner, 3, { archived: false })).status, 200);
  assert.deepEqual(await configRounds(), [4, 3, 2, 1]);
  assert.equal((await post(guest, 3)).round, 3);
});

test("a link pinned to an archived round lands on the default instead", { skip }, async () => {
  assert.equal((await patch(owner, 2, { archived: true })).status, 200);
  assert.equal((await post(pinned)).round, 4);
  assert.equal((await patch(owner, 2, { archived: false })).status, 200);
});

test("the last open round cannot be closed, archived or deleted", { skip }, async () => {
  // Close 3 and 4 so Internal QA is the only one left open.
  assert.equal((await patch(owner, 3, { closed: true })).status, 200);
  assert.equal((await patch(owner, 4, { archived: true })).status, 200);
  for (const res of [
    await patch(owner, 2, { closed: true }),
    await patch(owner, 2, { archived: true }),
    await del(owner, 2, "Internal QA"),
  ]) {
    assert.equal(res.status, 409);
    const b = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(b.error.code, "last_open_round");
    assert.match(b.error.message, /Open another round first/);
  }
  // A closed or archived round is not "the last open one", so those still go.
  assert.equal((await patch(owner, 3, { name: "Client QA" })).status, 200);
  // Put things back for the delete test: 3 and 4 open again.
  assert.equal((await patch(owner, 3, { closed: false })).status, 200);
  assert.equal((await patch(owner, 4, { archived: false })).status, 200);
});

test("deleting a round takes its threads with it, only with its exact name, and its number is never reused", { skip }, async () => {
  const a = await post(guest, 4);
  const b = await post(pinned, 4);
  assert.equal(a.round, 4);
  const elsewhere = await post(guest, 3);
  const aRow = a.id!.slice(4);
  // A screenshot and a pending mail on one of them — both must not outlive it.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO attachments (id, org_id, project_id, thread_id, kind, state, bound_at, storage_key,
                               content_type, bytes, sha256)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${aRow}, 'screenshot', 'bound', now(), 'k/r4',
              'image/webp', 10, ${Buffer.alloc(32, 3)})`;
    await tx`
      INSERT INTO outbox (id, org_id, project_id, thread_id, provider, topic, dedupe_key, event)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${aRow}, 'email', 'comment.created',
              'comment.created:r4:owner', ${tx.json({ threadKey: "x" })})`;
  });
  const before = await app.request(`/api/v1/projects/${uid}/threads?round=4`, { headers: bearer(guest) });
  const since = ((await before.json()) as { serverTime: string }).serverTime;
  // Earlier tests left threads in round 4 too (the default while 3 was archived).
  const inFour = (
    await sql<{ id: string }[]>`SELECT id FROM threads WHERE round_id = ${roundIds[4]!}::uuid AND deleted_at IS NULL`
  ).map((r) => "thr_" + r.id);
  assert.ok(inFour.includes(a.id!) && inFour.includes(b.id!));

  assert.equal((await del(owner, 4)).status, 422, "no confirmation");
  assert.equal((await del(owner, 4, "launch")).status, 422, "not the exact name");
  const res = await del(owner, 4, "Launch");
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as { threads: number }).threads, inFour.length);

  // Every open widget drops them on its next poll.
  const poll = await app.request(`/api/v1/projects/${uid}/threads?round=4&since=${encodeURIComponent(since)}`, {
    headers: bearer(guest),
  });
  const delta = (await poll.json()) as { deleted: string[] };
  // Every one of them (the minute of overlap may re-send earlier tombstones too).
  for (const id of inFour) assert.ok(delta.deleted.includes(id), `${id} is tombstoned`);

  const [gone] = await sql<{ shots: number; mail: string }[]>`
    SELECT (SELECT count(*)::int FROM attachments WHERE thread_id = ${aRow}::uuid AND deleted_at IS NULL) AS shots,
           (SELECT status::text FROM outbox WHERE thread_id = ${aRow}::uuid) AS mail`;
  assert.deepEqual({ ...gone }, { shots: 0, mail: "dropped" });
  const [kept] = await sql<{ deleted: boolean }[]>`
    SELECT deleted_at IS NOT NULL AS deleted FROM threads WHERE id = ${elsewhere.id!.slice(4)}::uuid`;
  assert.equal(kept!.deleted, false, "another round's thread is untouched");

  assert.deepEqual(await configRounds(), [3, 2, 1]);
  assert.equal((await del(owner, 4, "Launch")).status, 404, "already gone");
  const next = await app.request(`/api/v1/projects/${uid}/rounds`, {
    method: "POST",
    headers: as(owner),
    body: JSON.stringify({}),
  });
  assert.equal(((await next.json()) as { number: number }).number, 5, "4 is not handed out again");
});

const move = (who: Login, ids: string[], round: number) =>
  app.request(`/api/v1/projects/${uid}/threads/move`, {
    method: "POST",
    headers: as(who),
    body: JSON.stringify({ ids, round }),
  });

test("the studio moves threads between rounds: new numbers in the target, keys kept, polls follow", { skip }, async () => {
  // Fresh threads in Client QA (3), and the next number Internal QA (2) will mint.
  const one = await post(guest, 3);
  const two = await post(guest, 3);
  const [r2] = await sql<{ seq: number }[]>`SELECT thread_seq AS seq FROM rounds WHERE id = ${roundIds[2]!}::uuid`;
  const before = await sql<{ id: string; key: string; version: number; round_number: number }[]>`
    SELECT id, key, version, round_number FROM threads WHERE id IN (${one.id!.slice(4)}::uuid, ${two.id!.slice(4)}::uuid)
    ORDER BY created_at`;
  const poll = await app.request(`/api/v1/projects/${uid}/threads?round=3`, { headers: as(owner) });
  const since = ((await poll.json()) as { serverTime: string }).serverTime;

  assert.equal((await move(member, [one.id!], 2)).status, 403, "a member cannot");
  const archived = await patch(owner, 1, { archived: true });
  assert.equal(archived.status, 200);
  assert.equal((await move(owner, [one.id!], 1)).status, 409, "never into an archived round");
  assert.equal((await patch(owner, 1, { archived: false })).status, 200);
  assert.equal((await move(owner, [one.id!], 4)).status, 404, "nor a deleted one");

  const res = await move(owner, [two.id!, one.id!], 2);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { moved: 2, round: 2 });

  const after = await sql<{ key: string; version: number; round_number: number; round_id: string }[]>`
    SELECT key, version, round_number, round_id FROM threads WHERE id IN (${one.id!.slice(4)}::uuid, ${two.id!.slice(4)}::uuid)
    ORDER BY created_at`;
  assert.deepEqual(after.map((t) => t.key), before.map((t) => t.key), "SN- keys unchanged");
  assert.deepEqual(after.map((t) => t.round_number), [r2!.seq + 1, r2!.seq + 2], "next numbers, in creation order");
  assert.ok(after.every((t, i) => t.round_id === roundIds[2] && t.version === before[i]!.version + 1));

  // The dashboard's poll of the round they left tombstones them; the new round lists them.
  const left = await app.request(`/api/v1/projects/${uid}/threads?round=3&since=${encodeURIComponent(since)}`, {
    headers: as(owner),
  });
  const delta = (await left.json()) as { data: { id: string }[]; deleted: string[] };
  assert.ok(delta.deleted.includes(one.id!) && delta.deleted.includes(two.id!));
  assert.ok(!delta.data.some((t) => t.id === one.id || t.id === two.id));
  const widget = async (n: number) => {
    const r = await app.request(`/api/v1/projects/${uid}/threads?round=${n}`, { headers: bearer(guest) });
    return ((await r.json()) as { data: { id: string }[] }).data.map((t) => t.id);
  };
  assert.ok((await widget(2)).includes(one.id!));
  assert.ok(!(await widget(3)).includes(one.id!));

  // A closed round is a fine place to file one; moving it again is a no-op there.
  assert.deepEqual(await (await move(owner, [one.id!], 1)).json(), { moved: 1, round: 1 });
  assert.deepEqual(await (await move(owner, [one.id!], 1)).json(), { moved: 0, round: 1 });
});

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
import { mintMcpToken } from "../src/routes/mcpToken.ts";
import { ensureStudioReviewers } from "../src/studioReviewers.ts";
import { HTTP_HEADER } from "@snagset/types/names";
import { join } from "./join.ts";

/**
 * The assignee — through the real routes.
 *
 * The pool (studio people ∪ everyone who has commented), the placeholder
 * person, the thread PATCH's `assignee` field with its three refusals, the
 * list filter, and the two dashboard writes that materialise studio people
 * as reviewers. Skipped without `SNAGSET_TEST_DATABASE_URL`, and it DROPS THE
 * SCHEMA — see `reviewlink.test.ts`'s header for the guards this shares.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the assignee tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let orgId: string;
let userId: string;
let uid: string;
let projectId: string;
let threadId: string;
let adaId: string; // a guest who commented — in the pool
let bobId: string; // a guest who never wrote — not in the pool
let owner: { cookie: string; csrf: string };
let adaBearer: string; // an ordinary client session
let teamBearer: string; // a session carrying thread:assign
let agentToken: string;

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
  return { cookie, csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken };
}

const asOwner = () => ({ "content-type": "application/json", Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf });
const bearer = (t: string) => ({ "content-type": "application/json", Authorization: `Bearer ${t}` });
const json = (res: Response) => res.json() as Promise<Record<string, any>>;
const pool = () => `/api/v1/projects/${uid}/assignees`;
const thread = () => `/api/v1/projects/${uid}/threads/thr_${threadId}`;

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
  userId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, password_hash)
      VALUES (${userId}, ${orgId}, 'o@e.test', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
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
  owner = await login("o@e.test");

  // The site through the ROUTE, so createProject's materialisation is what
  // puts the owner in the pool — not a row this test typed in.
  const made = await app.request("/api/v1/projects", {
    method: "POST",
    headers: asOwner(),
    body: JSON.stringify({ name: "Site", origins: "https://example.test" }),
  });
  const madeText = await made.text();
  assert.equal(made.status, 201, madeText);
  uid = (JSON.parse(madeText) as { uid: string }).uid;
  const [p] = await sql<{ id: string }[]>`SELECT id FROM projects WHERE uid = ${uid}`;
  projectId = p!.id;

  adaId = randomUUID();
  bobId = randomUUID();
  threadId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    const [env] = await tx<{ id: string }[]>`SELECT id FROM environments WHERE project_id = ${projectId} AND is_default`;
    const [round] = await tx<{ id: string }[]>`SELECT id FROM rounds WHERE project_id = ${projectId}`;
    // Ada wrote the thread (thread_count 1); Bob only exchanged a session.
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash, thread_count)
      VALUES (${adaId}, ${orgId}, ${projectId}, 'guest', 'Ada the client', ${Buffer.alloc(32, 2)}, 1)`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${bobId}, ${orgId}, ${projectId}, 'guest', 'Bob', ${Buffer.alloc(32, 3)})`;
    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                           anchor, context, created_by, comment_count, comment_count_public)
      VALUES (${threadId}, ${orgId}, ${projectId}, 'SN-1', ${env!.id}, ${round!.id}, 1,
              ${tx.json({ offset: {}, page: {} })}, ${tx.json({})}, ${adaId}, 0, 0)`;
    // The fixture took key SN-1 and position 1 by hand; the sequences the
    // real create route mints from must know, or its first thread collides.
    await tx`UPDATE projects SET thread_seq = 1 WHERE id = ${projectId}`;
    await tx`UPDATE rounds SET thread_seq = 1 WHERE id = ${round!.id}`;
    const minted = await mintMcpToken(tx, randomUUID(), {
      orgId,
      projectId,
      name: "bot",
      scopes: ["threads:read", "threads:write"],
    });
    agentToken = minted.token;
  });

  const keys = createKeyring(SECRET);
  const mint = (permissions: ("thread:create" | "comment:create" | "thread:resolve" | "thread:assign")[]) =>
    mintSession(
      keys,
      {
        projectUid: uid,
        reviewerId: adaId,
        environmentKey: "production",
        kind: "guest",
        reviewLinkId: null,
        permissions,
        sessionEpoch: 1,
      },
      { slidingS: 900, absoluteS: 43_200 },
    );
  adaBearer = (await mint(["thread:create", "comment:create", "thread:resolve"])).token;
  teamBearer = (await mint(["thread:create", "comment:create", "thread:resolve", "thread:assign"])).token;
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

test("the pool: the studio first, then whoever wrote; a guest who never wrote is absent", { skip }, async () => {
  const res = await app.request(pool(), { headers: asOwner() });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get("cache-control"), "private, max-age=30");
  const body = await json(res);
  const names = (body["data"] as any[]).map((r) => r.name);
  assert.deepEqual(names, ["o@e.test", "Ada the client"]);
  assert.equal(body["total"], 2);
  const [me, ada] = body["data"] as any[];
  // The owner's row was materialised by the site create: team, and me.
  assert.equal(me.isTeam, true);
  assert.equal(me.isMe, true);
  assert.equal(me.kind, "verified");
  assert.equal(me.email, "o@e.test");
  assert.match(me.id, /^rev_/);
  assert.equal(ada.isTeam, false);
  assert.equal(ada.isMe, false);
  assert.equal(ada.id, `rev_${adaId}`);
});

test("a client session sees names, never the studio's emails; no credential at all is 401", { skip }, async () => {
  const res = await app.request(pool(), { headers: bearer(adaBearer) });
  assert.equal(res.status, 200, await res.clone().text());
  const rows = (await json(res))["data"] as any[];
  assert.ok(rows.every((r) => !("email" in r)), "a client must not receive addresses");
  assert.equal(rows.find((r) => r.id === `rev_${adaId}`)?.isMe, true);

  const anon = await app.request(pool());
  assert.equal(anon.status, 401);
});

test("q= is a prefix match on the name", { skip }, async () => {
  const res = await app.request(`${pool()}?q=ad`, { headers: asOwner() });
  const rows = (await json(res))["data"] as any[];
  assert.deepEqual(
    rows.map((r) => r.name),
    ["Ada the client"],
  );
});

test("a person can be named before they have written — once, and only from the dashboard", { skip }, async () => {
  const first = await app.request(pool(), {
    method: "POST",
    headers: asOwner(),
    body: JSON.stringify({ name: "Sofia", email: "Sofia@Acme.com" }),
  });
  assert.equal(first.status, 201, await first.clone().text());
  const sofia = await json(first);
  assert.equal(sofia["kind"], "guest");
  assert.equal(sofia["isTeam"], false);
  assert.equal(sofia["email"], "sofia@acme.com");

  // The same address again is the same person, not a second row.
  const again = await app.request(pool(), {
    method: "POST",
    headers: asOwner(),
    body: JSON.stringify({ name: "Sofia Again", email: "sofia@acme.com" }),
  });
  assert.equal(again.status, 200);
  assert.equal((await json(again))["id"], sofia["id"]);

  // In the pool now, without having said a word.
  const list = await app.request(pool(), { headers: asOwner() });
  assert.ok(((await json(list))["data"] as any[]).some((r) => r.id === sofia["id"]));

  // A placeholder is a name, not a credential: no secret was minted.
  const [row] = await sql<{ holder_secret_hash: Buffer | null; invited_by: string }[]>`
    SELECT holder_secret_hash, invited_by FROM reviewers WHERE id = ${String(sofia["id"]).replace("rev_", "")}
  `;
  assert.equal(row!.holder_secret_hash, null);
  assert.equal(row!.invited_by, userId);

  const noName = await app.request(pool(), { method: "POST", headers: asOwner(), body: JSON.stringify({ email: "x@y.z" }) });
  assert.equal(noName.status, 400);
  assert.equal((await json(noName))["error"].details.field, "name");

  const client = await app.request(pool(), {
    method: "POST",
    headers: bearer(teamBearer),
    body: JSON.stringify({ name: "Nope" }),
  });
  assert.equal(client.status, 403);
});

test("the owner assigns and un-assigns; the list carries it and filters on it", { skip }, async () => {
  const set = await app.request(thread(), {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ assignee: `rev_${adaId}` }),
  });
  assert.equal(set.status, 200, await set.clone().text());
  const t = await json(set);
  assert.deepEqual(t["assignee"], { id: `rev_${adaId}`, name: "Ada the client", kind: "guest", isTeam: false });
  // The rest of the thread came back whole — a status change did not.
  assert.equal(t["status"], "open");
  assert.equal(t["createdBy"].name, "Ada the client");

  const list = async (qs = "") =>
    (await json(await app.request(`/api/v1/projects/${uid}/threads${qs}`, { headers: asOwner() })))["data"] as any[];
  assert.equal((await list())[0].assignee.id, `rev_${adaId}`);
  assert.equal((await list(`?assignee=rev_${adaId}`)).length, 1);
  assert.equal((await list("?assignee=unassigned")).length, 0);

  const clear = await app.request(thread(), { method: "PATCH", headers: asOwner(), body: JSON.stringify({ assignee: null }) });
  assert.equal(clear.status, 200);
  assert.equal((await json(clear))["assignee"], null);
  assert.equal((await list("?assignee=unassigned")).length, 1);
  assert.equal((await list())[0].assignee, null);

  const bad = await app.request(`/api/v1/projects/${uid}/threads?assignee=bogus`, { headers: asOwner() });
  assert.equal(bad.status, 400);
});

test("a client cannot assign — 403 field_not_permitted naming the field; a team link can", { skip }, async () => {
  const client = await app.request(thread(), {
    method: "PATCH",
    headers: bearer(adaBearer),
    body: JSON.stringify({ assignee: `rev_${adaId}` }),
  });
  assert.equal(client.status, 403);
  const err = (await json(client))["error"];
  assert.equal(err.code, "field_not_permitted");
  assert.equal(err.details.field, "assignee");

  const team = await app.request(thread(), {
    method: "PATCH",
    headers: bearer(teamBearer),
    body: JSON.stringify({ assignee: `rev_${adaId}` }),
  });
  assert.equal(team.status, 200, await team.clone().text());
  assert.equal((await json(team))["assignee"].id, `rev_${adaId}`);
  await app.request(thread(), { method: "PATCH", headers: asOwner(), body: JSON.stringify({ assignee: null }) });
});

test("somebody outside the pool is refused with a sentence, never silently dropped", { skip }, async () => {
  for (const id of [`rev_${bobId}`, `rev_${randomUUID()}`]) {
    const res = await app.request(thread(), { method: "PATCH", headers: asOwner(), body: JSON.stringify({ assignee: id }) });
    assert.equal(res.status, 400, await res.clone().text());
    const err = (await json(res))["error"];
    assert.equal(err.code, "validation_failed");
    assert.equal(err.details.field, "assignee");
  }
  const garbage = await app.request(thread(), { method: "PATCH", headers: asOwner(), body: JSON.stringify({ assignee: 42 }) });
  assert.equal(garbage.status, 400);
  const empty = await app.request(thread(), { method: "PATCH", headers: asOwner(), body: JSON.stringify({}) });
  assert.equal(empty.status, 400);
});

test("an agent proposes, never disposes: it cannot assign", { skip }, async () => {
  const res = await app.request(thread(), {
    method: "PATCH",
    headers: bearer(agentToken),
    body: JSON.stringify({ assignee: `rev_${adaId}` }),
  });
  assert.equal(res.status, 403, await res.clone().text());
  const err = (await json(res))["error"];
  assert.equal(err.code, "field_not_permitted");
  assert.equal(err.details.field, "assignee");
});

test("a new member joins the pool on every site; leaving blocks them and keeps what they hold", { skip }, async () => {
  // Through an invite, the only way in.
  const added = await join(app, asOwner(), { email: "joel@e.test", name: "Joel Rocha", role: "admin", password: "a first passphrase" });
  assert.equal(added.status, 201, await added.clone().text());
  const inPool = ((await json(await app.request(pool(), { headers: asOwner() })))["data"] as any[]).find(
    (r) => r.name === "Joel Rocha",
  );
  assert.ok(inPool, "the new member is assignable without having written");
  assert.equal(inPool.isTeam, true);

  const set = await app.request(thread(), { method: "PATCH", headers: asOwner(), body: JSON.stringify({ assignee: inPool.id }) });
  assert.equal(set.status, 200);

  const gone = await app.request("/api/v1/members/joel%40e.test", { method: "DELETE", headers: asOwner() });
  assert.equal(gone.status, 200, await gone.clone().text());
  const after_ = ((await json(await app.request(pool(), { headers: asOwner() })))["data"] as any[]).map((r) => r.name);
  assert.ok(!after_.includes("Joel Rocha"), "a departed member leaves the pool");
  // …and the thread keeps the name it had: history is not rewritten.
  const rows = (await json(await app.request(`/api/v1/projects/${uid}/threads`, { headers: asOwner() })))["data"] as any[];
  assert.equal(rows[0].assignee?.name, "Joel Rocha");
  // Assigning to them AGAIN is what is refused now.
  const again = await app.request(thread(), { method: "PATCH", headers: asOwner(), body: JSON.stringify({ assignee: inPool.id }) });
  assert.equal(again.status, 400);
  await app.request(thread(), { method: "PATCH", headers: asOwner(), body: JSON.stringify({ assignee: null }) });
});

test("materialising studio people is idempotent — the backfill and both routes land each row once", { skip }, async () => {
  // A project typed straight into the database, the way every instance
  // claimed before looks: no studio rows at all.
  const oldProject = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag)
      VALUES (${oldProject}, ${orgId}, 'prj_bbbbbbbbbbbb', 'Old', ${Buffer.alloc(32, 1)}, 'etag')`;
  });
  const count = async () =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM reviewers WHERE project_id = ${oldProject} AND user_id IS NOT NULL`)[0]!.n;
  assert.equal(await count(), 0);
  for (let i = 0; i < 2; i++) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      await ensureStudioReviewers(tx as postgres.TransactionSql, { orgId, projectId: oldProject });
    });
  }
  // The owner, and not the soft-deleted Joel.
  assert.equal(await count(), 1);
});

test("leaving a pin is what makes a person assignable — through the widget's own route", { skip }, async () => {
  // Bob has a session and has never written: not in the pool (proved above).
  const keys = createKeyring(SECRET);
  const bob = await mintSession(
    keys,
    {
      projectUid: uid,
      reviewerId: bobId,
      environmentKey: "production",
      kind: "guest",
      reviewLinkId: null,
      permissions: ["thread:create", "comment:create"],
      sessionEpoch: 1,
    },
    { slidingS: 900, absoluteS: 43_200 },
  );
  const made = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: bearer(bob.token),
    body: JSON.stringify({
      id: randomUUID(),
      comment: { body: "the footer overlaps on mobile" },
      anchor: { label: "footer", css: "footer", page: { route: "/", origin: "https://example.test", pathname: "/" }, offset: { x: 0.5, y: 0.9 } },
      context: { url: "https://example.test/", viewport: { w: 390, h: 844, dpr: 3 } },
    }),
  });
  assert.equal(made.status, 201, await made.clone().text());
  // The counters moved on the write itself — no fixture typed them in.
  const [row] = await sql<{ thread_count: number; comment_count: number }[]>`
    SELECT thread_count, comment_count FROM reviewers WHERE id = ${bobId}
  `;
  assert.deepEqual(row, { thread_count: 1, comment_count: 1 });
  const names = ((await json(await app.request(pool(), { headers: asOwner() })))["data"] as any[]).map((r) => r.name);
  assert.ok(names.includes("Bob"), `Bob should be in the pool now: ${names.join(", ")}`);
  const set = await app.request(thread(), { method: "PATCH", headers: asOwner(), body: JSON.stringify({ assignee: `rev_${bobId}` }) });
  assert.equal(set.status, 200, await set.clone().text());
  assert.equal((await json(set))["assignee"].name, "Bob");
});

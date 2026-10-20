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
 * Endpoint 8 (one thread) and the brief (`…/threads/:id.md`)
 * through the real route, with the privacy rule a non-owner gets.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the thread detail tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let publicId: string;
let privateId: string;
let bearer: string;
let owner: { cookie: string; csrf: string };

const SECRET = Buffer.alloc(32, 9).toString("base64url");
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

  const orgId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  const envId = randomUUID();
  const roundId = randomUUID();
  const adaId = randomUUID();
  publicId = randomUUID();
  privateId = randomUUID();
  uid = "prj_bbbbbbbbbbbb";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email, password_hash) VALUES (${userId}, ${orgId}, 'o@e.test', ${hashPassword(PASSWORD)})`;
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
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${adaId}, ${orgId}, ${projectId}, 'guest', 'Ada', ${Buffer.alloc(32, 2)})`;
    for (const [id, key, n, isPrivate, body] of [
      [publicId, "SN-1", 1, false, "The pricing table wraps at 1280."],
      [privateId, "SN-2", 2, true, "Internal: ask the client about the copy."],
    ] as const) {
      await tx`
        INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                             anchor, context, created_by, private)
        VALUES (${id}, ${orgId}, ${projectId}, ${key}, ${envId}, ${roundId}, ${n},
                ${tx.json({ label: "table “Plans”", css: "main .pricing > table", page: { origin: "https://kilnwork.studio", pathname: "/pricing", route: "/pricing" }, offset: {} })},
                ${tx.json({ viewport: { w: 1440, h: 900, dpr: 2 }, derived: { browser: "Chrome 131", os: "macOS" } })},
                ${adaId}, ${isPrivate})`;
      await tx`
        INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body, private)
        VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${id}, 1, ${adaId}, ${body}, ${isPrivate})`;
    }
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
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "o@e.test", password: PASSWORD }),
  });
  const text = await res.text();
  owner = {
    cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "),
    csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken,
  };
  bearer = (
    await mintSession(
      createKeyring(SECRET),
      { projectUid: uid, reviewerId: adaId, environmentKey: "production", kind: "guest", reviewLinkId: null, permissions: ["thread:create"], sessionEpoch: 1 },
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
const asGuest = () => ({ Authorization: `Bearer ${bearer}` });
const url = (id: string, md = false) => `/api/v1/projects/${uid}/threads/thr_${id}${md ? ".md" : ""}`;

test("one thread, as JSON: the whole row, the list's shape", { skip }, async () => {
  const res = await app.request(url(publicId), { headers: asOwner() });
  assert.equal(res.status, 200, await res.clone().text());
  const t = (await res.json()) as Record<string, any>;
  assert.equal(t["key"], "SN-1");
  assert.equal(t["assignee"], null);
  assert.equal(t["comments"].length, 1);
  assert.equal(t["comments"][0].author.name, "Ada");
  assert.equal(t["round"], 1);
});

test("the brief, as markdown: the site's name, where to look, the words, an absolute screenshot base", { skip }, async () => {
  const res = await app.request(url(publicId, true), { headers: asOwner() });
  assert.equal(res.status, 200, await res.clone().text());
  assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
  const md = await res.text();
  assert.match(md, /^# SN-1 — table “Plans”\n/);
  assert.match(md, /Kilnwork · Open · left by Ada on /);
  assert.match(md, /- Open on the page: https:\/\/kilnwork\.studio\/pricing\?snag_t=SN-1/);
  assert.match(md, /> The pricing table wraps at 1280\./);
  assert.match(md, /- Viewport: 1440 × 900 @2x/);
});

test("privacy is the list's: a team-only thread is absent for a session, present for the owner", { skip }, async () => {
  const mine = await app.request(url(privateId, true), { headers: asOwner() });
  assert.equal(mine.status, 200);
  assert.match(await mine.text(), /Internal: ask the client/);
  const theirs = await app.request(url(privateId), { headers: asGuest() });
  assert.equal(theirs.status, 404);
  const ok = await app.request(url(publicId, true), { headers: asGuest() });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /^# SN-1/);
});

test("no credential is 401; a made-up id is 404 either way", { skip }, async () => {
  assert.equal((await app.request(url(publicId))).status, 401);
  assert.equal((await app.request(url(randomUUID()), { headers: asOwner() })).status, 404);
  assert.equal((await app.request(url(randomUUID(), true), { headers: asOwner() })).status, 404);
  assert.equal((await app.request(`/api/v1/projects/${uid}/threads/garbage.md`, { headers: asOwner() })).status, 404);
});

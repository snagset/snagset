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
import { PROXY_PER_MINUTE } from "../src/routes/imageProxy.ts";

/**
 * The image proxy's route — who may use it. The fetcher's own rules (public
 * addresses only, images only) are in image-proxy.test.ts; this file is the
 * gate in front of them: a widget session of THIS site, and a rate.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the image-proxy route tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let projectId: string;
let orgId: string;
let bearer: string;

const SECRET = Buffer.alloc(32, 13).toString("base64url");
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
  const reviewerId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, password_hash)
      VALUES (${userId}, ${orgId}, 'o@e.test', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    const p = await createProject(tx, {
      orgId,
      name: "Proxy",
      createdBy: userId,
      origins: ["https://proxy.test"],
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

const asReviewer = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${bearer}`,
  origin: "https://proxy.test",
});

const get = (src: string | null, headers: Record<string, string> = asReviewer()) =>
  app.request(`/api/v1/projects/${uid}/image${src === null ? "" : `?src=${encodeURIComponent(src)}`}`, { headers });

test("no widget session, no proxy", { skip }, async () => {
  const res = await get("https://example.com/a.png", { origin: "https://proxy.test" });
  assert.equal(res.status, 401);
});

test("a session for another site is refused", { skip }, async () => {
  const other = await app.request(`/api/v1/projects/prj_doesnotexist/image?src=x`, { headers: asReviewer() });
  assert.notEqual(other.status, 200);
});

test("which image is a required question", { skip }, async () => {
  const res = await get(null);
  assert.equal(res.status, 400);
});

test("a private address is refused through the route, not fetched", { skip }, async () => {
  for (const src of ["http://localhost/a.png", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/a.png"]) {
    const res = await get(src);
    assert.equal(res.status, 422, src);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "blocked_address", src);
  }
});

test("the per-session rate holds", { skip }, async () => {
  // Refused fast (a private address), so the loop measures the counter, not
  // the network. Earlier cases in this file already spent a few.
  let last = 0;
  for (let i = 0; i <= PROXY_PER_MINUTE; i++) last = (await get("http://127.0.0.1/a.png")).status;
  assert.equal(last, 429);
});

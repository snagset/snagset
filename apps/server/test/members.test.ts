import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { HTTP_HEADER } from "@snagset/types/names";
import { join } from "./join.ts";

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the members tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let orgId: string;
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const PASSWORD = "correct horse battery staple";
const json = { "content-type": "application/json" };

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", { method: "POST", headers: json, body: JSON.stringify({ email, password: PASSWORD }) });
  const text = await res.text();
  assert.equal(res.status, 200, `login failed: ${text}`);
  return {
    cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "),
    csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken,
  };
}
const as = (a: { cookie: string; csrf: string }) => ({ ...json, Cookie: a.cookie, [HTTP_HEADER.csrf]: a.csrf });

before(async () => {
  if (skip) return;
  if (URL_ === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  const cfg = loadConfig({ DATABASE_URL: URL_!, SNAGSET_BASE_URL: "http://localhost:8080" });
  app = createApp({ sql, cfg, secretKey: SECRET, state: "READY", version: "0.0.0-test", commit: "test", sourceUrl: "", modified: false });
  orgId = randomUUID();
  const ownerId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email, name, password_hash, email_verified) VALUES (${ownerId}, ${orgId}, 'owner@studio.test', 'Owner', ${hashPassword(PASSWORD)}, true)`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${ownerId}, 'owner')`;
  });
});
after(async () => { if (sql) await sql.end({ timeout: 5 }); });

test("the owner invites an admin, who can sign in, see the list, and not change it", { skip }, async () => {
  const owner = await login("owner@studio.test");
  const add = await join(app, as(owner), { email: "Admin@Studio.test", name: "Ada", role: "admin", password: PASSWORD });
  assert.equal(add.status, 201, await add.text());
  const admin = await login("admin@studio.test");
  const me = await app.request("/api/v1/me", { headers: { Cookie: admin.cookie } });
  assert.equal(((await me.json()) as { user: { role: string } }).user.role, "admin", "/me carries the role");
  const list = await app.request("/api/v1/members", { headers: { Cookie: admin.cookie } });
  const rows = ((await list.json()) as { data: { email: string; role: string; you: boolean }[] }).data;
  assert.deepEqual(rows.map((r) => [r.email, r.role, r.you]), [["owner@studio.test", "owner", false], ["admin@studio.test", "admin", true]]);
  const denied = await join(app, as(admin), { email: "x@studio.test", role: "admin", password: PASSWORD });
  assert.equal(denied.status, 403, "an admin cannot invite");
});

test("the same email twice is a 409 sentence, not a 500", { skip }, async () => {
  const owner = await login("owner@studio.test");
  const dup = await join(app, as(owner), { email: "admin@studio.test", role: "admin", password: PASSWORD });
  assert.equal(dup.status, 409);
});

test("the last owner cannot be demoted or removed; a second owner can", { skip }, async () => {
  const owner = await login("owner@studio.test");
  assert.equal((await app.request("/api/v1/members/owner%40studio.test", { method: "PATCH", headers: as(owner), body: JSON.stringify({ role: "admin" }) })).status, 409);
  assert.equal((await app.request("/api/v1/members/admin%40studio.test", { method: "PATCH", headers: as(owner), body: JSON.stringify({ role: "owner" }) })).status, 200);
  // Now there are two owners; the first may step down.
  assert.equal((await app.request("/api/v1/members/owner%40studio.test", { method: "PATCH", headers: as(owner), body: JSON.stringify({ role: "admin" }) })).status, 200);
  // …and is now an admin, so cannot manage members any more — the demotion took effect on the live session.
  assert.equal((await app.request("/api/v1/members/admin%40studio.test", { method: "PATCH", headers: as(owner), body: JSON.stringify({ role: "admin" }) })).status, 403);
});

test("removing a member revokes their sessions: the cookie stops working at once", { skip }, async () => {
  const boss = await login("admin@studio.test"); // now the sole owner
  const add = await join(app, as(boss), { email: "temp@studio.test", role: "admin", password: PASSWORD });
  assert.equal(add.status, 201);
  const temp = await login("temp@studio.test");
  assert.equal((await app.request("/api/v1/me", { headers: { Cookie: temp.cookie } })).status, 200);
  assert.equal((await app.request("/api/v1/members/temp%40studio.test", { method: "DELETE", headers: as(boss) })).status, 200);
  assert.equal((await app.request("/api/v1/me", { headers: { Cookie: temp.cookie } })).status, 401, "the removed member's cookie is dead");
  // And the email is free again — the user row is soft-deleted, the unique index is partial.
  assert.equal((await join(app, as(boss), { email: "temp@studio.test", role: "admin", password: PASSWORD })).status, 201);
});

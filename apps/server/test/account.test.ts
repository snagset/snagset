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

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the account tests";
let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
const SECRET = Buffer.alloc(32, 9).toString("base64url");
const PASSWORD = "correct horse battery staple";
const json = { "content-type": "application/json" };

async function login(email: string, password = PASSWORD) {
  const res = await app.request("/auth/login", { method: "POST", headers: json, body: JSON.stringify({ email, password }) });
  const text = await res.text();
  return { status: res.status, cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "), csrf: res.status === 200 ? (JSON.parse(text) as { csrfToken: string }).csrfToken : "" };
}
const as = (a: { cookie: string; csrf: string }) => ({ ...json, Cookie: a.cookie, [HTTP_HEADER.csrf]: a.csrf });

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`; await sql`CREATE SCHEMA public`; await migrate(sql, () => {});
  app = createApp({ sql, cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_BASE_URL: "http://localhost:8080" }), secretKey: SECRET, state: "READY", version: "0.0.0-test", commit: "test", sourceUrl: "", modified: false });
  const orgId = randomUUID(), ownerId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email, name, password_hash, email_verified) VALUES (${ownerId}, ${orgId}, 'owner@studio.test', '', ${hashPassword(PASSWORD)}, true)`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${ownerId}, 'owner')`;
  });
});
after(async () => { if (sql) await sql.end({ timeout: 5 }); });

test("renaming the studio and yourself shows up on /me", { skip }, async () => {
  const me = await login("owner@studio.test");
  assert.equal((await app.request("/api/v1/org", { method: "PATCH", headers: as(me), body: JSON.stringify({ name: "Example Studio" }) })).status, 200);
  assert.equal((await app.request("/api/v1/me", { method: "PATCH", headers: as(me), body: JSON.stringify({ name: "Edith" }) })).status, 200);
  const j = (await (await app.request("/api/v1/me", { headers: { Cookie: me.cookie } })).json()) as { org: { name: string }; user: { name: string } };
  assert.equal(j.org.name, "Example Studio"); assert.equal(j.user.name, "Edith");
});

test("a password change needs the current one, keeps this session, and ends every other", { skip }, async () => {
  const here = await login("owner@studio.test");
  const elsewhere = await login("owner@studio.test");
  assert.equal((await app.request("/api/v1/me/password", { method: "POST", headers: as(here), body: JSON.stringify({ current: "not it", next: "a brand new passphrase" }) })).status, 400);
  assert.equal((await app.request("/api/v1/me/password", { method: "POST", headers: as(here), body: JSON.stringify({ current: PASSWORD, next: "a brand new passphrase" }) })).status, 200);
  assert.equal((await app.request("/api/v1/me", { headers: { Cookie: here.cookie } })).status, 200, "the session that changed it survives");
  assert.equal((await app.request("/api/v1/me", { headers: { Cookie: elsewhere.cookie } })).status, 401, "every other session is out");
  assert.equal((await login("owner@studio.test", PASSWORD)).status, 401, "the old password is dead");
  assert.equal((await login("owner@studio.test", "a brand new passphrase")).status, 200, "the new one works");
});

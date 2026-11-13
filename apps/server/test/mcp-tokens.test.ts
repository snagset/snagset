import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { verifyMcpToken } from "../src/routes/mcpToken.ts";
import { CREDENTIAL_PREFIX, HTTP_HEADER } from "@snagset/types/names";

/**
 * The agent tokens from the dashboard, 05 endpoint 32b — through the
 * real routes: minted once, listed without the secret, accepted by the MCP
 * bearer auth on the threads route, refused after revoke. Skipped without
 * `SNAGSET_TEST_DATABASE_URL`; drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the MCP token tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let owner: { cookie: string; csrf: string };
let admin: { cookie: string; csrf: string };
let uid: string;
let orgId: string;

const SECRET = Buffer.alloc(32, 11).toString("base64url");
const PASSWORD = "correct horse battery staple";

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `login failed for ${email}: ${text}`);
  return {
    cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "),
    csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken,
  };
}
const as = (who: { cookie: string; csrf: string }) => ({ "content-type": "application/json", Cookie: who.cookie, [HTTP_HEADER.csrf]: who.csrf });
const json = (res: Response) => res.json() as Promise<Record<string, any>>;

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
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    for (const [email, role, name] of [["o@e.test", "owner", "Olá Owner"], ["a@e.test", "admin", "Ana Admin"]] as const) {
      const id = randomUUID();
      await tx`INSERT INTO users (id, org_id, email, name, password_hash) VALUES (${id}, ${orgId}, ${email}, ${name}, ${hashPassword(PASSWORD)})`;
      await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${id}, ${role}::snag_member_role)`;
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
    env: {},
  });
  owner = await login("o@e.test");
  admin = await login("a@e.test");
  const made = await app.request("/api/v1/projects", { method: "POST", headers: as(owner), body: JSON.stringify({ name: "Kilnwork", domain: "kilnwork.studio" }) });
  const madeText = await made.text();
  assert.equal(made.status, 201, madeText);
  uid = (JSON.parse(madeText) as { uid: string }).uid;
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

test("minted once by an owner with the read-only default, listed without the secret; admins see it", { skip }, async () => {
  const empty = await json(await app.request("/api/v1/mcp-tokens", { headers: as(admin) }));
  assert.deepEqual(empty["data"], []);
  assert.deepEqual(empty["defaults"], ["threads:read", "source:map"]);

  const res = await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(owner), body: JSON.stringify({ name: "  Claude Code " }) });
  assert.equal(res.status, 201, await res.clone().text());
  const made = await json(res);
  assert.ok(made["secret"].startsWith(CREDENTIAL_PREFIX.mcp), made["secret"]);
  assert.match(made["secret"], /^[a-z]+_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
  assert.equal(made["token"].name, "Claude Code");
  assert.deepEqual(made["token"].scopes, ["threads:read", "source:map"]);
  assert.equal(made["token"].site, null);
  assert.equal(made["token"].createdBy, "Olá Owner");
  assert.equal(made["token"].prefix, made["secret"].slice(CREDENTIAL_PREFIX.mcp.length, CREDENTIAL_PREFIX.mcp.length + 8));

  const listed = await json(await app.request("/api/v1/mcp-tokens", { headers: as(admin) }));
  assert.equal(listed["data"].length, 1);
  assert.ok(!JSON.stringify(listed).includes(made["secret"]), "the secret is never listed");
  assert.equal(listed["data"][0].revokedAt, null);

  assert.equal(listed["data"][0].canRevoke, false, "an admin may not revoke the owner's token");
  const anon = await app.request("/api/v1/mcp-tokens");
  assert.equal(anon.status, 401);
});

test("the token is validated: a name, known scopes, the org's own site, a sane expiry", { skip }, async () => {
  const noName = await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(owner), body: JSON.stringify({ name: " " }) });
  assert.equal(noName.status, 422);
  assert.equal((await json(noName))["error"].details.field, "name");
  const badScope = await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(owner), body: JSON.stringify({ name: "x", scopes: ["threads:read", "admin:all"] }) });
  assert.equal(badScope.status, 422);
  assert.match((await json(badScope))["error"].message, /No scope called "admin:all"/);
  const none = await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(owner), body: JSON.stringify({ name: "x", scopes: [] }) });
  assert.equal(none.status, 422);
  const badSite = await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(owner), body: JSON.stringify({ name: "x", site: "prj_bbbbbbbbbbbb" }) });
  assert.equal(badSite.status, 422);
  assert.equal((await json(badSite))["error"].details.field, "site");
  const badDays = await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(owner), body: JSON.stringify({ name: "x", expiresInDays: 0 }) });
  assert.equal(badDays.status, 422);

  const scoped = await app.request("/api/v1/mcp-tokens", {
    method: "POST",
    headers: as(owner),
    body: JSON.stringify({ name: "CI bot", site: uid, scopes: ["threads:read", "context:read", "comments:write", "comments:write"], expiresInDays: 30 }),
  });
  assert.equal(scoped.status, 201, await scoped.clone().text());
  const t = (await json(scoped))["token"];
  assert.deepEqual(t.site, { uid, name: "Kilnwork" });
  assert.deepEqual(t.scopes, ["threads:read", "context:read", "comments:write"]);
  const days = (new Date(t.expiresAt).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 29 && days <= 30, `expires in ${days} days`);
});

test("the minted token reads threads through the MCP bearer auth; revoked, it is refused and the row says so", { skip }, async () => {
  const res = await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(owner), body: JSON.stringify({ name: "Cursor" }) });
  const { token, secret } = (await json(res)) as { token: { id: string }; secret: string };

  const read = await app.request(`/api/v1/projects/${uid}/threads`, { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(read.status, 200, await read.clone().text());
  assert.ok((await verifyMcpToken(sql, secret)) !== null);

  const revoked = await app.request(`/api/v1/mcp-tokens/${token.id}`, { method: "DELETE", headers: as(owner) });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.ok((await json(revoked))["token"].revokedAt);
  assert.equal(await verifyMcpToken(sql, secret), null);
  const refused = await app.request(`/api/v1/projects/${uid}/threads`, { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(refused.status, 401);

  const again = await app.request(`/api/v1/mcp-tokens/${token.id}`, { method: "DELETE", headers: as(owner) });
  assert.equal(again.status, 404, "revoking twice is a 404, not a silent yes");
  const adminRevoke = await app.request(`/api/v1/mcp-tokens/${token.id}`, { method: "DELETE", headers: as(admin) });
  assert.equal(adminRevoke.status, 404, "not theirs to revoke, and already revoked besides");
  const listed = await json(await app.request("/api/v1/mcp-tokens", { headers: as(owner) }));
  const rows = listed["data"] as { name: string; revokedAt: string | null }[];
  assert.ok(rows.find((r) => r.name === "Cursor")!.revokedAt, "the row stays, marked revoked");
  assert.equal(rows[rows.length - 1]!.name, "Cursor", "revoked rows sort last");
});

test("an admin mints their own token and revokes it, never the owner's; removed from the studio, their tokens die", { skip }, async () => {
  const mine = await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(admin), body: JSON.stringify({ name: "Ana's agent" }) });
  assert.equal(mine.status, 201, await mine.clone().text());
  const m = await json(mine);
  assert.equal(m["token"].createdBy, "Ana Admin");
  assert.equal(m["token"].canRevoke, true);

  const owners = await json(
    await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(owner), body: JSON.stringify({ name: "Owner's agent" }) }),
  );
  const notHers = await app.request(`/api/v1/mcp-tokens/${owners["token"].id}`, { method: "DELETE", headers: as(admin) });
  assert.equal(notHers.status, 404, "an admin cannot revoke a token they did not make");
  assert.notEqual(await verifyMcpToken(sql, owners["secret"]), null, "and it still works");

  const own = await app.request(`/api/v1/mcp-tokens/${m["token"].id}`, { method: "DELETE", headers: as(admin) });
  assert.equal(own.status, 200, await own.clone().text());
  assert.equal(await verifyMcpToken(sql, m["secret"]), null);

  // A second token of hers, then she leaves the studio: it is revoked with her.
  const later = await json(
    await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(admin), body: JSON.stringify({ name: "Ana again" }) }),
  );
  assert.notEqual(await verifyMcpToken(sql, later["secret"]), null);
  const removed = await app.request("/api/v1/members/a@e.test", { method: "DELETE", headers: as(owner) });
  assert.ok(removed.status < 300, await removed.clone().text());
  assert.equal(await verifyMcpToken(sql, later["secret"]), null, "a removed member's tokens are revoked");
  assert.notEqual(await verifyMcpToken(sql, owners["secret"]), null, "nobody else's");
});

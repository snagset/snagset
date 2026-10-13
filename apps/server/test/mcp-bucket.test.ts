import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { mintMcpToken } from "../src/routes/mcpToken.ts";
import { READ_BUDGET } from "../src/routes/mcpAuth.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * The MCP read bucket — the `mcp:token`, 120 a minute. Skipped
 * without `SNAGSET_TEST_DATABASE_URL`; drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the MCP bucket tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let orgId: string;
let uid: string;
let tokenA: { id: string; token: string };
let tokenB: { id: string; token: string };
const SECRET = Buffer.alloc(32, 19).toString("base64url");
const PASSWORD = "correct horse battery staple";

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  orgId = randomUUID();
  const userId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email, name, password_hash) VALUES (${userId}, ${orgId}, 'o@e.test', 'Owner', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner'::snag_member_role)`;
  });
  app = createApp({ sql, cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET, SNAGSET_BASE_URL: "https://review.example.dev" }), secretKey: SECRET, state: "READY", version: "0.0.0-test", commit: "test", sourceUrl: "https://example.test", modified: false, env: {} });
  const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "o@e.test", password: PASSWORD }) });
  const text = await login.text();
  const owner = { cookie: login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "), csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken };
  const made = await app.request("/api/v1/projects", { method: "POST", headers: { "content-type": "application/json", Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf }, body: JSON.stringify({ name: "Kilnwork", domain: "kilnwork.studio" }) });
  uid = ((await made.json()) as { uid: string }).uid;
  tokenA = await mintMcpToken(sql, randomUUID(), { orgId, name: "A" });
  tokenB = await mintMcpToken(sql, randomUUID(), { orgId, name: "B" });
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const read = (token: string) => app.request(`/api/v1/projects/${uid}/threads`, { headers: { Authorization: `Bearer ${token}` } });

test("the 121st request in a minute is a 429 that tells the agent to stop; another token is unaffected; the window clears", { skip }, async () => {
  for (let i = 0; i < READ_BUDGET.requests; i++) {
    const r = await read(tokenA.token);
    assert.equal(r.status, 200, `request ${i + 1} should pass`);
  }
  const over = await read(tokenA.token);
  assert.equal(over.status, 429);
  const body = (await over.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "quota_exceeded");
  assert.match(body.error.message, /Stop and ask your user/);
  assert.match(body.error.message, /do not retry/);

  assert.equal((await read(tokenB.token)).status, 200, "one token's budget is its own");

  // The minute passes — rewind the window rather than wait for it.
  await sql`UPDATE rate_counters SET window_start = window_start - interval '2 minutes' WHERE bucket_key = ${"mcp:" + tokenA.id}`;
  assert.equal((await read(tokenA.token)).status, 200, "a fresh window starts");
});

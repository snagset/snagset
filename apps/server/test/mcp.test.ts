import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { mintMcpToken, verifyMcpToken, DEFAULT_SCOPES } from "../src/routes/mcpToken.ts";
import { WRITE_BUDGET } from "../src/routes/mcpAuth.ts";
import { CREDENTIAL_PREFIX } from "@snagset/types/names";

/**
 * The MCP credential, end to end.
 *
 * Against a real Postgres because every claim here is a claim about a row: a
 * revoked token stops working, a scope-less token is refused rather than
 * quietly served, the write budget counts `events` and therefore survives a
 * restart, and an agent's comment is `kind='guest', is_agent=true`.
 *
 * What is asserted is the BEHAVIOUR AT THE ROUTE, not the middleware in
 * isolation. `mcp_tokens` sat in migration 0001 for weeks with a perfectly good
 * shape and no route that accepted it; a unit test of `verifyMcpToken` would
 * have passed the whole time.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the MCP tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let projectId: string;
let orgId: string;
let threadId: string;
let privateThreadId: string;

/** Minted per test-need, so each token's scopes are visible where it is used. */
async function token(scopes: string[], name = "Claude Code"): Promise<string> {
  const m = await mintMcpToken(sql, randomUUID(), { orgId, name, scopes: scopes as never });
  return m.token;
}

const SECRET = Buffer.alloc(32, 7).toString("base64url");

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
  uid = "prj_cccccccccccc";
  const userId = randomUUID();
  const envId = randomUUID();
  const roundId = randomUUID();
  const reviewerId = randomUUID();
  threadId = randomUUID();
  privateThreadId = randomUUID();

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email) VALUES (${userId}, ${orgId}, 'o@e.test')`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag)
      VALUES (${projectId}, ${orgId}, ${uid}, 'Site', ${Buffer.alloc(32, 1)}, 'etag')`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${envId}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    await tx`
      INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
      VALUES (${roundId}, ${orgId}, ${projectId}, 1, 'Round 1', ${userId})`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${reviewerId}, ${orgId}, ${projectId}, 'guest', 'Ada', ${Buffer.alloc(32, 2)})`;
    // `round_number` is the thread's POSITION within its round (the
    // number on the pin), unique per round, and NOT which round it is. Both
    // fixtures started at 1 and the insert failed on the unique index; the same
    // two-integers-one-word-apart trap the list route's own comment records.
    for (const [id, key, n, isPrivate] of [
      [threadId, "SN-1", 1, false],
      [privateThreadId, "SN-2", 2, true],
    ] as const) {
      await tx`
        INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                             anchor, context, created_by, private, comment_count, comment_count_public)
        VALUES (${id}, ${orgId}, ${projectId}, ${key}, ${envId}, ${roundId}, ${n},
                ${tx.json({ offset: {}, page: {} })}, ${tx.json({})}, ${reviewerId}, ${isPrivate}, 0, 0)`;
    }
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
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>;
const auth = (t: string) => ({ Authorization: `Bearer ${t}`, "content-type": "application/json" });
const listPath = () => `/api/v1/projects/${uid}/threads`;

// ── the credential itself ────────────────────────────────────────────────

test("the minted token carries the derived prefix, not a hand-typed one", { skip }, async () => {
  const t = await token([...DEFAULT_SCOPES]);
  // 07 awards `cdmcp_`, which predates the rename. What ships is derived from
  // the brand, and this is the assertion that stops the spec's stale literal
  // from being copied back in.
  assert.equal(CREDENTIAL_PREFIX.mcp, "snagmcp_");
  assert.ok(t.startsWith("snagmcp_"), t.slice(0, 12));
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mcp_tokens WHERE token_hash = decode('','hex')`;
  assert.equal(row!.n, 0, "nothing is stored under an empty hash");
});

test("the plaintext token is never stored — only its hash", { skip }, async () => {
  const t = await token([...DEFAULT_SCOPES]);
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM mcp_tokens WHERE name || prefix LIKE ${"%" + t.slice(-20) + "%"}
  `;
  assert.equal(rows[0]!.n, 0);
  // And it still verifies, which is the point of hashing rather than dropping.
  assert.ok(await verifyMcpToken(sql, t));
});

test("a revoked token stops verifying", { skip }, async () => {
  const m = await mintMcpToken(sql, randomUUID(), { orgId, name: "doomed" });
  assert.ok(await verifyMcpToken(sql, m.token));
  await sql`UPDATE mcp_tokens SET revoked_at = now() WHERE id = ${m.id}`;
  assert.equal(await verifyMcpToken(sql, m.token), null);
});

test("an expired token stops verifying, on the clock the caller passes", { skip }, async () => {
  const past = new Date(Date.now() - 60_000);
  const m = await mintMcpToken(sql, randomUUID(), { orgId, name: "stale", expiresAt: past });
  assert.equal(await verifyMcpToken(sql, m.token), null);
  // Not time-fragile: `expires_at` is relative to now at mint, and the clock is
  // injected. A literal timestamp here passed every morning and failed at noon
  // once already in this repo.
  assert.ok(await verifyMcpToken(sql, m.token, new Date(past.getTime() - 1000)));
});

test("an unknown scope is refused at MINT, not discovered at use", { skip }, async () => {
  await assert.rejects(
    () => mintMcpToken(sql, randomUUID(), { orgId, name: "typo", scopes: ["threads:reed"] as never }),
    /unknown MCP scope/,
  );
});

// ── the route half: what a token may actually do ─────────────────────────

test("an invalid MCP bearer is refused loudly, not downgraded to anonymous", { skip }, async () => {
  const res = await app.request(listPath(), { headers: auth("snagmcp_aaaaaaaa_nope") });
  assert.equal(res.status, 401);
  const b = await json(res);
  assert.equal(b.error.code, "unauthorized");
});

test("threads:read lists threads — and NOT the private one", { skip }, async () => {
  const res = await app.request(listPath(), { headers: auth(await token(["threads:read"])) });
  const b = await json(res);
  assert.equal(res.status, 200, JSON.stringify(b));
  const keys = b.data.map((t: any) => t.key).sort();
  assert.deepEqual(keys, ["SN-1"], "a team-only thread is the studio talking about the client");
});

test("a token WITHOUT threads:read is refused, not served the anonymous view", { skip }, async () => {
  // The list route answers with no credential at all, so the silent path is
  // real: an agent handed the public view would report it as the project.
  const anon = await app.request(listPath());
  assert.equal(anon.status, 200, "the route does answer without a credential");

  const res = await app.request(listPath(), { headers: auth(await token(["source:map"])) });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error.code, "mcp_scope_denied");
});

test("comments:write posts as an agent — kind=guest, is_agent, token recorded", { skip }, async () => {
  const t = await token(["threads:read", "comments:write"], "Claude Code");
  const res = await app.request(`/api/v1/threads/thr_${threadId}/comments`, {
    method: "POST",
    headers: auth(t),
    body: JSON.stringify({ body: "The pin is on a stale selector; src/ProductCard.tsx:42." }),
  });
  const b = await json(res);
  assert.equal(res.status, 201, JSON.stringify(b));
  assert.equal(b.author.kind, "guest", "NEVER verified — that tier means a human the host app vouched for");
  assert.equal(b.author.name, "Claude Code");

  const [rev] = await sql<{ is_agent: boolean; agent_mcp_token_id: string | null }[]>`
    SELECT is_agent, agent_mcp_token_id FROM reviewers WHERE id = ${b.author.id.replace("rev_", "")}
  `;
  assert.equal(rev!.is_agent, true);
  assert.ok(rev!.agent_mcp_token_id, "the write is traceable to the token that made it");

  const [ev] = await sql<{ type: string; actor_kind: string }[]>`
    SELECT type, actor_kind FROM events WHERE subject_id = ${b.id.replace("cmt_", "")}
  `;
  assert.equal(ev!.type, "comment.created", "every agent write lands in events");
  assert.equal(ev!.actor_kind, "integration");
});

test("a read-only token cannot comment", { skip }, async () => {
  const res = await app.request(`/api/v1/threads/thr_${threadId}/comments`, {
    method: "POST",
    headers: auth(await token([...DEFAULT_SCOPES])),
    body: JSON.stringify({ body: "let me in" }),
  });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error.code, "mcp_scope_denied");
});

test("an agent cannot reply on a team-only thread", { skip }, async () => {
  const res = await app.request(`/api/v1/threads/thr_${privateThreadId}/comments`, {
    method: "POST",
    headers: auth(await token(["comments:write"])),
    body: JSON.stringify({ body: "chiming in" }),
  });
  assert.equal(res.status, 403);
});

test("an agent cannot post a team-only reply", { skip }, async () => {
  const res = await app.request(`/api/v1/threads/thr_${threadId}/comments`, {
    method: "POST",
    headers: auth(await token(["comments:write"])),
    body: JSON.stringify({ body: "quietly", private: true }),
  });
  // The `session!.perm` on the line below this check would have thrown a 500.
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error.code, "field_not_permitted");
});

test("threads:write marks a thread ready — but NEVER resolves it (D1a)", { skip }, async () => {
  const t = await token(["threads:write"]);
  const path = `/api/v1/projects/${uid}/threads/thr_${threadId}`;

  const ready = await app.request(path, {
    method: "PATCH",
    headers: auth(t),
    body: JSON.stringify({ status: "review" }),
  });
  assert.equal(ready.status, 200, JSON.stringify(await ready.clone().json()));
  assert.equal((await json(ready)).status, "review");

  const resolve = await app.request(path, {
    method: "PATCH",
    headers: auth(t),
    body: JSON.stringify({ status: "resolved" }),
  });
  assert.equal(resolve.status, 403, "an agent proposes; it never disposes");
  const [row] = await sql<{ status: string }[]>`SELECT status FROM threads WHERE id = ${threadId}`;
  assert.equal(row!.status, "review", "and the refusal happened before the write, not after");
});

test("the write budget stops the agent — driven through the route, not seeded", { skip }, async () => {
  const m = await mintMcpToken(sql, randomUUID(), {
    orgId,
    name: "busy",
    scopes: ["comments:write"] as never,
  });

  /**
   * EVERY write goes through the real route. The first version of this test
   * INSERTed 20 `events` rows itself and then asserted the 21st request was
   * refused — which proved the counting query and never touched the code that
   * writes the rows. That code stringified the payload into a jsonb column, so
   * postgres.js stored a JSON *string scalar*: `payload->>'mcpTokenId'` was
   * null, the count was zero forever, and the budget did not exist. Found by
   * making 21 real writes against a published tarball and watching all 21
   * succeed.
   *
   * A test that builds its own fixture is testing its own fixture.
   */
  const statuses: number[] = [];
  for (let i = 0; i < WRITE_BUDGET.writes + 1; i++) {
    const res = await app.request(`/api/v1/threads/thr_${threadId}/comments`, {
      method: "POST",
      headers: auth(m.token),
      body: JSON.stringify({ body: `write ${i}` }),
    });
    statuses.push(res.status);
    if (res.status === 429) {
      assert.match((await res.json() as any).error.message, /do not retry/i, "The stop signal");
      break;
    }
  }
  assert.equal(statuses.filter((s) => s === 201).length, WRITE_BUDGET.writes, "exactly the budget, no more");
  assert.equal(statuses.at(-1), 429, "and then a wall the agent has to report");

  // The rows are queryable, which is the half that silently broke.
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM events WHERE payload->>'mcpTokenId' = ${m.id}
  `;
  assert.equal(row!.n, WRITE_BUDGET.writes, "one audit row per write, and findable");
});

test("a token for another org is a valid token and still cannot read this project", { skip }, async () => {
  const otherOrg = randomUUID();
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${otherOrg}, 'Other', 'other')`;
  const m = await mintMcpToken(sql, randomUUID(), {
    orgId: otherOrg,
    name: "foreign",
    scopes: ["threads:read"] as never,
  });
  const res = await app.request(listPath(), { headers: auth(m.token) });
  assert.equal(res.status, 403, "verified, attached, and scoped to somebody else's org");
});

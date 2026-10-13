import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { mintMcpToken } from "../src/routes/mcpToken.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * POST /mcp — the remote transport. The SDK's own client, talking to
 * the app in-process through its fetch, so what is proved is the real wire
 * shape end to end. Skipped without `SNAGSET_TEST_DATABASE_URL`; drops the
 * schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the MCP HTTP tests";

let sql: postgres.Sql;
let on: ReturnType<typeof createApp>;
let off: ReturnType<typeof createApp>;
let owner: { cookie: string; csrf: string };
let orgId: string;
let uid: string;
let projectId: string;
let readToken: string;
let writeToken: string;
let remoteToken: string;

const SECRET = Buffer.alloc(32, 17).toString("base64url");
const PASSWORD = "correct horse battery staple";

function build(env: Record<string, string>) {
  return createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET, SNAGSET_BASE_URL: "https://review.example.dev", ...env }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
    env: {},
  });
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  const text = await res.text();
  assert.equal(res.status, 200, `login failed for ${email}: ${text}`);
  return { cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "), csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken };
}
const as = (who: { cookie: string; csrf: string }) => ({ "content-type": "application/json", Cookie: who.cookie, [HTTP_HEADER.csrf]: who.csrf });

/** An SDK client wired to the app's fetch — no socket, the real transport. */
async function agent(app: ReturnType<typeof createApp>, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("https://review.example.dev/mcp"), {
    // FetchLike wants a promise; Hono's request() may answer synchronously.
    fetch: async (input, init) => app.request(input, init),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-agent", version: "0" });
  // The SDK's Transport interface and its own client class disagree under
  // exactOptionalPropertyTypes (optional vs `| undefined`); the object is right.
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return client;
}

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  orgId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    const id = randomUUID();
    await tx`INSERT INTO users (id, org_id, email, name, password_hash) VALUES (${id}, ${orgId}, 'o@e.test', 'Owner', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${id}, 'owner'::snag_member_role)`;
  });
  on = build({ SNAGSET_MCP_HTTP_ENABLED: "true" });
  off = build({});
  owner = await login(on, "o@e.test");
  const made = await on.request("/api/v1/projects", { method: "POST", headers: as(owner), body: JSON.stringify({ name: "Kilnwork", domain: "kilnwork.studio" }) });
  uid = ((await made.json()) as { uid: string }).uid;
  const [p] = await sql<{ id: string }[]>`SELECT id FROM projects WHERE uid = ${uid}`;
  projectId = p!.id;

  // One thread with one comment, so there is something to list.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    const [env] = await tx<{ id: string }[]>`SELECT id FROM environments WHERE project_id = ${projectId} AND is_default`;
    const [round] = await tx<{ id: string }[]>`SELECT id FROM rounds WHERE project_id = ${projectId}`;
    const reviewer = randomUUID();
    const thread = randomUUID();
    await tx`INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash) VALUES (${reviewer}, ${orgId}, ${projectId}, 'guest', 'Ada the client', ${Buffer.alloc(32, 5)})`;
    await tx`INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number, anchor, context, created_by, comment_count, comment_count_public)
             VALUES (${thread}, ${orgId}, ${projectId}, 'SN-1', ${env!.id}, ${round!.id}, 1,
                     ${tx.json({ label: "the price table", css: "table", page: { origin: "https://kilnwork.studio", pathname: "/pricing", route: "/pricing" }, offset: {} })},
                     ${tx.json({ ua: "x" })}, ${reviewer}, 1, 1)`;
    await tx`INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body) VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${thread}, 1, ${reviewer}, 'the price table wraps on tablets')`;
    await tx`UPDATE projects SET thread_seq = 1 WHERE id = ${projectId}`;
    await tx`UPDATE rounds SET thread_seq = 1 WHERE id = ${round!.id}`;
  });

  readToken = (await mintMcpToken(sql, randomUUID(), { orgId, name: "Reader" })).token;
  writeToken = (await mintMcpToken(sql, randomUUID(), { orgId, name: "Writer", scopes: ["threads:read", "comments:write"] })).token;
  remoteToken = (await mintMcpToken(sql, randomUUID(), { orgId, name: "Remote writer", scopes: ["threads:read", "comments:write"], allowRemoteWrites: true })).token;
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

test("off by default: POST /mcp is a 404 naming the switch and the flag, whatever the token", { skip }, async () => {
  const res = await off.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${readToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  assert.equal(res.status, 404);
  const message = ((await res.json()) as any).error.message as string;
  assert.match(message, /Studio › Integrations › MCP/);
  assert.match(message, /SNAGSET_MCP_HTTP_ENABLED/);
});

test("the switch: an owner turns the transport on from the dashboard and it counts from the next request; the environment, when set, wins and locks", { skip }, async () => {
  const mcpPost = (app: ReturnType<typeof createApp>) =>
    app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${readToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  const tokens = async (app: ReturnType<typeof createApp>) => ((await (await app.request("/api/v1/mcp-tokens", { headers: as(owner) })).json()) as any).http;
  const flip = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request("/api/v1/instance/mcp-http", { method: "PUT", headers: as(owner), body: JSON.stringify(body) });

  // The card's data says off, and that nobody decided it.
  assert.deepEqual(await tokens(off), { enabled: false, source: "default", url: "https://review.example.dev/mcp" });

  // On, from the dashboard: the snapshot records it, the card sees it, and
  // the SDK client is served — no restart in between.
  const on1 = await flip(off, { enabled: true });
  assert.equal(on1.status, 200, await on1.clone().text());
  const snap = ((await on1.json()) as any).mcpHttp;
  assert.equal(snap.enabled, true);
  assert.equal(snap.source, "stored");
  assert.ok(snap.updatedAt);
  assert.equal((await tokens(off)).source, "stored");
  const client = await agent(off, readToken);
  assert.ok((await client.listTools()).tools.some((t) => t.name === "list_threads"));
  await client.close();

  // Not a boolean is a 422, never a silent off.
  const bad = await flip(off, { enabled: "yes" });
  assert.equal(bad.status, 422);
  assert.equal(((await bad.json()) as any).error.details.field, "enabled");

  // The environment wins and locks: the pinned app refuses the write and
  // says whose it is; its card says the same.
  const locked = await flip(on, { enabled: false });
  assert.equal(locked.status, 409);
  assert.equal(((await locked.json()) as any).error.code, "managed_by_environment");
  assert.equal((await tokens(on)).source, "env");
  assert.equal((await tokens(on)).enabled, true);

  // Forgotten: the row goes, and the very next request is a 404 again.
  const gone = await off.request("/api/v1/instance/mcp-http", { method: "DELETE", headers: as(owner) });
  assert.equal(gone.status, 200);
  assert.equal(((await gone.json()) as any).mcpHttp.source, "default");
  assert.equal((await mcpPost(off)).status, 404);
});

test("on: the SDK client lists the tools — every stdio tool but source mapping — and reads a thread with the token the dashboard mints", { skip }, async () => {
  const anon = await on.request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  assert.equal(anon.status, 401, "no bearer, no server");

  const client = await agent(on, readToken);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["comment_on_thread", "get_thread", "get_thread_context", "list_threads", "mark_ready"]);
  assert.ok(!tools.includes("map_thread_to_source"), "no checkout here, so no source mapping");

  const listed = await client.callTool({ name: "list_threads", arguments: { project: uid } });
  const text = (listed.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  assert.match(text, /SN-1/);
  assert.match(text, /price table wraps/);
  await client.close();
});

test("a write over HTTP needs allow_remote_writes: refused with the code, then allowed, then it lands", { skip }, async () => {
  const plain = await agent(on, writeToken);
  const refused = await plain.callTool({ name: "comment_on_thread", arguments: { key: "SN-1", project: uid, body: "on it" } });
  assert.equal(refused.isError, true);
  assert.match((refused.content as { text: string }[]).map((c) => c.text).join(" "), /remote_writes_not_allowed|not write/);
  await plain.close();

  const remote = await agent(on, remoteToken);
  const posted = await remote.callTool({ name: "comment_on_thread", arguments: { key: "SN-1", project: uid, body: "on it — remote" } });
  assert.notEqual(posted.isError, true, JSON.stringify(posted.content));
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM comments WHERE body = 'on it — remote'`;
  assert.equal(row!.n, 1, "the agent's reply is in the database");
  await remote.close();

  // The gate is a header our transport sets; a token without the flag can
  // still write over stdio, which sets no such header.
  const direct = await on.request(`/api/v1/projects/${uid}/threads`, { headers: { Authorization: `Bearer ${writeToken}` } });
  assert.equal(direct.status, 200, "reads are untouched either way");
});

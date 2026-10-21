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

/**
 * The `member` seat, through the real routes against a real Postgres.
 *
 * A member is a designer: every site and every comment, status, assignees,
 * rounds (start one, file comments into one), their own words, their own
 * agent tokens, the widget sign-in — and no settings of any kind. Each route
 * group the audit touched has a test here, and each says both halves: the
 * 403 a member gets where the act is an admin's (with the sentence that says
 * so), and the 2xx where it is theirs. Where the line runs through one route
 * — a comment of their own against somebody else's, their token against an
 * admin's — both sides of it are asserted.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL`; drops the schema, and hands it
 * back empty for setup.test.ts's guard (reviewlink.test.ts says why).
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the member role tests";
const SECRET = Buffer.alloc(32, 23).toString("base64url");
const PASSWORD = "correct horse battery staple";
const SITE = "https://client.test";
const uid = "prj_m3mb3r5eat12";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let orgId: string;
let projectId: string;
let memberUserId: string;
const roundIds: Record<number, string> = {};
type Auth = { cookie: string; csrf: string };
let owner: Auth;
let admin: Auth;
let member: Auth;

async function login(email: string): Promise<Auth> {
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

/** A dashboard call: the cookie and the CSRF half, as the dashboard sends them. */
const call = (as: Auth, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { Cookie: as.cookie, [HTTP_HEADER.csrf]: as.csrf, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const json = (res: Response) => res.json() as Promise<Record<string, any>>;

/** A 403 whose sentence names who may — the refusal is the message, not just the code. */
async function refused(res: Response, says: RegExp, what: string) {
  const text = await res.text();
  assert.equal(res.status, 403, `${what}: ${text}`);
  const b = JSON.parse(text) as { error: { code: string; message: string } };
  assert.equal(b.error.code, "forbidden", what);
  assert.match(b.error.message, says, what);
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
  memberUserId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    for (const [id, email, name, role] of [
      [ownerId, "o@e.test", "Olga Owner", "owner"],
      [randomUUID(), "a@e.test", "Ana Admin", "admin"],
      [memberUserId, "m@e.test", "Mia Member", "member"],
    ] as const) {
      await tx`
        INSERT INTO users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${orgId}, ${email}, ${name}, ${hashPassword(PASSWORD)})`;
      await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${id}, ${role})`;
    }
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, settings)
      VALUES (${projectId}, ${orgId}, ${uid}, 'Kilnwork', ${Buffer.alloc(32, 1)}, ${sql.json({ domain: "acme.test" })})`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    await tx`INSERT INTO project_origins (id, org_id, project_id, pattern, is_wildcard)
             VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${SITE}, false)`;
    for (const [n, name] of [[1, "Internal QA"], [2, "Client QA"]] as const) {
      roundIds[n] = randomUUID();
      await tx`
        INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
        VALUES (${roundIds[n]!}, ${orgId}, ${projectId}, ${n}, ${name}, ${ownerId})`;
    }
  });
  // The studio's reviewer rows, as project create and the membership write
  // make them (studioReviewers.ts) — the three people, members included.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    const { ensureStudioReviewers } = await import("../src/studioReviewers.ts");
    await ensureStudioReviewers(tx as unknown as postgres.TransactionSql, { orgId });
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
  admin = await login("a@e.test");
  member = await login("m@e.test");
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

test("a member signs in to the dashboard, and /me says what they are", { skip }, async () => {
  const me = await json(await call(member, "GET", "/api/v1/me"));
  assert.equal(me.user.role, "member");
  assert.equal(me.projects.length, 1, "every site in the studio");
});

test("sites: a member cannot add, change or delete one; reading its addresses is fine", { skip }, async () => {
  const says = /owner or an admin/;
  await refused(await call(member, "POST", "/api/v1/projects", { name: "Another" }), says, "add a site");
  await refused(await call(member, "PATCH", `/api/v1/projects/${uid}`, { name: "Renamed" }), says, "rename");
  await refused(await call(member, "PATCH", `/api/v1/projects/${uid}`, { writeMode: "link-required" }), says, "audience");
  await refused(await call(member, "PATCH", `/api/v1/projects/${uid}`, { guestsCanChangeStatus: false }), says, "guest status");
  await refused(await call(member, "PATCH", `/api/v1/projects/${uid}`, { status: "paused" }), says, "widget switch");
  await refused(await call(member, "PATCH", `/api/v1/projects/${uid}`, { domain: "evil.test" }), says, "domain");
  await refused(await call(member, "POST", `/api/v1/projects/${uid}/origins`, { origin: "https://evil.test" }), says, "add an origin");
  await refused(await call(member, "DELETE", `/api/v1/projects/${uid}`), says, "delete the site");
  assert.equal((await call(member, "GET", `/api/v1/projects/${uid}/origins`)).status, 200);
  // …and the same rename IS an admin's.
  const ok = await call(admin, "PATCH", `/api/v1/projects/${uid}`, { name: "Kilnwork" });
  assert.equal(ok.status, 200, await ok.clone().text());
});

test("the site DELETE now carries the CSRF pair like every sibling mutation", { skip }, async () => {
  const res = await app.request(`/api/v1/projects/${uid}`, { method: "DELETE", headers: { Cookie: owner.cookie } });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error.code, "csrf_failed");
});

test("integrations: a member neither sees the studio's connections nor changes or uses one", { skip }, async () => {
  const says = /owner or an admin/;
  await refused(await call(member, "GET", "/api/v1/integrations"), says, "studio-wide list");
  await refused(await call(member, "GET", "/api/v1/integrations/slack/manifest"), says, "slack manifest");
  await refused(await call(member, "GET", `/api/v1/projects/${uid}/integrations/github`), says, "one connection");
  await refused(await call(member, "PUT", `/api/v1/projects/${uid}/integrations/github`, { token: "x" }), says, "connect");
  await refused(await call(member, "DELETE", `/api/v1/projects/${uid}/integrations/github`), says, "disconnect");
  await refused(await call(member, "POST", `/api/v1/projects/${uid}/integrations/github/test`), says, "test");
  await refused(await call(member, "POST", `/api/v1/projects/${uid}/integrations/github/webhook-secret`), says, "webhook secret");
  await refused(
    await call(member, "POST", `/api/v1/projects/${uid}/threads/thr_${randomUUID()}/integrations/github`),
    says,
    "create an issue",
  );
  // The per-site list stays readable: the brief names a comment's tracker from it.
  assert.equal((await call(member, "GET", `/api/v1/projects/${uid}/integrations`)).status, 200);
  assert.equal((await call(admin, "GET", "/api/v1/integrations")).status, 200);
});

test("members and invites: a member invites nobody and changes nobody", { skip }, async () => {
  await refused(await call(member, "POST", "/api/v1/members/invites", { role: "member" }), /owner or an admin/, "invite");
  await refused(await call(member, "GET", "/api/v1/members/invites"), /owner or an admin/, "list invites");
  await refused(await call(member, "PATCH", "/api/v1/members/a%40e.test", { role: "member" }), /Only an owner/, "role change");
  await refused(await call(member, "DELETE", "/api/v1/members/a%40e.test"), /Only an owner/, "remove");
  // The list itself is the studio's, readable by everyone in it.
  assert.equal((await call(member, "GET", "/api/v1/members")).status, 200);
});

test("invites: an admin invites members only; an owner any of the three", { skip }, async () => {
  const asAdmin = await call(admin, "POST", "/api/v1/members/invites", { role: "member" });
  assert.equal(asAdmin.status, 201, await asAdmin.clone().text());
  await refused(await call(admin, "POST", "/api/v1/members/invites", { role: "admin" }), /Only an owner can invite an admin/, "admin invites admin");
  await refused(await call(admin, "POST", "/api/v1/members/invites", { role: "owner" }), /Only an owner can invite an owner/, "admin invites owner");

  const ownersAdmin = await json(await call(owner, "POST", "/api/v1/members/invites", { role: "admin" }));
  await refused(await call(admin, "DELETE", `/api/v1/members/invites/${ownersAdmin.invite.id}`), /Only an owner/, "admin withdraws an admin invite");
  const memberInvite = await json(asAdmin);
  assert.equal((await call(admin, "DELETE", `/api/v1/members/invites/${memberInvite.invite.id}`)).status, 200, "admin withdraws a member invite");
  const viewer = await call(owner, "POST", "/api/v1/members/invites", { role: "viewer" });
  assert.equal(viewer.status, 400, "viewer stays unwired");
});

test("invites: a member invite is accepted, and the new member is in the studio's assignee group", { skip }, async () => {
  const made = await json(await call(owner, "POST", "/api/v1/members/invites", { role: "member", email: "new@e.test" }));
  const lookup = await json(
    await app.request("/auth/invites/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: made.token }) }),
  );
  assert.equal(lookup.role, "member");
  const accepted = await app.request("/auth/invites/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: made.token, name: "Nia New", password: PASSWORD }),
  });
  assert.equal(accepted.status, 201, await accepted.clone().text());
  assert.equal((await json(accepted)).role, "member");

  const pool = await json(await call(owner, "GET", `/api/v1/projects/${uid}/assignees`));
  const team = (pool.data as { name: string; isTeam: boolean }[]).filter((r) => r.isTeam).map((r) => r.name).sort();
  assert.deepEqual(team, ["Ana Admin", "Mia Member", "Nia New", "Olga Owner"], "members are studio people in the pool");
});

test("role changes: an owner sets Member; an admin cannot", { skip }, async () => {
  await refused(await call(admin, "PATCH", "/api/v1/members/new%40e.test", { role: "admin" }), /Only an owner/, "admin promotes");
  const up = await call(owner, "PATCH", "/api/v1/members/new%40e.test", { role: "admin" });
  assert.equal(up.status, 200, await up.clone().text());
  const down = await json(await call(owner, "PATCH", "/api/v1/members/new%40e.test", { role: "member" }));
  assert.equal((down.data as { email: string; role: string }[]).find((m) => m.email === "new@e.test")?.role, "member");
});

test("renaming the studio and the instance are not a member's", { skip }, async () => {
  await refused(await call(member, "PATCH", "/api/v1/org", { name: "Mine now" }), /Only an owner can rename/, "rename studio");
  await refused(await call(member, "GET", "/api/v1/instance"), /owner or an admin/, "read instance");
  await refused(await call(member, "PUT", "/api/v1/instance/address", { url: "https://evil.test" }), /Only an owner/, "set address");
  await refused(await call(member, "PUT", "/api/v1/instance/mcp-http", { enabled: true }), /Only an owner/, "remote MCP");
  assert.equal((await call(admin, "GET", "/api/v1/instance")).status, 200, "admins still see it");
  // Their own name is theirs.
  assert.equal((await call(member, "PATCH", "/api/v1/me", { name: "Mia M." })).status, 200);
});

test("rounds: a member starts one; renaming, closing, archiving, reopening and deleting are an admin's", { skip }, async () => {
  const made = await call(member, "POST", `/api/v1/projects/${uid}/rounds`, { name: "Design pass" });
  assert.equal(made.status, 201, await made.clone().text());
  const id = `rnd_${roundIds[1]}`;
  const says = /owner or an admin/;
  await refused(await call(member, "PATCH", `/api/v1/rounds/${id}`, { name: "Nope" }), says, "rename");
  await refused(await call(member, "PATCH", `/api/v1/rounds/${id}`, { closed: true }), says, "close");
  await refused(await call(member, "PATCH", `/api/v1/rounds/${id}`, { closed: false }), says, "reopen");
  await refused(await call(member, "PATCH", `/api/v1/rounds/${id}`, { archived: true }), says, "archive");
  await refused(await call(member, "PATCH", `/api/v1/rounds/${id}`, { archived: false }), says, "restore");
  await refused(await call(member, "DELETE", `/api/v1/rounds/${id}`, { confirm: "Internal QA" }), says, "delete");
  assert.equal((await call(admin, "PATCH", `/api/v1/rounds/${id}`, { name: "Internal QA" })).status, 200);
});

let memberToken: string;
let memberReviewer: string;
let threadId: string;

test("widget: a member signs in from the popup, as the studio row, and is not a moderator", { skip }, async () => {
  const res = await call(member, "POST", `/api/v1/projects/${uid}/sessions/member`, { origin: SITE });
  assert.equal(res.status, 201, await res.clone().text());
  const b = await json(res);
  assert.equal(b.reviewer.kind, "verified");
  assert.equal(b.moderator, false, "their own words only, as in the dashboard");
  assert.ok(b.permissions.includes("thread:private") && b.permissions.includes("thread:assign") && b.permissions.includes("thread:resolve"));
  memberToken = b.sessionToken;
  memberReviewer = (b.reviewer.id as string).slice(4);
  const [row] = await sql<{ user_id: string }[]>`SELECT user_id FROM reviewers WHERE id = ${memberReviewer}::uuid`;
  assert.equal(row?.user_id, memberUserId);
});

test("widget: …and silently, from a page on the dashboard's own site", { skip }, async () => {
  const res = await app.request(`https://snagset.acme.test/api/v1/projects/${uid}/sessions/member/silent`, {
    method: "POST",
    headers: { Origin: "https://staging.acme.test", "Sec-Fetch-Site": "same-site", Cookie: member.cookie },
  });
  assert.equal(res.status, 201, await res.clone().text());
  const b = await json(res);
  assert.equal(b.moderator, false);
  assert.equal((b.reviewer.id as string).slice(4), memberReviewer, "one person, one studio row");
});

test("comments: a member posts from the widget and replies from the dashboard under one name", { skip }, async () => {
  const made = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${memberToken}`, Origin: SITE },
    body: JSON.stringify({
      id: randomUUID(),
      comment: { body: "the hero image is cropped" },
      anchor: { label: "hero", css: "main img", page: { route: "/", origin: SITE, pathname: "/" }, offset: { x: 0.5, y: 0.5 } },
      context: { url: `${SITE}/`, viewport: { w: 1280, h: 800, dpr: 2 } },
    }),
  });
  assert.equal(made.status, 201, await made.clone().text());
  threadId = (await json(made)).id;
  const reply = await call(member, "POST", `/api/v1/threads/${threadId}/comments`, { id: randomUUID(), body: "on it" });
  assert.equal(reply.status, 201, await reply.clone().text());
  assert.equal((await json(reply)).author.id, `rev_${memberReviewer}`);
});

test("status and assignee: a member changes both from the dashboard", { skip }, async () => {
  const status = await call(member, "PATCH", `/api/v1/projects/${uid}/threads/${threadId}`, { status: "progress" });
  assert.equal(status.status, 200, await status.clone().text());
  const [ana] = await sql<{ id: string }[]>`SELECT r.id FROM reviewers r JOIN users u ON u.id = r.user_id WHERE u.email = 'a@e.test' AND r.project_id = ${projectId}::uuid`;
  const assign = await call(member, "PATCH", `/api/v1/projects/${uid}/threads/${threadId}`, { assignee: `rev_${ana!.id}` });
  assert.equal(assign.status, 200, await assign.clone().text());
  assert.equal((await json(assign)).assignee?.id, `rev_${ana!.id}`);
  // …and to themselves, and to a person they add to the pool.
  const added = await call(member, "POST", `/api/v1/projects/${uid}/assignees`, { name: "Dev Contractor" });
  assert.equal(added.status, 201, await added.clone().text());
  const mine = await call(member, "PATCH", `/api/v1/projects/${uid}/threads/${threadId}`, { assignee: `rev_${memberReviewer}` });
  assert.equal(mine.status, 200);
});

test("the thread PATCH and the add-a-person POST now carry the CSRF pair for a cookie", { skip }, async () => {
  const patch = await app.request(`/api/v1/projects/${uid}/threads/${threadId}`, {
    method: "PATCH",
    headers: { Cookie: member.cookie, "content-type": "application/json" },
    body: JSON.stringify({ status: "open" }),
  });
  assert.equal(patch.status, 403);
  assert.equal((await json(patch)).error.code, "csrf_failed");
  const add = await app.request(`/api/v1/projects/${uid}/assignees`, {
    method: "POST",
    headers: { Cookie: member.cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Nobody" }),
  });
  assert.equal(add.status, 403);
  assert.equal((await json(add)).error.code, "csrf_failed");
});

test("moving comments between rounds is a member's too", { skip }, async () => {
  const res = await call(member, "POST", `/api/v1/projects/${uid}/threads/move`, { ids: [threadId], round: 2 });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await json(res)).moved, 1);
});

test("comments: a member edits and deletes their own, never somebody else's; the thread is then not theirs to delete", { skip }, async () => {
  const anas = await json(await call(admin, "POST", `/api/v1/threads/${threadId}/comments`, { id: randomUUID(), body: "looks fine to me" }));
  const own = await json(await call(member, "POST", `/api/v1/threads/${threadId}/comments`, { id: randomUUID(), body: "tpyo" }));

  assert.equal((await call(member, "PATCH", `/api/v1/comments/${own.id}`, { body: "typo" })).status, 200, "edit own");
  await refused(await call(member, "PATCH", `/api/v1/comments/${anas.id}`, { body: "rewritten" }), /your own/, "edit somebody else's");
  await refused(await call(member, "DELETE", `/api/v1/comments/${anas.id}`), /owner or an admin/, "delete somebody else's");
  await refused(await call(member, "DELETE", `/api/v1/projects/${uid}/threads/${threadId}`), /owner or an admin/, "delete a thread with an admin's words in it");
  assert.equal((await call(member, "DELETE", `/api/v1/comments/${own.id}`)).status, 200, "delete own");

  // The admin's, deleted by the admin, leaves the thread all the member's own again.
  assert.equal((await call(admin, "DELETE", `/api/v1/comments/${anas.id}`)).status, 200);
  assert.equal((await call(member, "DELETE", `/api/v1/projects/${uid}/threads/${threadId}`)).status, 204, "a thread that is all theirs");
});

test("widget: a member's session does not delete a client's comment or snag", { skip }, async () => {
  const guest = randomUUID();
  const thread = randomUUID();
  const comment = randomUUID();
  const [t] = await sql<{ environment_id: string }[]>`SELECT id AS environment_id FROM environments WHERE project_id = ${projectId}::uuid`;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${guest}, ${orgId}, ${projectId}, 'guest', 'Cleo Client', ${Buffer.alloc(32, 5)})`;
    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number, anchor, context, created_by)
      VALUES (${thread}, ${orgId}, ${projectId}, 'SN-77', ${t!.environment_id}, ${roundIds[1]!}, 77,
              ${tx.json({ label: "h1", page: { origin: SITE, pathname: "/", route: "/" }, offset: {} })},
              ${tx.json({ url: `${SITE}/` })}, ${guest})`;
    await tx`
      INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
      VALUES (${comment}, ${orgId}, ${projectId}, ${thread}, 1, ${guest}, 'Logo is blurry')`;
  });
  const bearer = { Authorization: `Bearer ${memberToken}`, Origin: SITE, "content-type": "application/json" };
  const del = await app.request(`/api/v1/projects/${uid}/comments/cmt_${comment}`, { method: "DELETE", headers: bearer });
  assert.equal(del.status, 403, "not a moderator in the widget either");
  const gone = await app.request(`/api/v1/projects/${uid}/threads/thr_${thread}`, { method: "DELETE", headers: bearer });
  assert.equal(gone.status, 403);
});

test("MCP tokens: a member mints with every scope, sees and revokes only their own", { skip }, async () => {
  const adminTok = await json(await call(admin, "POST", "/api/v1/mcp-tokens", { name: "Ana's agent" }));
  const made = await call(member, "POST", "/api/v1/mcp-tokens", {
    name: "Mia's Claude Code",
    scopes: ["threads:read", "context:read", "comments:write", "threads:write", "source:map"],
  });
  assert.equal(made.status, 201, await made.clone().text());
  const mine = await json(made);
  assert.equal(mine.token.canRevoke, true);

  const list = await json(await call(member, "GET", "/api/v1/mcp-tokens"));
  assert.deepEqual((list.data as { name: string }[]).map((t) => t.name), ["Mia's Claude Code"], "their own, nobody else's");

  const others = await call(member, "DELETE", `/api/v1/mcp-tokens/${adminTok.token.id}`);
  assert.equal(others.status, 404, "an admin's token is not theirs to revoke");
  assert.match((await json(others)).error.message, /of yours/);

  // The admin and the owner see the member's token; the owner may revoke it.
  const adminList = await json(await call(admin, "GET", "/api/v1/mcp-tokens"));
  const seen = (adminList.data as { id: string; canRevoke: boolean }[]).find((t) => t.id === mine.token.id);
  assert.ok(seen, "admins see every token");
  assert.equal(seen!.canRevoke, false, "an admin revokes their own");
  assert.equal((await call(member, "DELETE", `/api/v1/mcp-tokens/${mine.token.id}`)).status, 200, "their own");
});

test("MCP tokens: a member's token does no more than a member does — an agent never resolves or assigns", { skip }, async () => {
  const made = await json(
    await call(member, "POST", "/api/v1/mcp-tokens", { name: "Mia's second", scopes: ["threads:read", "threads:write"] }),
  );
  const thread = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${memberToken}`, Origin: SITE },
    body: JSON.stringify({
      id: randomUUID(),
      comment: { body: "button misaligned" },
      anchor: { label: "button", css: "main button", page: { route: "/", origin: SITE, pathname: "/" }, offset: { x: 0.5, y: 0.5 } },
      context: { url: `${SITE}/`, viewport: { w: 1280, h: 800, dpr: 2 } },
    }),
  });
  const id = (await json(thread)).id;
  const agent = { Authorization: `Bearer ${made.secret}`, "content-type": "application/json" };
  const resolve = await app.request(`/api/v1/projects/${uid}/threads/${id}`, { method: "PATCH", headers: agent, body: JSON.stringify({ status: "resolved" }) });
  assert.ok(resolve.status >= 400, `an agent never resolves: ${resolve.status}`);
  const assign = await app.request(`/api/v1/projects/${uid}/threads/${id}`, { method: "PATCH", headers: agent, body: JSON.stringify({ assignee: null }) });
  assert.equal(assign.status, 403);
});

test("review links: a member adds a reviewer but cannot revoke one — that signs the whole site out", { skip }, async () => {
  const minted = await call(member, "POST", `/api/v1/projects/${uid}/review-links`, { name: "Client review" });
  const m = await json(minted);
  assert.ok(minted.status === 200 || minted.status === 201, JSON.stringify(m));
  const id = String(m.id ?? m.link?.id);
  assert.ok(id && id !== "undefined", `the mint returns the link's id: ${JSON.stringify(m)}`);
  await refused(await call(member, "DELETE", `/api/v1/review-links/${id}`), /admin/i, "member revokes a link");
  const byAdmin = await call(admin, "DELETE", `/api/v1/review-links/${id}`);
  assert.ok(byAdmin.status === 200 || byAdmin.status === 204, `admin revokes: ${byAdmin.status} ${await byAdmin.clone().text()}`);
});

test("removing a member revokes their tokens and ends their dashboard session", { skip }, async () => {
  const gone = await call(owner, "DELETE", "/api/v1/members/m%40e.test");
  assert.equal(gone.status, 200, await gone.clone().text());
  const [live] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM mcp_tokens WHERE created_by = ${memberUserId}::uuid AND revoked_at IS NULL`;
  assert.equal(live?.n, 0);
  assert.equal((await call(member, "GET", "/api/v1/me")).status, 401);
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { rlsStatus } from "../src/db/rls.ts";
import { createApp } from "../src/app.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * Row-level security WITHOUT the bypass — 's gate, the boot
 * warning turned into a test.
 *
 * Every other suite connects as the test database's superuser, which carries
 * BYPASSRLS, so the policies migration 0001 wrote have never once decided a
 * query in this repository. A correctly-secured deployment — the
 * cloud, phase 2 — connects as a role that cannot bypass, and on that role a
 * query that forgot its claim returns NOTHING, silently. This suite makes
 * such a role, runs the app on it through the doors and the dashboard's
 * core, and asserts both halves: the studio sees its own rows, and never
 * another's. A query that forgot its claim fails HERE.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL`; drops the schema. The URL
 * must be a superuser's (it creates the role and grants the tables).
 */

const ADMIN = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = ADMIN ? false : "set SNAGSET_TEST_DATABASE_URL to run the RLS gate";
const ROLE = "snagset_rls_test";

let admin: postgres.Sql;
let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
const SECRET = Buffer.alloc(32, 13).toString("base64url");
const PASSWORD = "correct horse battery staple";
const json = { "content-type": "application/json" };
type Who = { cookie: string; csrf: string };
const as = (a: Who) => ({ ...json, Cookie: a.cookie, [HTTP_HEADER.csrf]: a.csrf });
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
const ORIGIN = "https://kilnwork.test";

let ada: Who;
let bob: Who;
let uid: string;
let threadId: string;

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && ADMIN === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  admin = connect(ADMIN!, { max: 2 });
  await admin`DROP SCHEMA IF EXISTS public CASCADE`;
  await admin`CREATE SCHEMA public`;
  await migrate(admin, () => {});
  // The role a secured deployment would use: it can log in, it owns nothing,
  // it cannot bypass. Postgres will not let a role drop BYPASSRLS from
  // itself, which is why the dogfood's Neon owner cannot be this role.
  await admin.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
      CREATE ROLE ${ROLE} LOGIN PASSWORD 'rls' NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await admin.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  await admin.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
  await admin.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROLE}`);
  const u = new URL(ADMIN!);
  u.username = ROLE;
  u.password = "rls";
  sql = connect(u.toString(), { max: 4 });
  app = createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: u.toString(), SNAGSET_SECRET_KEY: SECRET, SNAGSET_BASE_URL: "https://cloud.snagset.test", SNAGSET_SIGNUP_OPEN: "true" }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
    env: {},
  });
});

after(async () => {
  await sql?.end({ timeout: 5 });
  if (!skip) {
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
  }
  await admin?.end({ timeout: 5 });
});

const me = async (who: Who) => {
  const res = await app.request("/api/v1/me", { headers: as(who) });
  return { status: res.status, body: (await res.json()) as any };
};

test("the role cannot bypass, and every table with a tenant column is policed", { skip }, async () => {
  const st = await rlsStatus(sql);
  assert.equal(st.roleBypassesRls, false);
  assert.deepEqual(st.unprotected, []);
  assert.deepEqual(st.notForced, []);
  assert.equal(st.effective, true, st.warning ?? "");
});

test("the claim goes through under the policies, and signs its owner in", { skip }, async () => {
  const res = await app.request("/api/v1/setup", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ orgName: "Kilnwork", email: "ada@kilnwork.test", password: PASSWORD, projectName: "Kilnwork site", address: "https://cloud.snagset.test" }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as any;
  ada = { cookie: cookiesOf(res), csrf: body.csrfToken };
  uid = body.project.uid;
  assert.deepEqual(await (await app.request("/api/v1/setup")).json(), { claimed: true, signup: true });
});

test("sign in by email, and /me sees the studio's own rows", { skip }, async () => {
  const login = await app.request("/auth/login", { method: "POST", headers: json, body: JSON.stringify({ email: "ada@kilnwork.test", password: PASSWORD }) });
  assert.equal(login.status, 200, await login.clone().text());
  ada = { cookie: cookiesOf(login), csrf: ((await login.json()) as any).csrfToken };
  const m = await me(ada);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.org.name, "Kilnwork");
  assert.equal(m.body.projects.length, 1);
  assert.equal(m.body.projects[0].uid, uid);
  assert.equal(m.body.limits.members.used, 1);
  assert.deepEqual(m.body.orgs.map((o: any) => o.slug), ["kilnwork"]);
});

test("the dashboard's core under the policies: a site, a rename, a review link, the settings, the tokens", { skip }, async () => {
  const site = await app.request("/api/v1/projects", { method: "POST", headers: as(ada), body: JSON.stringify({ name: "Kilnwork", domain: "kilnwork.test" }) });
  assert.equal(site.status, 201, await site.clone().text());
  uid = ((await site.json()) as any).uid;
  assert.equal((await me(ada)).body.projects.length, 2);

  const rename = await app.request("/api/v1/org", { method: "PATCH", headers: as(ada), body: JSON.stringify({ name: "Kilnwork Studio" }) });
  assert.equal(rename.status, 200, await rename.clone().text());
  assert.equal((await me(ada)).body.org.name, "Kilnwork Studio", "the rename landed on the row, not on zero rows");

  const link = await app.request(`/api/v1/projects/${uid}/review-links`, { method: "POST", headers: as(ada), body: JSON.stringify({ name: "Client review" }) });
  assert.equal(link.status, 201, await link.clone().text());
  const links = await app.request(`/api/v1/projects/${uid}/review-links`, { headers: as(ada) });
  assert.equal(((await links.json()) as any).data?.length ?? ((await links.clone().json()) as any).length, 1);

  const instance = await app.request("/api/v1/instance", { headers: as(ada) });
  assert.equal(instance.status, 200, await instance.clone().text());
  assert.equal(((await instance.json()) as any).address.url, "https://cloud.snagset.test");

  const token = await app.request("/api/v1/mcp-tokens", { method: "POST", headers: as(ada), body: JSON.stringify({ name: "Claude Code" }) });
  assert.equal(token.status, 201, await token.clone().text());
  const secret = ((await token.json()) as any).secret as string;
  const viaMcp = await app.request(`/api/v1/projects/${uid}/threads`, { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(viaMcp.status, 200, await viaMcp.clone().text());
});

test("the widget's doors under the policies: config, a guest session, a thread, a comment", { skip }, async () => {
  const cfg = await app.request(`/api/v1/projects/${uid}/config`, { headers: { Origin: ORIGIN } });
  assert.equal(cfg.status, 200, await cfg.clone().text());
  assert.equal(((await cfg.json()) as any).uid, uid);

  const exchange = await app.request(`/api/v1/projects/${uid}/sessions`, {
    method: "POST",
    headers: { ...json, Origin: ORIGIN },
    body: JSON.stringify({ identity: { kind: "guest", name: "Client Carla", secret: "0123456789abcdef0123456789abcdef" } }),
  });
  assert.equal(exchange.status, 201, await exchange.clone().text());
  const bearer = ((await exchange.json()) as any).sessionToken as string;

  const made = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: { ...json, Origin: ORIGIN, Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ comment: { body: "the price table wraps" }, anchor: { offset: { x: 0.5, y: 0.5 }, page: { route: "/pricing", pathname: "/pricing", origin: ORIGIN } }, context: { url: `${ORIGIN}/pricing` } }),
  });
  assert.equal(made.status, 201, await made.clone().text());
  threadId = ((await made.json()) as any).id;

  const list = await app.request(`/api/v1/projects/${uid}/threads`, { headers: as(ada) });
  assert.equal(list.status, 200);
  const rows = ((await list.json()) as any).data ?? (await list.clone().json());
  assert.equal(rows.length, 1, "the owner sees the guest's thread");

  const reply = await app.request(`/api/v1/projects/${uid}/threads/${threadId}/comments`, { method: "POST", headers: as(ada), body: JSON.stringify({ body: "on it" }) });
  assert.equal(reply.status, 201, await reply.clone().text());
  const detail = await app.request(`/api/v1/projects/${uid}/threads/${threadId}`, { headers: as(ada) });
  assert.equal(detail.status, 200, await detail.clone().text());
});

test("a second studio never sees the first: not its sites, not its threads, not its activity, not by switching", { skip }, async () => {
  const res = await app.request("/auth/register", { method: "POST", headers: { ...json, "x-forwarded-for": "198.51.100.8" }, body: JSON.stringify({ email: "bob@elsewhere.test", password: PASSWORD, orgName: "Elsewhere" }) });
  assert.equal(res.status, 201, await res.clone().text());
  bob = { cookie: cookiesOf(res), csrf: ((await res.json()) as any).csrfToken };

  const m = await me(bob);
  assert.equal(m.body.org.name, "Elsewhere");
  assert.equal(m.body.projects.length, 1);
  assert.notEqual(m.body.projects[0].uid, uid);
  assert.deepEqual(m.body.orgs.map((o: any) => o.slug), ["elsewhere"]);

  // The list answers the public view of an OPEN project to anyone — that is
  // the widget's own read — so another studio's owner gets exactly what a
  // stranger gets, and nothing the cookie would add.
  const view = async (headers: Record<string, string>) => {
    const body = (await (await app.request(`/api/v1/projects/${uid}/threads`, { headers })).json()) as Record<string, unknown>;
    delete body["serverTime"];
    return body;
  };
  assert.deepEqual(await view(as(bob)), await view({}), "a cookie from another studio is no credential here");
  assert.equal((await app.request(`/api/v1/projects/${uid}/threads/${threadId}`, { headers: as(bob) })).status, 401);
  assert.equal((await app.request(`/api/v1/projects/${uid}/review-links`, { headers: as(bob) })).status, 404);
  const activity = await app.request("/api/v1/activity", { headers: as(bob) });
  assert.equal(activity.status, 200);
  assert.deepEqual(((await activity.json()) as any).data, [], "nothing of Kilnwork's in Elsewhere's feed");
  const members = await app.request("/api/v1/members", { headers: as(bob) });
  assert.deepEqual(((await members.json()) as any).data.map((r: any) => r.email), ["bob@elsewhere.test"]);
  const sw = await app.request("/auth/switch", { method: "POST", headers: as(bob), body: JSON.stringify({ slug: "kilnwork" }) });
  assert.equal(sw.status, 404);

  // And the first studio still sees exactly its own.
  assert.equal((await me(ada)).body.projects.length, 2);
});

test("The invites under the policies: minted, looked up and accepted before the tenant is known, and kept to their studio", { skip }, async () => {
  const minted = await app.request("/api/v1/members/invites", { method: "POST", headers: as(ada), body: JSON.stringify({ role: "admin" }) });
  assert.equal(minted.status, 201, await minted.clone().text());
  const { token } = (await minted.json()) as { token: string };
  // The lookup and the accept find the row by its hash with no org claim to
  // stand on — the maintenance claim is what makes them work at all here.
  const seen = await app.request("/auth/invites/lookup", { method: "POST", headers: { ...json, "x-forwarded-for": "198.51.100.21" }, body: JSON.stringify({ token }) });
  assert.equal(seen.status, 200, await seen.clone().text());
  assert.equal(((await seen.json()) as any).org.name, "Kilnwork Studio");
  // Elsewhere's owner sees none of Kilnwork's pending invites.
  assert.deepEqual(((await (await app.request("/api/v1/members/invites", { headers: as(bob) })).json()) as any).data, []);

  const res = await app.request("/auth/invites/accept", {
    method: "POST",
    headers: { ...json, "x-forwarded-for": "198.51.100.21" },
    body: JSON.stringify({ token, name: "Cleo", email: "cleo@kilnwork.test", password: PASSWORD }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const cleo = { cookie: cookiesOf(res), csrf: ((await res.json()) as any).csrfToken };
  const m = await me(cleo);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.org.name, "Kilnwork Studio");
  assert.equal(m.body.user.role, "admin");
  assert.equal(m.body.projects.length, 2, "she sees the studio's sites under its claim");

  // An existing account elsewhere joins with its own password: a membership, not a second user.
  const second = await app.request("/api/v1/members/invites", { method: "POST", headers: as(ada), body: JSON.stringify({ role: "admin", email: "bob@elsewhere.test" }) });
  const t2 = ((await second.json()) as any).token as string;
  const joined = await app.request("/auth/invites/accept", { method: "POST", headers: { ...json, "x-forwarded-for": "198.51.100.22" }, body: JSON.stringify({ token: t2, password: PASSWORD }) });
  assert.equal(joined.status, 201, await joined.clone().text());
  const bob2 = { cookie: cookiesOf(joined), csrf: ((await joined.json()) as any).csrfToken };
  assert.deepEqual((await me(bob2)).body.orgs.map((o: any) => o.slug).sort(), ["elsewhere", "kilnwork"]);

  // And removing him from Kilnwork leaves Elsewhere, under the same policies.
  const out = await app.request("/api/v1/members/bob%40elsewhere.test", { method: "DELETE", headers: as(ada) });
  assert.equal(out.status, 200, await out.clone().text());
  const back = await app.request("/auth/login", { method: "POST", headers: json, body: JSON.stringify({ email: "bob@elsewhere.test", password: PASSWORD }) });
  assert.equal(back.status, 200);
  const bob3 = { cookie: cookiesOf(back), csrf: ((await back.json()) as any).csrfToken };
  assert.deepEqual((await me(bob3)).body.orgs.map((o: any) => o.slug), ["elsewhere"]);
});

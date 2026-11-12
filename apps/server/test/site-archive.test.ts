import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { invalidateLimits } from "../src/plan.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * Archived sites and sites beyond the cap. `free` has no cap; `capped`
 * allows one site, the way a studio downgraded to Free sees it. Both apps
 * share one database, so a studio with three sites under `free` is a studio
 * two over under `capped`. Skipped without `SNAGSET_TEST_DATABASE_URL`;
 * drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the site archive tests";

let sql: postgres.Sql;
let capped: ReturnType<typeof createApp>;
let free: ReturnType<typeof createApp>;
let orgId: string;
let owner: { cookie: string; csrf: string };
const uids: string[] = [];
const SECRET = Buffer.alloc(32, 9).toString("base64url");
const PASSWORD = "correct horse battery staple";
const json = { "content-type": "application/json" };
const as = (a: { cookie: string; csrf: string }) => ({ ...json, Cookie: a.cookie, [HTTP_HEADER.csrf]: a.csrf });

function build(planResolver?: Parameters<typeof createApp>[0]["planResolver"]) {
  return createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET, SNAGSET_BASE_URL: "https://review.example.dev" }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
    env: {},
    ...(planResolver ? { planResolver } : {}),
  });
}

async function login(app: ReturnType<typeof createApp>): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", { method: "POST", headers: json, body: JSON.stringify({ email: "o@studio.test", password: PASSWORD }) });
  const text = await res.text();
  assert.equal(res.status, 200, `login failed: ${text}`);
  return { cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "), csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken };
}
const me = async (app: ReturnType<typeof createApp>) => (await (await app.request("/api/v1/me", { headers: as(owner) })).json()) as any;
const addSite = (app: ReturnType<typeof createApp>, name: string) =>
  app.request("/api/v1/projects", { method: "POST", headers: as(owner), body: JSON.stringify({ name, domain: `${name.toLowerCase()}.test` }) });

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  orgId = randomUUID();
  const ownerId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    await tx`INSERT INTO orgs (id, name, slug, plan) VALUES (${orgId}, 'Studio', 'studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email, name, password_hash, email_verified) VALUES (${ownerId}, ${orgId}, 'o@studio.test', 'Owner', ${hashPassword(PASSWORD)}, true)`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${ownerId}, 'owner')`;
  });
  // The resolver the private caller will hand in: The Studio row, shrunk to
  // fit a test — one site, two seats, no pixel tier, no integrations.
  capped = build(async (org) => {
    assert.equal(org.id, orgId);
    assert.equal(org.plan, "studio", "the resolver is told the org's plan column");
    return { projects: 1 };
  });
  free = build();
  owner = await login(free);
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const ORIGIN = "https://one.test";
async function guest(app: ReturnType<typeof createApp>, uid: string, origin: string) {
  const r = await app.request(`/api/v1/projects/${uid}/sessions`, {
    method: "POST",
    headers: { ...json, Origin: origin },
    body: JSON.stringify({ identity: { kind: "guest", name: "Carla", secret: "0123456789abcdef0123456789abcdef" } }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  return ((await r.json()) as any).sessionToken as string;
}
const post = (app: ReturnType<typeof createApp>, uid: string, origin: string, bearer: string) =>
  app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: { ...json, Origin: origin, Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      comment: { body: "The button is off" },
      anchor: { offset: { x: 0.5, y: 0.5 }, page: { route: "/", pathname: "/", origin } },
      context: { url: `${origin}/` },
    }),
  });
const cfg = async (app: ReturnType<typeof createApp>, uid: string, origin: string) =>
  (await (await app.request(`/api/v1/projects/${uid}/config`, { headers: { Origin: origin } })).json()) as any;
const rename = (app: ReturnType<typeof createApp>, uid: string, name: string) =>
  app.request(`/api/v1/projects/${uid}`, { method: "PATCH", headers: as(owner), body: JSON.stringify({ name }) });
const shelve = (app: ReturnType<typeof createApp>, uid: string, to: "archive" | "restore") =>
  app.request(`/api/v1/projects/${uid}/${to}`, { method: "POST", headers: as(owner) });

test("three sites on a one-site plan: the oldest works, the two newer are read-only", { skip }, async () => {
  for (const n of ["One", "Two", "Three"]) {
    const r = await addSite(free, n);
    assert.equal(r.status, 201, await r.clone().text());
    uids.push(((await r.json()) as any).uid);
  }
  invalidateLimits();
  const sites = (await me(capped)).projects as any[];
  assert.deepEqual(sites.map((p) => [p.name, p.locked, p.archived]), [["One", false, false], ["Two", true, false], ["Three", true, false]]);

  assert.equal((await cfg(capped, uids[0]!, ORIGIN)).writable, true);
  const locked = await cfg(capped, uids[1]!, "https://two.test");
  assert.equal(locked.writable, false);
  assert.equal(locked.reason, "site_locked");

  // Reading still works, a reviewer can still open it; writing is refused.
  const bearer = await guest(capped, uids[1]!, "https://two.test");
  const refused = await post(capped, uids[1]!, "https://two.test", bearer);
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as any).error.code, "site_locked");
  const dash = await rename(capped, uids[1]!, "Two renamed");
  assert.equal(dash.status, 403);
  assert.equal(((await dash.json()) as any).error.code, "site_locked");

  const ok = await post(capped, uids[0]!, ORIGIN, await guest(capped, uids[0]!, ORIGIN));
  assert.equal(ok.status, 201, await ok.clone().text());
});

test("archiving frees the slot: the next site in line unlocks, and the archived one is read-only", { skip }, async () => {
  assert.equal((await shelve(capped, uids[0]!, "archive")).status, 204);
  invalidateLimits();
  const m = await me(capped);
  assert.equal(m.limits.projects.used, 2, "an archived site is not counted");
  assert.deepEqual((m.projects as any[]).map((p) => [p.name, p.locked, p.archived]), [["One", false, true], ["Two", false, false], ["Three", true, false]]);

  const archived = await cfg(capped, uids[0]!, ORIGIN);
  assert.equal(archived.writable, false);
  assert.equal(archived.reason, "site_archived");
  const r = await rename(free, uids[0]!, "One renamed");
  assert.equal(r.status, 403, "archived holds without any plan");
  assert.equal(((await r.json()) as any).error.code, "site_archived");

  const two = await post(capped, uids[1]!, "https://two.test", await guest(capped, uids[1]!, "https://two.test"));
  assert.equal(two.status, 201, await two.clone().text());
});

test("restore is refused without room, allowed with it; delete still works on a locked site", { skip }, async () => {
  const no = await shelve(capped, uids[0]!, "restore");
  assert.equal(no.status, 403);
  assert.equal(((await no.json()) as any).error.code, "plan_limit_reached");

  assert.equal((await free.request(`/api/v1/projects/${uids[2]!}`, { method: "DELETE", headers: as(owner) })).status, 204);
  assert.equal((await shelve(capped, uids[1]!, "archive")).status, 204);
  invalidateLimits();
  assert.equal((await shelve(capped, uids[0]!, "restore")).status, 204);
  assert.equal((await cfg(capped, uids[0]!, ORIGIN)).writable, true);
  assert.equal((await rename(capped, uids[0]!, "One again")).status, 200);
});

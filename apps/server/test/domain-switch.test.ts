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
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * (the domain) and (the switch), through the real routes and the real
 * CORS middleware — the widget's own bootstrap request is the witness.
 * Skipped without `SNAGSET_TEST_DATABASE_URL`; drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the domain/switch tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let orgId: string;
let uid: string;
let projectId: string;
let guestId: string;
let guestBearer: string;
let owner: { cookie: string; csrf: string };

const SECRET = Buffer.alloc(32, 9).toString("base64url");
const PASSWORD = "correct horse battery staple";

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `login failed for ${email}: ${text}`);
  const cookie = res.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  return { cookie, csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken };
}
const asOwner = () => ({ "content-type": "application/json", Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf });
const json = (res: Response) => res.json() as Promise<Record<string, any>>;
const site = () => `/api/v1/projects/${uid}`;
const config = (origin: string) => app.request(`${site()}/config`, { headers: { Origin: origin } });
const patchSite = (body: unknown) => app.request(site(), { method: "PATCH", headers: asOwner(), body: JSON.stringify(body) });

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
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email, password_hash) VALUES (${userId}, ${orgId}, 'o@e.test', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
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

  // Created WITH a domain, spelled the way a person types it.
  const made = await app.request("/api/v1/projects", {
    method: "POST",
    headers: asOwner(),
    body: JSON.stringify({ name: "Kilnwork", domain: "https://www.Kilnwork.Studio/", origins: "https://kilnwork-marketing.test" }),
  });
  const madeText = await made.text();
  assert.equal(made.status, 201, madeText);
  const created = JSON.parse(madeText) as { uid: string; domain: string | null; origins: string[] };
  assert.equal(created.domain, "kilnwork.studio");
  uid = created.uid;
  const [p] = await sql<{ id: string }[]>`SELECT id FROM projects WHERE uid = ${uid}`;
  projectId = p!.id;

  guestId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${guestId}, ${orgId}, ${projectId}, 'guest', 'Ada', ${Buffer.alloc(32, 2)})`;
  });
  const minted = await mintSession(
    createKeyring(SECRET),
    { projectUid: uid, reviewerId: guestId, environmentKey: "production", kind: "guest", reviewLinkId: null, permissions: ["thread:create", "comment:create"], sessionEpoch: 1 },
    { slidingS: 900, absoluteS: 43_200 },
  );
  guestBearer = minted.token;
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

test("the domain admits its host, every subdomain, any scheme and port, and localhost; a stranger is refused", { skip }, async () => {
  for (const origin of [
    "https://kilnwork.studio",
    "https://www.kilnwork.studio",
    "http://staging.kilnwork.studio",
    "http://preview-42.staging.kilnwork.studio:3000",
    "http://localhost:5173",
    "http://127.0.0.1:8080",
    "http://app.localhost:3000",
    // The exact address still works beside the domain.
    "https://kilnwork-marketing.test",
  ]) {
    const res = await config(origin);
    assert.equal(res.status, 200, origin);
    assert.equal(res.headers.get("access-control-allow-origin"), origin, `${origin} should get the CORS header`);
    assert.equal((await json(res))["writable"], true, `${origin} should be writable`);
  }
  for (const origin of ["https://notkilnwork.studio", "https://kilnwork.studio.evil.io", "https://kilnwork.study"]) {
    // /config is PUBLIC-READ: the CORS header is echoed for any
    // origin so the suggestion flow works, and the verdict is in the body.
    const res = await config(origin);
    assert.equal(res.status, 200, origin);
    const body = await json(res);
    assert.equal(body["writable"], false, origin);
    assert.equal(body["reason"], "origin_not_allowed");
    // A project-scoped route is where the header itself is withheld.
    const exchange = await app.request(`${site()}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: origin },
      body: JSON.stringify({ identity: { kind: "guest", name: "Ada", secret: "0123456789abcdef0123456789abcdef" } }),
    });
    assert.equal(exchange.headers.get("access-control-allow-origin"), null, `${origin} must not get the CORS header on an exchange`);
  }
});

test("GET origins and /me carry the domain; the site list shows it", { skip }, async () => {
  const where = await json(await app.request(`${site()}/origins`, { headers: asOwner() }));
  assert.deepEqual(where, { domain: "kilnwork.studio", origins: ["https://kilnwork-marketing.test"] });
  const me = await json(await app.request("/api/v1/me", { headers: asOwner() }));
  const mine = (me["projects"] as any[]).find((p) => p.uid === uid);
  assert.equal(mine.domain, "kilnwork.studio");
  assert.equal(mine.status, "active");
});

test("a shared host is refused with a sentence; a subdomain of one is somebody's own site", { skip }, async () => {
  const shared = await patchSite({ domain: "vercel.app" });
  assert.equal(shared.status, 400);
  assert.match((await json(shared))["error"].message, /shared by everyone/);
  const own = await patchSite({ domain: "kilnwork.vercel.app" });
  assert.equal(own.status, 200, await own.clone().text());
  assert.equal((await json(own))["domain"], "kilnwork.vercel.app");
  // Back, and the change is visible to the very next bootstrap — the cache is invalidated on edit.
  const back = await patchSite({ domain: "kilnwork.studio" });
  assert.equal(back.status, 200);
  assert.equal((await json(await config("https://staging.kilnwork.studio")))["writable"], true);
});

test("clearing the domain is allowed while an address remains, and refused when nothing would be left", { skip }, async () => {
  const cleared = await patchSite({ domain: null });
  assert.equal(cleared.status, 200, await cleared.clone().text());
  assert.equal((await json(cleared))["domain"], null);
  assert.equal((await json(await config("https://staging.kilnwork.studio")))["writable"], false, "no domain, no subdomains");
  // With no domain, the last address is the last way in.
  const empty = await patchSite({ origins: [] });
  assert.equal(empty.status, 400);
  assert.match((await json(empty))["error"].message, /domain or at least one address/);
  // With the domain back, the addresses may all go.
  assert.equal((await patchSite({ domain: "kilnwork.studio" })).status, 200);
  const none = await patchSite({ origins: [] });
  assert.equal(none.status, 200, await none.clone().text());
  assert.deepEqual((await json(none))["origins"], []);
});

test("the switch: paused refuses the widget everywhere — config, session exchange, a live session's writes — and active brings it back", { skip }, async () => {
  const off = await patchSite({ status: "paused" });
  assert.equal(off.status, 200, await off.clone().text());
  assert.equal((await json(off))["status"], "paused");

  const conf = await json(await config("https://staging.kilnwork.studio"));
  assert.equal(conf["status"], "paused");
  assert.equal(conf["writable"], false);
  assert.equal(conf["reason"], "project_paused");

  const exchange = await app.request(`${site()}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://kilnwork.studio" },
    body: JSON.stringify({ identity: { kind: "guest", name: "Ada", secret: "0123456789abcdef0123456789abcdef" } }),
  });
  assert.equal(exchange.status, 403);
  assert.equal((await json(exchange))["error"].code, "project_paused");

  // A session minted BEFORE the switch was thrown cannot write either.
  const create = await app.request(`${site()}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${guestBearer}` },
    body: JSON.stringify({
      id: randomUUID(),
      comment: { body: "the footer overlaps" },
      anchor: { label: "footer", css: "footer", page: { route: "/", origin: "https://kilnwork.studio", pathname: "/" }, offset: { x: 0.5, y: 0.9 } },
      context: { url: "https://kilnwork.studio/" },
    }),
  });
  assert.equal(create.status, 403, await create.clone().text());
  assert.equal((await json(create))["error"].code, "project_paused");

  // Reads go on: the owner still lists.
  const list = await app.request(`${site()}/threads`, { headers: asOwner() });
  assert.equal(list.status, 200);

  const bad = await patchSite({ status: "nonsense" });
  assert.equal(bad.status, 400);

  const on = await patchSite({ status: "active" });
  assert.equal((await json(on))["status"], "active");
  const again = await json(await config("https://staging.kilnwork.studio"));
  assert.equal(again["status"], "active");
  assert.equal(again["writable"], true);
  const [row] = await sql<{ paused_reason: string | null }[]>`SELECT paused_reason FROM projects WHERE id = ${projectId}`;
  assert.equal(row!.paused_reason, null);
});

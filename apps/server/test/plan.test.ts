import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { invalidateLimits, normaliseLimits } from "../src/plan.ts";
import { HTTP_HEADER } from "@snagset/types/names";
import { accept, invite, join } from "./join.ts";
import { createServer as createHttp, type Server as HttpServer } from "node:http";

/**
 * The plan seam — the mechanism. Two apps on one database:
 * `capped` carries a resolver the way the private caller will, `free` carries
 * none the way every self-host does. Skipped without `SNAGSET_TEST_DATABASE_URL`;
 * drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the plan tests";

let sql: postgres.Sql;
let capped: ReturnType<typeof createApp>;
let free: ReturnType<typeof createApp>;
let orgId: string;
let owner: { cookie: string; csrf: string };
let uid: string;
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
// A seat is taken by accepting an invite, so that is what is counted.
const addMember = (app: ReturnType<typeof createApp>, email: string) => join(app, as(owner), { email, name: email, role: "admin", password: PASSWORD });

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
    return { projects: 1, members: 2, screenshots: false, integrations: false, storageBytes: 1 };
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

test("normaliseLimits keeps the four keys in their shapes and drops the rest", () => {
  assert.deepEqual(normaliseLimits({ projects: 5, members: null, screenshots: true, integrations: "yes", extra: 1, storageBytes: 5_000_000_000 }), { projects: 5, members: null, screenshots: true, storageBytes: 5_000_000_000 });
  assert.deepEqual(normaliseLimits({ projects: -1, members: 2.5 }), {});
  assert.deepEqual(normaliseLimits("nope"), {});
});

test("no resolver, no row: unlimited, and /me says so with the counts", { skip }, async () => {
  const m = await me(free);
  assert.deepEqual(m.limits, { projects: { limit: null, used: 0 }, members: { limit: null, used: 1 }, storage: { limit: null, used: 0 }, screenshots: true, integrations: true, source: "default" });
  const made = await addSite(free, "Kilnwork");
  assert.equal(made.status, 201, await made.clone().text());
  uid = ((await made.json()) as { uid: string }).uid;
  assert.equal((await me(free)).limits.projects.used, 1);
});

test("the resolver's numbers bite: a second site and a third seat are 403 plan_limit_reached with the numbers", { skip }, async () => {
  invalidateLimits();
  const m = await me(capped);
  assert.deepEqual(m.limits, { projects: { limit: 1, used: 1 }, members: { limit: 2, used: 1 }, storage: { limit: 1, used: 0 }, screenshots: false, integrations: false, source: "resolver" });

  const second = await addSite(capped, "Second");
  assert.equal(second.status, 403, await second.clone().text());
  const body = (await second.json()) as any;
  assert.equal(body.error.code, "plan_limit_reached");
  assert.deepEqual(body.error.details, { resource: "projects", limit: 1, used: 1 });
  assert.match(body.error.message, /allows 1 sites and it has 1/);

  // An invite minted while there is room, and accepted once there is not.
  const spare = await invite(capped, as(owner), { email: "late@studio.test" });
  assert.equal(spare.status, 201, await spare.clone().text());
  const one = await addMember(capped, "a@studio.test");
  assert.equal(one.status, 201, await one.clone().text());
  // A full studio refuses the invite itself, rather than a link that cannot work.
  const two = await addMember(capped, "b@studio.test");
  assert.equal(two.status, 403);
  assert.deepEqual(((await two.json()) as any).error.details, { resource: "members", limit: 2, used: 2 });
  // And the accept counts again inside its own transaction — the check that holds.
  const late = await accept(capped, { token: ((await spare.json()) as any).token, password: PASSWORD });
  assert.equal(late.status, 403, await late.clone().text());
  assert.equal(((await late.json()) as any).error.code, "plan_limit_reached");
  assert.equal((await me(capped)).limits.members.used, 2);
});

test("the resolver's booleans bite: no integrations connect, and the widget's config offers no screenshots", { skip }, async () => {
  const connect_ = await capped.request(`/api/v1/projects/${uid}/integrations/github`, { method: "PUT", headers: as(owner), body: JSON.stringify({ owner: "x", repo: "y", token: "ghp_x" }) });
  assert.equal(connect_.status, 403, await connect_.clone().text());
  assert.equal(((await connect_.json()) as any).error.details.resource, "integrations");
  const cfg = (await (await capped.request(`/api/v1/projects/${uid}/config`, { headers: { Origin: "https://kilnwork.test" } })).json()) as any;
  assert.deepEqual(cfg.features, { screenshots: false, uploads: false });
});

test("the self-host's by-hand row: a stored limits row caps the same way, and forgetting it lifts the cap", { skip }, async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO instance_settings (org_id, key, value) VALUES (${orgId}::uuid, 'limits', ${tx.json({ projects: 1 })})`;
  });
  invalidateLimits();
  const m = await me(free);
  assert.equal(m.limits.source, "stored");
  assert.deepEqual(m.limits.projects, { limit: 1, used: 1 });
  assert.equal(m.limits.members.limit, null, "a key the row does not name stays unlimited");
  assert.equal((await addSite(free, "Third")).status, 403);

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`DELETE FROM instance_settings WHERE org_id = ${orgId}::uuid AND key = 'limits'`;
  });
  invalidateLimits();
  assert.equal((await addSite(free, "Third")).status, 201);
  assert.equal((await me(free)).limits.source, "default");
});

/** The instance suite's fake bucket, shrunk: PUT stores, GET reads, DELETE forgets — enough for the connect probe and one upload. */
function fakeBucket(): Promise<{ server: HttpServer; url: string }> {
  const objects = new Map<string, Buffer>();
  return new Promise((resolve) => {
    const server = createHttp((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const key = req.url ?? "/";
        if (req.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200).end();
        } else if (req.method === "GET") {
          const body = objects.get(key);
          if (!body) return void res.writeHead(404).end();
          res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
        } else if (req.method === "DELETE") {
          objects.delete(key);
          res.writeHead(204).end();
        } else res.writeHead(405).end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

test("the studio's picture storage: the plan's bytes bite in the upload route beside the per-project ceiling, and /me counts them", { skip }, async () => {
  const bucket = await fakeBucket();
  try {
    const connected = await free.request("/api/v1/instance/storage", { method: "PUT", headers: as(owner), body: JSON.stringify({ endpoint: bucket.url, bucket: "pics", accessKeyId: "k", secretAccessKey: "s" }) });
    assert.equal(connected.status, 200, await connected.clone().text());
    const exchange = await free.request(`/api/v1/projects/${uid}/sessions`, {
      method: "POST",
      headers: { ...json, Origin: "https://kilnwork.test" },
      body: JSON.stringify({ identity: { kind: "guest", name: "Carla", secret: "0123456789abcdef0123456789abcdef" } }),
    });
    assert.equal(exchange.status, 201, await exchange.clone().text());
    const bearer = ((await exchange.json()) as any).sessionToken as string;
    const upload = (app: ReturnType<typeof createApp>) =>
      app.request(`/api/v1/projects/${uid}/attachments`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, Origin: "https://kilnwork.test", "content-type": "image/png" }, body: new Uint8Array([137, 80, 78, 71]) });

    invalidateLimits();
    const refused = await upload(capped);
    assert.equal(refused.status, 413, await refused.clone().text());
    const body = (await refused.json()) as any;
    assert.equal(body.error.code, "storage_quota_exceeded");
    assert.match(body.error.message, /plan/);

    // Two apps, one org, one process: the cache that served `capped` its number would serve `free` the same one.
    invalidateLimits();
    const stored = await upload(free);
    assert.equal(stored.status, 201, await stored.clone().text());
    assert.equal((await me(free)).limits.storage.used, 4, "bucket bytes, summed over the studio's sites");
  } finally {
    bucket.server.close();
  }
});

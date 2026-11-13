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
import { runDueJobs } from "../src/jobs/index.ts";
import { collectDeletedAttachments } from "../src/jobs/reaper.ts";
import type { Bucket } from "../src/storage/bucket.ts";
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
    cfg: loadConfig({ SNAGSET_TRUST_PROXY: "1", DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET, SNAGSET_BASE_URL: "https://review.example.dev" }),
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

test("deleting a thread gives its picture's space back at once, and the reaper takes the file out of the bucket", { skip }, async () => {
  const bucket = await fakeBucket();
  try {
    const connected = await free.request("/api/v1/instance/storage", { method: "PUT", headers: as(owner), body: JSON.stringify({ endpoint: bucket.url, bucket: "pics", accessKeyId: "k", secretAccessKey: "s" }) });
    assert.equal(connected.status, 200, await connected.clone().text());
    const exchange = await free.request(`/api/v1/projects/${uid}/sessions`, {
      method: "POST",
      headers: { ...json, Origin: "https://kilnwork.test" },
      body: JSON.stringify({ identity: { kind: "guest", name: "Dana", secret: "fedcba9876543210fedcba9876543210" } }),
    });
    assert.equal(exchange.status, 201, await exchange.clone().text());
    const guest = { Authorization: `Bearer ${((await exchange.json()) as any).sessionToken as string}`, Origin: "https://kilnwork.test" };
    invalidateLimits();
    const before_ = (await me(free)).limits.storage.used as number;

    // The whole path a reviewer's screenshot takes: uploaded, then bound by the thread that names it.
    const picture = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7, 7]);
    const stored = await free.request(`/api/v1/projects/${uid}/attachments`, { method: "POST", headers: { ...guest, "content-type": "image/png" }, body: picture });
    assert.equal(stored.status, 201, await stored.clone().text());
    const att = ((await stored.json()) as { id: string }).id;
    const posted = await free.request(`/api/v1/projects/${uid}/threads`, {
      method: "POST",
      headers: { ...guest, ...json },
      body: JSON.stringify({
        comment: { body: "The hero image is cropped." },
        anchor: { offset: { x: 0.5, y: 0.5 }, page: { route: "/", pathname: "/", origin: "https://kilnwork.test" } },
        context: { url: "https://kilnwork.test/" },
        attachments: [att],
      }),
    });
    assert.equal(posted.status, 201, await posted.clone().text());
    const threadId = ((await posted.json()) as { id: string }).id;
    const rowOf = async () => (await sql<{ state: string; deleted_at: Date | null; bound_at: Date | null; storage_key: string }[]>`
      SELECT state, deleted_at, bound_at, storage_key FROM attachments WHERE id = ${att.replace(/^att_/, "")}`)[0]!;
    assert.equal((await rowOf()).state, "bound", "the thread took the picture");
    assert.equal((await me(free)).limits.storage.used, before_ + picture.length, "counted while it is there");

    const gone = await free.request(`/api/v1/projects/${uid}/threads/${threadId}`, { method: "DELETE", headers: as(owner) });
    assert.equal(gone.status, 204, await gone.clone().text());
    assert.equal((await me(free)).limits.storage.used, before_, "the room is back as soon as the thread is deleted");
    assert.ok((await rowOf()).deleted_at, "marked deleted");

    // The reaper's half: the file leaves the bucket, and a bucket that refuses leaves the row to be tried again.
    const asked: string[] = [];
    let refuse = true;
    const stub: Bucket = {
      put: async () => {},
      get: async () => null,
      del: async (k) => {
        asked.push(k);
        if (refuse) throw new Error("the bucket said no");
      },
      probe: async () => ({ ok: true }),
    };
    const at = new Date(Date.now() + 3_600_000);
    const first = await runDueJobs(sql, [collectDeletedAttachments(stub)], { force: true, budgetMs: 5000, now: () => at });
    assert.deepEqual(first.failed, []);
    assert.equal((await rowOf()).state, "bound", "refused by the bucket: still waiting, not written off");
    refuse = false;
    const second = await runDueJobs(sql, [collectDeletedAttachments(stub)], { force: true, budgetMs: 5000, now: () => new Date(at.getTime() + 3_600_000) });
    assert.deepEqual(second.failed, [], "the job itself did not fail");
    const after_ = await rowOf();
    assert.deepEqual(asked, [after_.storage_key, after_.storage_key], "the bucket is asked for exactly this file");
    assert.equal(after_.state, "orphaned");
    assert.equal(after_.bound_at, null);
    assert.equal((await me(free)).limits.storage.used, before_, "the reaper does not give the bytes back a second time");
    await runDueJobs(sql, [collectDeletedAttachments(stub)], { force: true, budgetMs: 5000, now: () => new Date(at.getTime() + 7_200_000) });
    assert.equal(asked.length, 2, "and it is not collected twice");
  } finally {
    bucket.server.close();
  }
});

test("a picture deleted the old way, still counted, is given back by the reaper when it collects it, once; a live one is left", { skip }, async () => {
  // The state only an older version could leave (deleted, never subtracted), so it is written here and not made through a route.
  const [p] = await sql<{ id: string; org_id: string }[]>`SELECT id, org_id FROM projects WHERE uid = ${uid}`;
  const [t] = await sql<{ id: string }[]>`SELECT id FROM threads WHERE project_id = ${p!.id} LIMIT 1`;
  const row = (key: string, bytes: number, deleted: boolean) => sql`
    INSERT INTO attachments (id, org_id, project_id, thread_id, kind, state, bound_at, storage_key, content_type, bytes, sha256, deleted_at)
    VALUES (${randomUUID()}, ${p!.org_id}, ${p!.id}, ${t!.id}, 'screenshot', 'bound', now(),
            ${key}, 'image/png', ${bytes}, ${Buffer.alloc(32, bytes % 251)}, ${deleted ? new Date() : null})`;
  await row("k/old-deleted", 1000, true);
  await row("k/live", 300, false);
  await sql`UPDATE projects SET storage_bytes_used = 1300 WHERE id = ${p!.id}`;

  const asked: string[] = [];
  const stub: Bucket = { put: async () => {}, get: async () => null, del: async (k) => void asked.push(k), probe: async () => ({ ok: true }) };
  const used = async () => Number((await sql<{ used: string }[]>`SELECT storage_bytes_used AS used FROM projects WHERE id = ${p!.id}`)[0]!.used);
  const at = Date.now() + 24 * 3_600_000;
  const first = await runDueJobs(sql, [collectDeletedAttachments(stub)], { force: true, budgetMs: 5000, now: () => new Date(at) });
  assert.deepEqual(first.failed, []);
  assert.deepEqual(asked, ["k/old-deleted"], "only the deleted one leaves the bucket");
  assert.equal(await used(), 300, "its bytes come off, and the live picture's stay");
  await runDueJobs(sql, [collectDeletedAttachments(stub)], { force: true, budgetMs: 5000, now: () => new Date(at + 3_600_000) });
  assert.equal(await used(), 300, "and not a second time");
  const [was] = await sql<{ state: string; released_at: Date | null }[]>`SELECT state, released_at FROM attachments WHERE storage_key = 'k/old-deleted'`;
  assert.equal(was!.state, "orphaned");
  assert.ok(was!.released_at, "marked as given back");
});

test("a deleted site keeps its pictures for thirty days, then they leave the bucket; its words stay, and a live site's pictures are never touched", { skip }, async () => {
  const bucket = await fakeBucket();
  try {
    const connected = await free.request("/api/v1/instance/storage", { method: "PUT", headers: as(owner), body: JSON.stringify({ endpoint: bucket.url, bucket: "pics", accessKeyId: "k", secretAccessKey: "s" }) });
    assert.equal(connected.status, 200, await connected.clone().text());
    invalidateLimits();

    // A site with one snag and its screenshot, made the way a reviewer makes one.
    const snag = async (name: string, bytes: number[]) => {
      const made = await addSite(free, name);
      assert.equal(made.status, 201, await made.clone().text());
      const site = ((await made.json()) as { uid: string }).uid;
      const origin = `https://${name.toLowerCase()}.test`;
      const exchange = await free.request(`/api/v1/projects/${site}/sessions`, {
        method: "POST",
        headers: { ...json, Origin: origin },
        body: JSON.stringify({ identity: { kind: "guest", name: "Eva", secret: randomUUID().replace(/-/g, "") } }),
      });
      assert.equal(exchange.status, 201, await exchange.clone().text());
      const guest = { Authorization: `Bearer ${((await exchange.json()) as any).sessionToken as string}`, Origin: origin };
      const stored = await free.request(`/api/v1/projects/${site}/attachments`, { method: "POST", headers: { ...guest, "content-type": "image/png" }, body: new Uint8Array(bytes) });
      assert.equal(stored.status, 201, await stored.clone().text());
      const att = ((await stored.json()) as { id: string }).id.replace(/^att_/, "");
      const posted = await free.request(`/api/v1/projects/${site}/threads`, {
        method: "POST",
        headers: { ...guest, ...json },
        body: JSON.stringify({
          comment: { body: `What ${name} was told.` },
          anchor: { offset: { x: 0.5, y: 0.5 }, page: { route: "/", pathname: "/", origin } },
          context: { url: `${origin}/` },
          attachments: [`att_${att}`],
        }),
      });
      assert.equal(posted.status, 201, await posted.clone().text());
      return { site, att };
    };
    const doomed = await snag("Doomed", [137, 80, 78, 71, 1, 1, 1, 1, 1]);
    const kept = await snag("Kept", [137, 80, 78, 71, 2, 2, 2, 2, 2, 2]);
    const rowOf = async (att: string) => (await sql<{ state: string; deleted_at: Date | null; storage_key: string }[]>`
      SELECT state, deleted_at, storage_key FROM attachments WHERE id = ${att}`)[0]!;

    const gone = await free.request(`/api/v1/projects/${doomed.site}`, { method: "DELETE", headers: as(owner) });
    assert.equal(gone.status, 204, await gone.clone().text());

    const asked: string[] = [];
    const stub: Bucket = { put: async () => {}, get: async () => null, del: async (k) => void asked.push(k), probe: async () => ({ ok: true }) };
    const day = 24 * 3_600_000;
    const sweep = async (daysOn: number) => {
      const r = await runDueJobs(sql, [collectDeletedAttachments(stub)], { force: true, budgetMs: 5000, now: () => new Date(Date.now() + daysOn * day) });
      assert.deepEqual(r.failed, []);
      assert.deepEqual(r.ran.map((j) => j.name), ["collect-deleted-attachments"], "the job ran, and was not skipped as not due");
    };
    await sweep(1);
    await sweep(29);
    assert.deepEqual(asked, [], "inside the thirty days nothing leaves the bucket");
    assert.equal((await rowOf(doomed.att)).state, "bound", "so a site restored in that time comes back whole");

    await sweep(31);
    const after_ = await rowOf(doomed.att);
    assert.deepEqual(asked, [after_.storage_key], "past them, the deleted site's picture and no other");
    assert.equal(after_.state, "orphaned");
    assert.ok(after_.deleted_at, "and the row says it is gone");
    assert.equal((await rowOf(kept.att)).state, "bound", "a live site's picture is not touched, however old");
    const [words] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM comments c JOIN projects p ON p.id = c.project_id WHERE p.uid = ${doomed.site} AND c.body IS NOT NULL`;
    assert.equal(words!.n, 1, "what the client wrote is still in the database");
    await sweep(40);
    assert.equal(asked.length, 1, "and it is taken out once");
  } finally {
    bucket.server.close();
  }
});

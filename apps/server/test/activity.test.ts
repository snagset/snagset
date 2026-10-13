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
 * Activity across every site. Skipped without
 * `SNAGSET_TEST_DATABASE_URL`; drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the activity tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let owner: { cookie: string; csrf: string };
let admin: { cookie: string; csrf: string };
let orgId: string;
const sites: { uid: string; id: string }[] = [];

const SECRET = Buffer.alloc(32, 13).toString("base64url");
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

let nth = 0;

/** A thread with one public comment, `updated_at` forced so ordering is exact. */
async function seed(
  siteIdx: number,
  key: string,
  opts: { status?: string; body?: string; minutesAgo: number; private?: boolean; teamOnly?: boolean } = { minutesAgo: 0 },
): Promise<string> {
  const site = sites[siteIdx]!;
  const id = randomUUID();
  // UNIQUE (round_id, round_number): a thread's position within its round.
  const position = ++nth;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    const [env] = await tx<{ id: string }[]>`SELECT id FROM environments WHERE project_id = ${site.id} AND is_default`;
    const [round] = await tx<{ id: string }[]>`SELECT id FROM rounds WHERE project_id = ${site.id}`;
    // By name, not LIMIT 1: materialises the studio's own people as
    // reviewer rows on project create, so the first row here is an owner.
    const [rev] = await tx<{ id: string }[]>`SELECT id FROM reviewers WHERE project_id = ${site.id} AND name = 'Ada the client'`;
    let reviewer = rev?.id;
    if (!reviewer) {
      reviewer = randomUUID();
      await tx`INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
               VALUES (${reviewer}, ${orgId}, ${site.id}, 'guest', 'Ada the client', ${Buffer.alloc(32, 4)})`;
    }
    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number, status, private,
                           anchor, context, created_by, comment_count, comment_count_public, resolved_at, updated_at)
      VALUES (${id}, ${orgId}, ${site.id}, ${key}, ${env!.id}, ${round!.id}, ${position}, ${opts.status ?? "open"}::snag_thread_status,
              ${opts.private ?? false},
              ${tx.json({ label: "the button", css: "button", page: { origin: "https://x.test", pathname: "/pricing", route: "/pricing" }, offset: {} })},
              ${tx.json({ ua: "x" })}, ${reviewer}, 1, ${opts.private ? 0 : 1},
              ${opts.status === "resolved" ? tx`now()` : tx`NULL`},
              now() - ${`${opts.minutesAgo} minutes`}::interval)`;
    await tx`
      INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body, private)
      VALUES (${randomUUID()}, ${orgId}, ${site.id}, ${id}, 1, ${reviewer}, ${opts.body ?? "the button is the wrong blue"}, ${opts.teamOnly ?? false})`;
  });
  return id;
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
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    for (const [email, role] of [["o@e.test", "owner"], ["a@e.test", "admin"]] as const) {
      const id = randomUUID();
      await tx`INSERT INTO users (id, org_id, email, name, password_hash) VALUES (${id}, ${orgId}, ${email}, ${email}, ${hashPassword(PASSWORD)})`;
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
  for (const name of ["Kilnwork", "Ardal"]) {
    const made = await app.request("/api/v1/projects", { method: "POST", headers: as(owner), body: JSON.stringify({ name, domain: `${name.toLowerCase()}.studio` }) });
    const text = await made.text();
    assert.equal(made.status, 201, text);
    const uid = (JSON.parse(text) as { uid: string }).uid;
    const [p] = await sql<{ id: string }[]>`SELECT id FROM projects WHERE uid = ${uid}`;
    sites.push({ uid, id: p!.id });
  }
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

test("every site's threads in one feed, newest change first, each naming its site; a stranger gets nothing", { skip }, async () => {
  await seed(0, "SN-1", { minutesAgo: 30, body: "the hero crops on tablets" });
  await seed(1, "SN-2", { minutesAgo: 10, body: "the price table wraps" });
  await seed(0, "SN-3", { minutesAgo: 20, status: "progress" });

  const res = await app.request("/api/v1/activity", { headers: as(owner) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await json(res);
  const rows = body["data"] as any[];
  assert.deepEqual(rows.map((r) => r.key), ["SN-2", "SN-3", "SN-1"], "newest change first");
  assert.deepEqual(rows.map((r) => r.site.name), ["Ardal", "Kilnwork", "Kilnwork"]);
  assert.equal(rows[0].latest.body, "the price table wraps");
  assert.equal(rows[0].route, "/pricing");
  assert.equal(rows[0].createdBy.name, "Ada the client");
  assert.equal(rows[1].status, "progress");
  assert.match(rows[0].id, /^thr_/);
  assert.equal(body["nextCursor"], null);

  // An admin reads it; nobody signed out does.
  assert.equal((await app.request("/api/v1/activity", { headers: as(admin) })).status, 200);
  assert.equal((await app.request("/api/v1/activity")).status, 401);
});

test("filtered by status and by site; resolved IS the archive", { skip }, async () => {
  await seed(0, "SN-4", { minutesAgo: 5, status: "resolved", body: "fixed last week" });

  const open = (await json(await app.request("/api/v1/activity?status=open", { headers: as(owner) })))["data"] as any[];
  assert.deepEqual(open.map((r) => r.key), ["SN-2", "SN-1"]);

  const archive = (await json(await app.request("/api/v1/activity?status=resolved", { headers: as(owner) })))["data"] as any[];
  assert.deepEqual(archive.map((r) => r.key), ["SN-4"]);

  // The desk: everything still in play, which is the screen's default view.
  const desk = (await json(await app.request("/api/v1/activity?status=unresolved", { headers: as(owner) })))["data"] as any[];
  assert.deepEqual(desk.map((r) => r.key), ["SN-2", "SN-3", "SN-1"]);

  const one = (await json(await app.request(`/api/v1/activity?site=${sites[1]!.uid}`, { headers: as(owner) })))["data"] as any[];
  assert.deepEqual(one.map((r) => r.key), ["SN-2"]);

  const bad = await app.request("/api/v1/activity?status=archived", { headers: as(owner) });
  assert.equal(bad.status, 400);
  assert.match((await json(bad))["error"].message, /status must be one of/);
});

test("a private thread and a team-only reply stay out of the feed", { skip }, async () => {
  await seed(0, "SN-5", { minutesAgo: 1, private: true, body: "internal only" });
  await seed(1, "SN-6", { minutesAgo: 2, teamOnly: true, body: "the client must not read this" });

  const rows = (await json(await app.request("/api/v1/activity", { headers: as(owner) })))["data"] as any[];
  assert.ok(!rows.some((r) => r.key === "SN-5"), "a private thread is absent");
  const six = rows.find((r) => r.key === "SN-6");
  assert.ok(six, "the thread itself is present");
  assert.equal(six.latest, null, "its team-only reply is not quoted");
});

test("?q= searches the key, the element and the words — the same three the site's own search does", { skip }, async () => {
  const hits = (await json(await app.request("/api/v1/activity?q=price%20table", { headers: as(owner) })))["data"] as any[];
  assert.deepEqual(hits.map((r) => r.key), ["SN-2"]);

  const byKey = (await json(await app.request("/api/v1/activity?q=SN-1", { headers: as(owner) })))["data"] as any[];
  assert.deepEqual(byKey.map((r) => r.key), ["SN-1"]);

  const byElement = (await json(await app.request("/api/v1/activity?q=the%20button", { headers: as(owner) })))["data"] as any[];
  assert.ok(byElement.length >= 3, "every seeded thread's anchor is labelled “the button”");

  // A team-only reply is not searchable from here either: it is not quoted,
  // so matching on it would leak the words through the result list.
  const teamOnly = (await json(await app.request("/api/v1/activity?q=must%20not%20read", { headers: as(owner) })))["data"] as any[];
  assert.deepEqual(teamOnly, []);

  const none = (await json(await app.request("/api/v1/activity?q=zzzznothing", { headers: as(owner) })))["data"] as any[];
  assert.deepEqual(none, []);
});

test("the cursor pages without repeating or skipping a row", { skip }, async () => {
  const first = await json(await app.request("/api/v1/activity?limit=2", { headers: as(owner) }));
  const firstKeys = (first["data"] as any[]).map((r) => r.key);
  assert.equal(firstKeys.length, 2);
  assert.ok(first["nextCursor"], "there is more");

  const second = await json(await app.request(`/api/v1/activity?limit=2&cursor=${encodeURIComponent(first["nextCursor"])}`, { headers: as(owner) }));
  const secondKeys = (second["data"] as any[]).map((r) => r.key);
  assert.equal(new Set([...firstKeys, ...secondKeys]).size, firstKeys.length + secondKeys.length, "no row is served twice");

  const all = (await json(await app.request("/api/v1/activity?limit=100", { headers: as(owner) })))["data"] as any[];
  assert.deepEqual([...firstKeys, ...secondKeys], all.slice(0, firstKeys.length + secondKeys.length).map((r) => r.key));

  const nonsense = await app.request("/api/v1/activity?cursor=nope", { headers: as(owner) });
  assert.equal(nonsense.status, 400);
});

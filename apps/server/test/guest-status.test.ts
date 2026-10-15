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
 * Whether a GUEST may change a comment's status is the site's setting,
 * and it is enforced live.
 *
 * Found by real users: designers commenting as guests moved comments to
 * Resolved, the widget showed it, and the next load showed them open again —
 * the session had no thread:resolve and the refusal was silent. Now the site
 * decides (on by default), the exchange and every refresh mint a guest's set
 * from the column, and the thread PATCH reads the column itself for a guest,
 * so a toggle applies to a token minted before it.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the guest status tests";
const SECRET = Buffer.alloc(32, 21).toString("base64url");
const ORIGIN = "https://guests.test";
const PASSWORD = "correct horse battery staple";
const uid = "prj_gggggggggggg";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let orgId: string;
let projectId: string;
let linkId: string;
let bobId: string;
type Login = { cookie: string; csrf: string };
let owner: Login;
let admin: Login;
let member: Login;

async function login(email: string): Promise<Login> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return {
    cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "),
    csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken,
  };
}

const as = (l: Login) => ({ Cookie: l.cookie, [HTTP_HEADER.csrf]: l.csrf, "content-type": "application/json" });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, "content-type": "application/json", Origin: ORIGIN });

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
  linkId = randomUUID();
  bobId = randomUUID();
  const ownerId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    for (const [email, role, id] of [
      ["o@g.test", "owner", ownerId],
      ["a@g.test", "admin", randomUUID()],
      ["m@g.test", "member", randomUUID()],
    ] as const) {
      await tx`INSERT INTO users (id, org_id, email, password_hash) VALUES (${id}, ${orgId}, ${email}, ${hashPassword(PASSWORD)})`;
      await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${id}, ${role})`;
    }
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag)
      VALUES (${projectId}, ${orgId}, ${uid}, 'Kilnwork', ${Buffer.alloc(32, 1)}, 'etag')`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    await tx`INSERT INTO project_origins (id, org_id, project_id, pattern) VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${ORIGIN})`;
    await tx`
      INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, 1, 'Round 1', ${ownerId})`;
    // A client link that may comment but not change status — its grant must
    // not follow the site's guest setting either way.
    await tx`
      INSERT INTO review_links (id, org_id, project_id, token_hash, name, expires_at, permissions)
      VALUES (${linkId}, ${orgId}, ${projectId}, ${Buffer.alloc(32, 5)}, 'Comment only',
              now() + interval '7 days', '{thread:create,comment:create}')`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, review_link_id, holder_secret_hash)
      VALUES (${bobId}, ${orgId}, ${projectId}, 'link', 'Bob', ${linkId}, ${Buffer.alloc(32, 3)})`;
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
  });
  owner = await login("o@g.test");
  admin = await login("a@g.test");
  member = await login("m@g.test");
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

/** A guest exchange through the real route: the token and the permissions it was minted with. */
async function guest(name: string): Promise<{ token: string; permissions: string[] }> {
  const res = await app.request(`/api/v1/projects/${uid}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ identity: { kind: "guest", name } }),
  });
  const b = (await res.json()) as { sessionToken: string; permissions: string[] };
  assert.equal(res.status, 201, JSON.stringify(b));
  return { token: b.sessionToken, permissions: b.permissions };
}

async function refresh(token: string): Promise<{ token: string; permissions: string[] }> {
  const res = await app.request(`/api/v1/projects/${uid}/sessions`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({}),
  });
  const b = (await res.json()) as { sessionToken: string; permissions: string[] };
  assert.equal(res.status, 200, JSON.stringify(b));
  return { token: b.sessionToken, permissions: b.permissions };
}

async function thread(token: string): Promise<string> {
  const res = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({
      comment: { body: "The hero image is cropped." },
      anchor: { offset: { x: 0.5, y: 0.5 }, page: { route: "/", pathname: "/", origin: ORIGIN } },
      context: { url: `${ORIGIN}/` },
    }),
  });
  const b = (await res.json()) as { id: string };
  assert.equal(res.status, 201, JSON.stringify(b));
  return b.id;
}

const setStatus = (token: string, id: string, status: string) =>
  app.request(`/api/v1/projects/${uid}/threads/${id}`, {
    method: "PATCH",
    headers: bearer(token),
    body: JSON.stringify({ status }),
  });

const setting = (who: Login, on: unknown) =>
  app.request(`/api/v1/projects/${uid}`, {
    method: "PATCH",
    headers: as(who),
    body: JSON.stringify({ guestsCanChangeStatus: on }),
  });

const column = async () =>
  (await sql<{ g: boolean }[]>`SELECT guest_can_resolve AS g FROM projects WHERE id = ${projectId}::uuid`)[0]!.g;

test("a site lets guests change status by default, and a guest can", { skip }, async () => {
  assert.equal(await column(), true, "the migration's default");
  const me = await app.request("/api/v1/me", { headers: as(owner) });
  const site = ((await me.json()) as { projects: { uid: string; guestsCanChangeStatus: boolean }[] }).projects[0]!;
  assert.equal(site.guestsCanChangeStatus, true, "the dashboard reads it");

  const ada = await guest("Ada");
  assert.ok(ada.permissions.includes("thread:resolve"));
  const id = await thread(ada.token);
  const res = await setStatus(ada.token, id, "resolved");
  assert.equal(res.status, 200, await res.text());
});

test("only an owner or an admin changes the setting; bad values are refused", { skip }, async () => {
  assert.equal((await setting(member, false)).status, 403);
  assert.equal(await column(), true, "a member's attempt changed nothing");
  assert.equal((await setting(owner, "no")).status, 400);
  const off = await setting(admin, false);
  assert.equal(off.status, 200);
  assert.equal(((await off.json()) as { guestsCanChangeStatus: boolean }).guestsCanChangeStatus, false);
  assert.equal(await column(), false);
  const on = await setting(owner, true);
  assert.equal(on.status, 200);
  assert.equal(await column(), true);
});

test("turned off, a guest is refused — new sessions and ones minted before the switch", { skip }, async () => {
  const early = await guest("Early");
  assert.ok(early.permissions.includes("thread:resolve"), "minted while it was on");
  const id = await thread(early.token);

  assert.equal((await setting(owner, false)).status, 200);
  const stale = await setStatus(early.token, id, "progress");
  assert.equal(stale.status, 403, "the old token's perm does not outlive the setting");
  assert.equal(((await stale.json()) as { error: { code: string } }).error.code, "forbidden");

  const late = await guest("Late");
  assert.ok(!late.permissions.includes("thread:resolve"), "a new guest is minted without it");
  assert.equal((await setStatus(late.token, id, "progress")).status, 403);

  // …and the studio is unaffected.
  const studio = await app.request(`/api/v1/projects/${uid}/threads/${id}`, {
    method: "PATCH",
    headers: as(owner),
    body: JSON.stringify({ status: "review" }),
  });
  assert.equal(studio.status, 200);
});

test("turned on again, a token minted while it was off works at once, and a refresh re-mints the set", { skip }, async () => {
  assert.equal((await setting(owner, false)).status, 200);
  const g = await guest("Grace");
  assert.ok(!g.permissions.includes("thread:resolve"));
  const id = await thread(g.token);

  assert.equal((await setting(owner, true)).status, 200);
  assert.equal((await setStatus(g.token, id, "resolved")).status, 200, "the live setting, not the token");

  const r = await refresh(g.token);
  assert.ok(r.permissions.includes("thread:resolve"), "the refresh says so, for the widget");

  assert.equal((await setting(owner, false)).status, 200);
  const r2 = await refresh(r.token);
  assert.ok(!r2.permissions.includes("thread:resolve"), "and takes it away again");
  assert.equal((await setStatus(r2.token, id, "open")).status, 403);
  assert.equal((await setting(owner, true)).status, 200);
});

test("a link session keeps its link's grant whatever the guest setting says", { skip }, async () => {
  const bob = (
    await mintSession(
      createKeyring(SECRET),
      {
        projectUid: uid,
        reviewerId: bobId,
        environmentKey: "production",
        kind: "link",
        reviewLinkId: linkId,
        permissions: ["thread:create", "comment:create"],
        sessionEpoch: 1,
      },
      { slidingS: 900, absoluteS: 43_200 },
    )
  ).token;
  const id = await thread(bob);
  assert.equal(await column(), true);
  assert.equal((await setStatus(bob, id, "resolved")).status, 403, "the link does not grant it");
  const r = await refresh(bob);
  assert.ok(!r.permissions.includes("thread:resolve"), "a refresh does not borrow the guest setting");
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { DASHBOARD_SESSION_COOKIE, DASHBOARD_CSRF_COOKIE, HTTP_HEADER } from "@snagset/types/names";

/**
 * A studio member signs in from the widget, end to end against a real
 * Postgres. `POST /api/v1/projects/{uid}/sessions/member` is the one route
 * that turns a DASHBOARD cookie into a WIDGET session, so the refusals carry
 * as much weight as the success: no cookie, no CSRF half, another studio's
 * site, a viewer, and above all an origin that is not the site's — the
 * dashboard posts the token to that origin, so a wrong one is a session
 * handed to a page nobody allowed.
 *
 * The success is checked where it matters: the session's `sub` is the
 * member's STUDIO row (the one a dashboard reply is written under), it can
 * post, it refreshes, and it stops refreshing the moment the membership goes.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL`; drops the schema, and hands it
 * back empty for setup.test.ts's guard (reviewlink.test.ts says why).
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the member sign-in tests";
const SECRET = Buffer.alloc(32, 17).toString("base64url");
const PASSWORD = "correct horse battery staple";
const SITE = "https://client.test";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let orgId: string;
let projectId: string;
let ownerId: string;
let adminId: string;
type Auth = { cookie: string; csrf: string };
let owner: Auth;
let admin: Auth;
let viewer: Auth;
let stranger: Auth;

async function login(email: string): Promise<Auth> {
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
  assert.ok(cookie.includes(DASHBOARD_SESSION_COOKIE) && cookie.includes(DASHBOARD_CSRF_COOKIE));
  return { cookie, csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken };
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
  ownerId = randomUUID();
  adminId = randomUUID();
  const viewerId = randomUUID();
  uid = "prj_m3mb3rs1gn1n";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    for (const [id, email, name, role] of [
      [ownerId, "o@e.test", "Olga Owner", "owner"],
      [adminId, "a@e.test", "Ana Admin", "admin"],
      [viewerId, "v@e.test", "Vic Viewer", "viewer"],
    ] as const) {
      await tx`
        INSERT INTO users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${orgId}, ${email}, ${name}, ${hashPassword(PASSWORD)})`;
      await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${id}, ${role})`;
    }
    // A domain AND exact origins, one of them a wildcard — the three ways an
    // origin is the site's (cors.ts `originPermitted`).
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag, settings)
      VALUES (${projectId}, ${orgId}, ${uid}, 'Acme',${Buffer.alloc(32, 1)}, 'etag',
              ${sql.json({ domain: "acme.test" })})`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    await tx`
      INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
      VALUES (${randomUUID()}, ${orgId}, ${projectId}, 1, 'Round 1', ${ownerId})`;
    await tx`INSERT INTO project_origins (id, org_id, project_id, pattern, is_wildcard)
             VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${SITE}, false)`;
    await tx`INSERT INTO project_origins (id, org_id, project_id, pattern, is_wildcard)
             VALUES (${randomUUID()}, ${orgId}, ${projectId}, 'https://*.preview.test', true)`;
    // An allow-listed address on a shared hosting suffix, for the
    // silent route's "a shared suffix is not one site" refusal.
    await tx`INSERT INTO project_origins (id, org_id, project_id, pattern, is_wildcard)
             VALUES (${randomUUID()}, ${orgId}, ${projectId}, 'https://acme.vercel.app', false)`;
  });

  const otherOrg = randomUUID();
  const otherUser = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${otherOrg}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${otherOrg}, 'Other', 'other')`;
    await tx`
      INSERT INTO users (id, org_id, email, password_hash)
      VALUES (${otherUser}, ${otherOrg}, 's@e.test', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${otherOrg}, ${otherUser}, 'owner')`;
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
  viewer = await login("v@e.test");
  stranger = await login("s@e.test");
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>;

const signIn = (body: Record<string, unknown>, as?: Auth | { cookie: string }) =>
  app.request(`/api/v1/projects/${uid}/sessions/member`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(as ? { Cookie: as.cookie } : {}),
      ...(as && "csrf" in as ? { [HTTP_HEADER.csrf]: as.csrf } : {}),
    },
    body: JSON.stringify(body),
  });

const refresh = (bearer: string) =>
  app.request(`/api/v1/projects/${uid}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${bearer}`, Origin: SITE },
    body: JSON.stringify({}),
  });

test("no dashboard cookie, no session", { skip }, async () => {
  const res = await signIn({ origin: SITE });
  assert.equal(res.status, 401);
});

test("the cookie WITHOUT the CSRF half is refused — a page cannot mint with a member's cookie", { skip }, async () => {
  const res = await signIn({ origin: SITE }, { cookie: owner.cookie });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error.code, "csrf_failed");
});

test("another studio's site is a 404, not a 403", { skip }, async () => {
  const res = await signIn({ origin: SITE }, stranger);
  assert.equal(res.status, 404);
  assert.equal((await json(res)).error.code, "project_not_found");
});

test("a viewer cannot sign in to comment", { skip }, async () => {
  const res = await signIn({ origin: SITE }, viewer);
  assert.equal(res.status, 403);
});

test("an origin that is not the site's is REFUSED — no token is ever made for it", { skip }, async () => {
  for (const origin of ["https://evil.test", "https://notacme.test", "https://a.b.preview.test", "http://client.test"]) {
    const res = await signIn({ origin }, owner);
    assert.equal(res.status, 403, origin);
    const b = await json(res);
    assert.equal(b.error.code, "origin_not_allowed", origin);
    assert.equal(b.sessionToken, undefined);
  }
});

test("…and anything that is not exactly an origin is a 400, never normalised into one", { skip }, async () => {
  for (const origin of [`${SITE}/`, `${SITE}/page`, "https://client.test@evil.test", "javascript:alert(1)", "", 42, undefined]) {
    const res = await signIn({ origin }, owner);
    assert.equal(res.status, 400, String(origin));
  }
});

test("the allow-list's wildcard, the site's domain and localhost all count, as CORS counts them", { skip }, async () => {
  for (const origin of ["https://pr-12.preview.test", "https://www.acme.test", "http://staging.acme.test:3000", "http://localhost:5173"]) {
    const res = await signIn({ origin }, owner);
    assert.equal(res.status, 201, `${origin}: ${await res.clone().text()}`);
  }
});

let token: string;
let reviewerId: string;

test("a member's session: kind verified, the studio row as sub, the exchange's shape", { skip }, async () => {
  const res = await signIn({ origin: SITE }, owner);
  assert.equal(res.status, 201, await res.clone().text());
  const b = await json(res);
  assert.equal(b.origin, SITE, "the origin the dashboard will post to, echoed from the check");
  assert.equal(b.reviewer.kind, "verified");
  assert.equal(b.reviewer.name, "Olga Owner");
  assert.match(b.reviewer.id, /^rev_/);
  assert.equal(b.environment.key, "production");
  assert.ok(b.permissions.includes("thread:create") && b.permissions.includes("thread:private"));
  assert.equal(b.holderSecret, undefined, "a member has no holder secret — the account is the identity");
  // Twelve hours, the absolute cap every session gets.
  const hours = (Date.parse(b.refreshableUntil) - Date.now()) / 3_600_000;
  assert.ok(hours > 11.9 && hours <= 12, `refreshable for the absolute cap, got ${hours}`);

  token = b.sessionToken;
  reviewerId = (b.reviewer.id as string).slice(4);
  const [row] = await sql<{ kind: string; user_id: string | null }[]>`
    SELECT kind, user_id FROM reviewers WHERE id = ${reviewerId}::uuid`;
  assert.deepEqual({ ...row }, { kind: "verified", user_id: ownerId }, "the studio row, the one dashboard replies use");

  // Signing in again is the same person, not a second row.
  const again = await json(await signIn({ origin: SITE }, owner));
  assert.equal(again.reviewer.id, b.reviewer.id);
});

test("the session posts — and the comment's author is the member", { skip }, async () => {
  const made = await app.request(`/api/v1/projects/${uid}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, Origin: SITE },
    body: JSON.stringify({
      id: randomUUID(),
      comment: { body: "the hero image is cropped" },
      anchor: { label: "hero", css: "main img", page: { route: "/", origin: SITE, pathname: "/" }, offset: { x: 0.5, y: 0.5 } },
      context: { url: `${SITE}/`, viewport: { w: 1280, h: 800, dpr: 2 } },
    }),
  });
  assert.equal(made.status, 201, await made.clone().text());
  const thread = await json(made);
  assert.equal(thread.createdBy.id, `rev_${reviewerId}`);
  assert.equal(thread.createdBy.name, "Olga Owner");

  // A dashboard reply from the same person lands under the SAME author.
  const reply = await app.request(`/api/v1/threads/${thread.id}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf },
    body: JSON.stringify({ id: randomUUID(), body: "fixed in the next deploy" }),
  });
  assert.equal(reply.status, 201, await reply.clone().text());
  assert.equal((await json(reply)).author.id, `rev_${reviewerId}`);
});

test("it refreshes like any session", { skip }, async () => {
  const res = await refresh(token);
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok((await json(res)).sessionToken);
});

test("an owner signed in from the widget deletes a client's comment and snag, but cannot rewrite it", { skip }, async () => {
  // A client's snag with two comments, written straight into the tables.
  const guest = randomUUID();
  const thread = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  const [t] = await sql<{ environment_id: string; round_id: string; n: number }[]>`
    SELECT environment_id, round_id, (SELECT max(round_number) + 1 FROM threads)::int AS n
      FROM threads WHERE project_id = ${projectId}::uuid LIMIT 1`;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${guest}, ${orgId}, ${projectId}, 'guest', 'Cleo Client', ${Buffer.alloc(32, 5)})`;
    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                           anchor, context, created_by, comment_count, comment_count_public)
      VALUES (${thread}, ${orgId}, ${projectId}, 'SN-90', ${t!.environment_id}, ${t!.round_id}, ${t!.n},
              ${tx.json({ label: "h1", page: { origin: SITE, pathname: "/", route: "/" }, offset: {} })},
              ${tx.json({ url: `${SITE}/` })}, ${guest}, 2, 2)`;
    for (const [id, seq, body] of [[first, 1, "Logo is blurry"], [second, 2, "and the footer"]] as const) {
      await tx`
        INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
        VALUES (${id}, ${orgId}, ${projectId}, ${thread}, ${seq}, ${guest}, ${body})`;
    }
  });
  const bearer = { Authorization: `Bearer ${token}`, Origin: SITE, "content-type": "application/json" };

  // Rewrite somebody else's words: never, admin or not.
  const edit = await app.request(`/api/v1/projects/${uid}/comments/cmt_${second}`, {
    method: "PATCH",
    headers: bearer,
    body: JSON.stringify({ body: "something else" }),
  });
  assert.equal(edit.status, 403, await edit.clone().text());

  // Remove them: yes — one comment, then the whole snag.
  const del = await app.request(`/api/v1/projects/${uid}/comments/cmt_${second}`, { method: "DELETE", headers: bearer });
  assert.equal(del.status, 200, await del.clone().text());
  const gone = await app.request(`/api/v1/projects/${uid}/threads/thr_${thread}`, { method: "DELETE", headers: bearer });
  assert.equal(gone.status, 204, await gone.clone().text());
});

test("made a viewer, the next refresh is refused", { skip }, async () => {
  const b = await json(await signIn({ origin: SITE }, admin));
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`UPDATE memberships SET role = 'viewer' WHERE org_id = ${orgId} AND user_id = ${adminId}`;
  });
  const res = await refresh(b.sessionToken);
  assert.equal(res.status, 401);
  assert.equal((await json(res)).error.code, "session_revoked");
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`UPDATE memberships SET role = 'admin' WHERE org_id = ${orgId} AND user_id = ${adminId}`;
  });
});

test("removed from the studio, the session refreshes no more and its row is signed out", { skip }, async () => {
  const b = await json(await signIn({ origin: SITE }, await login("a@e.test")));
  assert.equal((await refresh(b.sessionToken)).status, 200, "works while they are a member");

  const gone = await app.request(`/api/v1/members/${encodeURIComponent("a@e.test")}`, {
    method: "DELETE",
    headers: { Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf },
  });
  assert.equal(gone.status, 200, await gone.clone().text());

  const res = await refresh(b.sessionToken);
  assert.equal(res.status, 401);
  assert.equal((await json(res)).error.code, "session_revoked");
  // And the per-request check (reviewerCache) has something to read, so a
  // write is refused within its ten seconds rather than at the next refresh.
  const [row] = await sql<{ identity_valid_after: Date | null }[]>`
    SELECT identity_valid_after FROM reviewers WHERE user_id = ${adminId}::uuid AND project_id = ${projectId}::uuid`;
  assert.ok(row?.identity_valid_after instanceof Date);
});


/**
 * The SILENT member sign-in, for a client page on the dashboard's own
 * site (`acme.acme.test` beside `snagset.acme.test`). No CSRF half: the
 * widget cannot read it. So the refusals below are the protection, and each
 * is one of the three checks the route names: Fetch Metadata, a permitted
 * origin that is the same SITE as the server, a member who is not a viewer.
 */
const silent = (
  serverHost: string,
  headers: { origin?: string; site?: string; as?: { cookie: string } },
  body?: string,
) =>
  app.request(`https://${serverHost}/api/v1/projects/${uid}/sessions/member/silent`, {
    method: "POST",
    headers: {
      ...(headers.origin ? { Origin: headers.origin } : {}),
      ...(headers.site ? { "Sec-Fetch-Site": headers.site } : {}),
      ...(headers.as ? { Cookie: headers.as.cookie } : {}),
      ...(body !== undefined ? { "content-type": "text/plain;charset=UTF-8" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });

const SAME_SITE_PAGE = "https://staging.acme.test"; // the site's DOMAIN, so permitted
const OUR_HOST = "snagset.acme.test";

test("silent: the cookie, same-site Fetch Metadata and a same-site permitted origin mint a member session — no CSRF half", { skip }, async () => {
  const res = await silent(OUR_HOST, { origin: SAME_SITE_PAGE, site: "same-site", as: { cookie: owner.cookie } });
  assert.equal(res.status, 201, await res.clone().text());
  const b = await json(res);
  assert.equal(b.reviewer.kind, "verified");
  assert.equal(b.reviewer.name, "Olga Owner");
  assert.equal(b.origin, SAME_SITE_PAGE);
  assert.equal(b.moderator, true);
  assert.ok(b.permissions.includes("thread:private"));
  assert.ok(Date.parse(b.refreshableUntil) > Date.now() + 11.9 * 3_600_000);
  // The popup's route and this one are the same person: one studio row.
  const popup = await json(await signIn({ origin: SITE }, owner));
  assert.equal(b.reviewer.id, popup.reviewer.id);
  // …and it posts and refreshes like any session.
  assert.equal((await refresh(b.sessionToken)).status, 200);

  // CORS: the exact origin, WITH credentials, on this route — so the page
  // can read the body of a credentialed fetch.
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SAME_SITE_PAGE);
  assert.equal(res.headers.get("Access-Control-Allow-Credentials"), "true");

  // An optional text/plain body names the environment; an unknown one is a 400.
  const env = await silent(OUR_HOST, { origin: SAME_SITE_PAGE, site: "same-site", as: { cookie: owner.cookie } }, JSON.stringify({ environment: "production" }));
  assert.equal(env.status, 201);
  const bad = await silent(OUR_HOST, { origin: SAME_SITE_PAGE, site: "same-site", as: { cookie: owner.cookie } }, JSON.stringify({ environment: "nope" }));
  assert.equal(bad.status, 400);
  // Garbage in the body is ignored rather than an error: the default environment.
  assert.equal((await silent(OUR_HOST, { origin: SAME_SITE_PAGE, site: "same-site", as: { cookie: owner.cookie } }, "{nope")).status, 201);
});

test("silent: the preflight answers with credentials for this route only", { skip }, async () => {
  const pre = await app.request(`https://${OUR_HOST}/api/v1/projects/${uid}/sessions/member/silent`, {
    method: "OPTIONS",
    headers: { Origin: SAME_SITE_PAGE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Origin"), SAME_SITE_PAGE);
  assert.equal(pre.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.match(pre.headers.get("Access-Control-Allow-Headers") ?? "", /content-type/);

  // Every bearer route stays "Credentials: never".
  for (const path of ["/sessions", "/threads", "/config", "/sessions/member"]) {
    const r = await app.request(`https://${OUR_HOST}/api/v1/projects/${uid}${path}`, {
      method: "OPTIONS",
      headers: { Origin: SAME_SITE_PAGE, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), SAME_SITE_PAGE, path);
    assert.equal(r.headers.get("Access-Control-Allow-Credentials"), null, path);
  }
  const ex = await app.request(`https://${OUR_HOST}/api/v1/projects/${uid}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: SAME_SITE_PAGE },
    body: JSON.stringify({ identity: { kind: "guest", name: "Cleo", holderId: "hld_" + "a".repeat(32) } }),
  });
  assert.equal(ex.headers.get("Access-Control-Allow-Credentials"), null);
});

test("silent: Sec-Fetch-Site cross-site, none or MISSING is refused — an old browser uses the popup", { skip }, async () => {
  for (const site of ["cross-site", "none", undefined]) {
    const res = await silent(OUR_HOST, { origin: SAME_SITE_PAGE, ...(site ? { site } : {}), as: { cookie: owner.cookie } });
    assert.equal(res.status, 403, String(site));
    assert.equal((await json(res)).sessionToken, undefined);
  }
});

test("silent: an allowed origin on ANOTHER site is refused, whatever Fetch Metadata claims", { skip }, async () => {
  // client.test is on the allow-list; the server is snagset.example.test.
  const res = await silent("snagset.example.test", { origin: SITE, site: "same-site", as: { cookie: owner.cookie } });
  assert.equal(res.status, 403);
  // No origin at all, and a not-quite-origin, likewise.
  assert.equal((await silent(OUR_HOST, { site: "same-site", as: { cookie: owner.cookie } })).status, 403);
  assert.equal((await silent(OUR_HOST, { origin: `${SAME_SITE_PAGE}/`, site: "same-site", as: { cookie: owner.cookie } })).status, 403);
});

test("silent: a shared hosting suffix is not one site — two *.vercel.app apps are strangers", { skip }, async () => {
  // https://acme.vercel.app IS on the allow-list; the server on snagset.vercel.app shares only the suffix.
  const res = await silent("snagset.vercel.app", { origin: "https://acme.vercel.app", site: "same-site", as: { cookie: owner.cookie } });
  assert.equal(res.status, 403);
});

test("silent: same site but NOT the site's address is origin_not_allowed", { skip }, async () => {
  const res = await silent("snagset.client.test", { origin: "https://other.client.test", site: "same-site", as: { cookie: owner.cookie } });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error.code, "origin_not_allowed");
});

test("silent: localhost only against a server on localhost", { skip }, async () => {
  const ok = await silent("localhost:8099", { origin: "http://localhost:5173", site: "same-site", as: { cookie: owner.cookie } });
  assert.equal(ok.status, 201, await ok.clone().text());
  const no = await silent(OUR_HOST, { origin: "http://localhost:5173", site: "same-site", as: { cookie: owner.cookie } });
  assert.equal(no.status, 403);
});

test("silent: no cookie is a 401; a viewer a 403; another studio's member a 404", { skip }, async () => {
  const none = await silent(OUR_HOST, { origin: SAME_SITE_PAGE, site: "same-site" });
  assert.equal(none.status, 401);
  assert.equal((await json(none)).error.code, "unauthorized");
  const v = await silent(OUR_HOST, { origin: SAME_SITE_PAGE, site: "same-site", as: { cookie: viewer.cookie } });
  assert.equal(v.status, 403);
  const s = await silent(OUR_HOST, { origin: SAME_SITE_PAGE, site: "same-site", as: { cookie: stranger.cookie } });
  assert.equal(s.status, 404);
});

test("the popup route still wants the CSRF pair, even with same-site Fetch Metadata", { skip }, async () => {
  const res = await app.request(`https://${OUR_HOST}/api/v1/projects/${uid}/sessions/member`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: owner.cookie, Origin: SAME_SITE_PAGE, "Sec-Fetch-Site": "same-site" },
    body: JSON.stringify({ origin: SAME_SITE_PAGE }),
  });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error.code, "csrf_failed");
});

test("silent sessions stay at twelve hours when the instance allows thirty days; the popup's get thirty", { skip }, async () => {
  const thirty = createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET, SNAGSET_SESSION_ABSOLUTE_TTL_S: "2592000" }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
  });
  const hoursLeft = (b: Record<string, any>) => (Date.parse(b.refreshableUntil) - Date.now()) / 3_600_000;

  const quiet = await thirty.request(`https://${OUR_HOST}/api/v1/projects/${uid}/sessions/member/silent`, {
    method: "POST",
    headers: { Origin: SAME_SITE_PAGE, "Sec-Fetch-Site": "same-site", Cookie: owner.cookie },
  });
  assert.equal(quiet.status, 201, await quiet.clone().text());
  const q = hoursLeft(await json(quiet));
  assert.ok(q > 11.9 && q <= 12, `silent: twelve hours, got ${q}`);

  const clicked = await thirty.request(`/api/v1/projects/${uid}/sessions/member`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf },
    body: JSON.stringify({ origin: SITE }),
  });
  assert.equal(clicked.status, 201, await clicked.clone().text());
  const p = hoursLeft(await json(clicked));
  assert.ok(p > 719 && p <= 720, `popup: thirty days, got ${p}`);
});

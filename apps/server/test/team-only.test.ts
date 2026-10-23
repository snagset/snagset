import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { createProject } from "../src/projects.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * A studio member signed in from the widget sees team-only content,
 * as docs/identity.md promised and 05 section 6.4a's `canSeePrivate` always
 * said. The code decided on the dashboard cookie alone, so a member's widget
 * session (minted WITH `thread:private`, sessions.ts) was handed the client's
 * view.
 *
 * Four readers, one fixture: a public thread with a public and a team-only
 * reply, and a thread the studio made private.
 *
 *   · the MEMBER, through the real `sessions/member` route the popup uses;
 *   · a TEAM link, a review link whose stored permissions carry
 *     `thread:private` — it sees what the member sees, by the permission's
 *     meaning;
 *   · a CLIENT link — the default grant. Its responses must be exactly what
 *     they were: no private thread, no private reply, no `private` key, the
 *     public count, and no new header;
 *   · the poll (`since`), where a thread turning private must still be a
 *     tombstone for the client and a row for the member.
 *
 * Asserted on the RAW bytes where it is about absence (the rule): the
 * point is that the content was never sent, not that a parser skipped it.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL`; drops the schema, and hands
 * it back empty for setup.test.ts's guard.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the team-only tests";
const SECRET = Buffer.alloc(32, 23).toString("base64url");
const PASSWORD = "correct horse battery staple";
const SITE = "https://team.test";
const SECRET_REPLY = "internal: the client asked for this twice";
const SECRET_THREAD = "internal thread: budget is gone";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let uid: string;
let owner: { cookie: string; csrf: string };
let member: string;
let team: string;
let client: string;
let publicThread: string;
let privateThread: string;

const json = (r: Response) => r.json() as Promise<Record<string, any>>;
const bearer = (token: string) => ({ "content-type": "application/json", Origin: SITE, Authorization: `Bearer ${token}` });

async function redeemLink(permissions?: string[]): Promise<string> {
  const minted = await app.request(`/api/v1/projects/${uid}/review-links`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf },
    body: JSON.stringify({ name: permissions ? "Team" : "Client", ...(permissions ? { permissions } : {}) }),
  });
  const link = await json(minted);
  assert.equal(minted.status, 201, JSON.stringify(link));
  const res = await app.request(`/api/v1/projects/${uid}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: SITE },
    body: JSON.stringify({
      environment: "production",
      identity: { kind: "link", token: link.token, name: "Reader" },
      client: { widget: "test", schema: "snagset.v1" },
    }),
  });
  const b = await json(res);
  assert.equal(res.status, 201, JSON.stringify(b));
  assert.equal(b.permissions.includes("thread:private"), !!permissions?.includes("thread:private"));
  return b.sessionToken as string;
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

  const orgId = randomUUID();
  const userId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, name, password_hash)
      VALUES (${userId}, ${orgId}, 'o@e.test', 'Olga Owner', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    const p = await createProject(tx, { orgId, name: "Team", createdBy: userId, origins: [SITE], graceHours: 24 });
    uid = p.uid;
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

  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "o@e.test", password: PASSWORD }),
  });
  const text = await login.text();
  assert.equal(login.status, 200, text);
  owner = {
    cookie: login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "),
    csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken,
  };

  // The member's widget session, through the route the sign-in popup calls.
  const signIn = await app.request(`/api/v1/projects/${uid}/sessions/member`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf },
    body: JSON.stringify({ origin: SITE }),
  });
  const m = await json(signIn);
  assert.equal(signIn.status, 201, JSON.stringify(m));
  assert.ok(m.permissions.includes("thread:private"));
  member = m.sessionToken;

  team = await redeemLink(["thread:create", "comment:create", "thread:resolve", "thread:private", "thread:assign"]);
  client = await redeemLink();

  const thread = async (body: string): Promise<string> => {
    const res = await app.request(`/api/v1/projects/${uid}/threads`, {
      method: "POST",
      headers: bearer(member),
      body: JSON.stringify({
        comment: { body },
        anchor: { offset: { x: 0.5, y: 0.5 }, page: { route: "/", pathname: "/", origin: SITE } },
        context: { url: `${SITE}/` },
      }),
    });
    const t = await json(res);
    assert.equal(res.status, 201, JSON.stringify(t));
    return t.id as string;
  };
  const reply = async (id: string, body: string, priv: boolean) => {
    const res = await app.request(`/api/v1/projects/${uid}/threads/${id}/comments`, {
      method: "POST",
      headers: bearer(member),
      body: JSON.stringify({ body, ...(priv ? { private: true } : {}) }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    return json(res);
  };

  publicThread = await thread("The button is the wrong blue");
  await reply(publicThread, "Fixed on staging", false);
  const r = await reply(publicThread, SECRET_REPLY, true);
  assert.equal(r.private, true, "the member's own private reply comes back marked");
  privateThread = await thread(SECRET_THREAD);
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const get = (path: string, token: string) => app.request(`/api/v1/projects/${uid}${path}`, { headers: bearer(token) });

test("making the thread private, from the MEMBER's widget session, answers with the private view", { skip }, async () => {
  const res = await app.request(`/api/v1/projects/${uid}/threads/${privateThread}`, {
    method: "PATCH",
    headers: bearer(member),
    body: JSON.stringify({ private: true }),
  });
  const b = await json(res);
  assert.equal(res.status, 200, JSON.stringify(b));
  assert.equal(b.private, true);
  // It used to come back as the client's view of a private thread: no
  // comments, a count of 0 — to the person who had just written it.
  assert.equal(b.comments.length, 1);
  assert.equal(b.comments[0].private, true, "the flip makes every reply private (05 section 6.4)");
  assert.equal(b.commentCount, 1);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

for (const who of ["member", "team"] as const) {
  test(`a ${who} widget session's LIST carries team-only threads and replies, marked, and counted`, { skip }, async () => {
    const res = await get("/threads", who === "member" ? member : team);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const b = await json(res);
    const pub = b.data.find((t: any) => t.id === publicThread);
    const priv = b.data.find((t: any) => t.id === privateThread);
    assert.ok(pub && priv, "both threads");
    assert.equal(pub.private, undefined, "a public thread carries no key at all, not false");
    assert.deepEqual(
      pub.comments.map((c: any) => [c.body, c.private]),
      [
        ["The button is the wrong blue", undefined],
        ["Fixed on staging", undefined],
        [SECRET_REPLY, true],
      ],
    );
    // The count is what this reader can count: three, not the public two.
    assert.equal(pub.commentCount, 3);
    assert.equal(priv.private, true);
    assert.equal(priv.comments[0].private, true);
    assert.equal(priv.commentCount, 1);
  });

  test(`a ${who} widget session's DETAIL reads the private thread`, { skip }, async () => {
    const res = await get(`/threads/${privateThread}`, who === "member" ? member : team);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const b = await json(res);
    assert.equal(b.private, true);
    assert.equal(b.comments[0].body, SECRET_THREAD);
  });
}

test("a member's widget session still gets no tombstones — those stay the dashboard's", { skip }, async () => {
  const res = await app.request(`/api/v1/projects/${uid}/threads/${publicThread}/comments`, {
    method: "POST",
    headers: bearer(member),
    body: JSON.stringify({ body: "a reply about to go" }),
  });
  const c = await json(res);
  const del = await app.request(`/api/v1/projects/${uid}/comments/${c.id}`, { method: "DELETE", headers: bearer(member) });
  assert.equal(del.status, 200, await del.text());
  const b = await json(await get(`/threads/${publicThread}`, member));
  assert.equal(b.comments.length, 3);
  assert.ok(b.comments.every((x: any) => x.body !== null));
});

test("a CLIENT link session gets neither, exactly as before: no key, no bytes, the public count, no header", { skip }, async () => {
  const res = await get("/threads", client);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), null, "a client's response is unchanged, header included");
  const raw = await res.text();
  for (const needle of [SECRET_REPLY, SECRET_THREAD, '"private"', privateThread]) {
    assert.equal(raw.includes(needle), false, `${needle} in a client's bytes`);
  }
  const b = JSON.parse(raw);
  assert.equal(b.data.length, 1);
  assert.deepEqual(
    b.data[0].comments.map((c: any) => Object.keys(c).sort()),
    [
      ["author", "body", "createdAt", "id"],
      ["author", "body", "createdAt", "id"],
    ],
    "the comment shape a client always had",
  );
  assert.equal(b.data[0].commentCount, 2);

  const detail = await get(`/threads/${privateThread}`, client);
  assert.equal(detail.status, 404, "absent, not forbidden (section 6.4a)");
  const pub = await get(`/threads/${publicThread}`, client);
  assert.equal(pub.headers.get("cache-control"), null);
  assert.equal((await pub.text()).includes(SECRET_REPLY), false);
});

test("a CLIENT cannot change a team-only thread it knows the id of — it is absent, 404", { skip }, async () => {
  const res = await app.request(`/api/v1/projects/${uid}/threads/${privateThread}`, {
    method: "PATCH",
    headers: bearer(client),
    body: JSON.stringify({ status: "resolved" }),
  });
  assert.equal(res.status, 404, await res.clone().text());
  const raw = await res.text();
  assert.equal(raw.includes(SECRET_THREAD), false);
  const [row] = await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    return tx<{ status: string }[]>`SELECT status FROM threads WHERE id = ${privateThread.replace(/^thr_/, "")}::uuid`;
  });
  assert.notEqual(row!.status, "resolved", "and nothing was written");
});

test("the POLL: a thread turning private is a tombstone for the client and a row for the member", { skip }, async () => {
  const since = new Date(Date.now() - 1000).toISOString();
  const flip = await app.request(`/api/v1/projects/${uid}/threads/${publicThread}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf },
    body: JSON.stringify({ private: true }),
  });
  assert.equal(flip.status, 200, await flip.text());

  const clientPoll = await get(`/threads?since=${encodeURIComponent(since)}`, client);
  assert.equal(clientPoll.headers.get("cache-control"), null);
  const craw = await clientPoll.text();
  assert.equal(craw.includes(SECRET_REPLY), false);
  const cb = JSON.parse(craw);
  assert.ok(cb.deleted.includes(publicThread), "dropped from the client's cached copy");
  assert.equal(cb.data.some((t: any) => t.id === publicThread), false);

  for (const token of [member, team]) {
    const poll = await get(`/threads?since=${encodeURIComponent(since)}`, token);
    assert.equal(poll.headers.get("cache-control"), "private, no-store");
    const b = await json(poll);
    assert.equal(b.deleted.includes(publicThread), false, "the member keeps it");
    const row = b.data.find((t: any) => t.id === publicThread);
    assert.equal(row?.private, true);
    assert.equal(row.commentCount, 3);
    assert.ok(row.comments.every((c: any) => c.private === true), "the flip made every reply private");
  }
});

test("no thread read carries `public` caching, for anyone", { skip }, async () => {
  for (const token of [member, team, client]) {
    for (const path of ["/threads", `/threads/${privateThread}`, `/threads/${privateThread}.md`]) {
      const res = await get(path, token);
      assert.equal((res.headers.get("cache-control") ?? "").includes("public"), false, path);
    }
  }
});

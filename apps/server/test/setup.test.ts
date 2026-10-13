import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { boot, isClaimed } from "../src/boot.ts";
import { createApp } from "../src/app.ts";
import { DASHBOARD_SESSION_COOKIE, DASHBOARD_CSRF_COOKIE } from "@snagset/types/names";
import { rlsStatus } from "../src/db/rls.ts";

/**
 * The claim flow, against a REAL Postgres — and.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL`, so a checkout with no database
 * still runs a green suite. It is a separate variable from `DATABASE_URL` on
 * purpose: this file DROPS AND RECREATES the public schema, and a test that
 * can wipe the development database because someone had one variable set is a
 * mistake that only has to happen once.
 *
 * Everything worth asserting here needs the database. `orgs == 0` is the whole
 * state machine; the `409 instance_unclaimed` gate is a consequence of it; and
 * the claim transaction's value is precisely that a real Postgres enforces the
 * seven constraints it has to satisfy. Two of them — `ip_salt` at exactly 32
 * bytes and `uid` at exactly 12 Crockford characters — were wrong in the first
 * implementation and no unit test would have noticed.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the claim-flow tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let deps: Parameters<typeof createApp>[0];

const cfg = () =>
  loadConfig({
    DATABASE_URL: URL_ ?? "postgres://unused",
    SNAGSET_DATA_DIR: "",
  });

before(async () => {
  if (skip) return;

  /**
   * TWO GUARDS, because the variable separation alone was not enough.
   *
   * This file drops the schema, and the comment above says a test that can
   * wipe a development database "is a mistake that only has to happen once".
   * It then happened: a verification run set SNAGSET_TEST_DATABASE_URL to the
   * same Neon URL as DATABASE_URL and destroyed a live dogfood instance —
   * four threads, the project uid every config pointed at, all of it.
   *
   * A separate NAME is a convention, and a convention is a thing a person
   * defeats by typing. These two are the mechanism:
   *
   *   1. The two URLs must differ. Catches the exact mistake that was made.
   *   2. The database must have NO orgs. Catches the more general one — a
   *      second URL that happens to point at something real — because a
   *      claimed instance is by definition not a scratch database, whatever
   *      it is called.
   */
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error(
      "SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL. This suite DROPS the schema — " +
        "point it at a scratch database, not the one you are running against.",
    );
  }

  sql = connect(URL_!, { max: 2 });
  const claimed = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM orgs
  `.catch(() => [{ n: 0 }]); // no schema yet is exactly what this suite wants
  if ((claimed[0]?.n ?? 0) > 0) {
    await sql.end({ timeout: 5 });
    throw new Error(
      `Refusing to run: ${new URL(URL_!).pathname} holds a CLAIMED instance (${claimed[0]!.n} org(s)). ` +
        "This suite drops the schema. Use an empty database.",
    );
  }

  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

test("boot on an empty database is CLAIMABLE and mints NOTHING", { skip }, async () => {
  // This asserted a `?claim=` URL and a live row in setup_tokens. Both are
  // gone on purpose: an unclaimed instance is claimable by whoever reaches it
  // first, so a token beside that path guards nothing and only implies it
  // does. The assertion is inverted rather than deleted — a mint that comes
  // back should fail a test, not pass one silently.
  const c = loadConfig({
    DATABASE_URL: URL_!,
    SNAGSET_BASE_URL: "http://localhost:8080",
    SNAGSET_SECRET_KEY: Buffer.alloc(32, 7).toString("base64url"),
  });
  const result = await boot(sql, c, { writable: false, log: () => {} });

  assert.equal(result.state, "CLAIMABLE", "no owner yet — that is all the state means now");
  assert.equal(result.claimUrl, null, "nothing to hand back");
  assert.equal(result.dataDir, null, "nothing was written on the serverless path");

  const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM setup_tokens`;
  assert.equal(n?.n, 0, "and no token behind it, so nobody goes looking for one");
});

test("repeated boots stay CLAIMABLE and still mint nothing", { skip }, async () => {
  const c = loadConfig({
    DATABASE_URL: URL_!,
    SNAGSET_BASE_URL: "http://localhost:8080",
    SNAGSET_SECRET_KEY: Buffer.alloc(32, 7).toString("base64url"),
  });
  await boot(sql, c, { writable: false, log: () => {} });
  const again = await boot(sql, c, { writable: false, log: () => {} });
  assert.equal(again.state, "CLAIMABLE");
  const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM setup_tokens`;
  assert.equal(n?.n, 0, "a restart loop cannot accumulate tokens it does not create");
});

test("every route but the allow-list is 409 instance_unclaimed", { skip }, async () => {
  deps = {
    sql,
    cfg: cfg(),
    state: "CLAIMABLE",
    secretKey: Buffer.alloc(32, 7).toString("base64url"),
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test/src",
    modified: false,
  };
  app = createApp(deps);

  // `/dashboard` is NOT in this list, and the design is why: the gate
  // covers "all routes except /setup, /healthz, /readyz, GET /api/v1/meta and
  // STATIC ASSETS". The dashboard shell is a static asset, and it has to be
  // served while the instance is unclaimed or the first-run screen — the
  // one the printed claim URL lands on — could never render. The API is what
  // refuses; the page that explains how to claim is what loads.
  //
  // This assertion listed `/dashboard` from before a dashboard existed, when
  // nothing served statics and every path fell through to the gate. It went
  // unnoticed because the two DB suites skip without SNAGSET_TEST_DATABASE_URL.
  for (const path of ["/api/v1/projects", "/api/v1/threads"]) {
    const res = await app.request(path);
    assert.equal(res.status, 409, `${path} is gated`);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "instance_unclaimed");
    // "an operator staring at a fresh container needs to be
    // told what to do, not that the route does not exist."
    assert.match(body.error.message, /claim URL|bootstrap/);
  }

  // The allow-list. 409-not-503 is the point of the whole paragraph:
  // a 503 here puts a healthy instance into a restart loop behind any proxy
  // that ejects 503-returning backends, and the operator never reads the URL.
  assert.equal((await app.request("/healthz")).status, 200);
  assert.equal((await app.request("/readyz")).status, 200);
  assert.equal((await app.request("/api/v1/meta")).status, 200);

  // And the static half of that same allow-list, asserted rather than assumed:
  // the shell loads on an unclaimed instance, because the claim URL lands on it.
  const shell = await app.request("/");
  assert.equal(shell.status, 200, "the dashboard shell is served while CLAIMABLE");
  assert.match(shell.headers.get("content-type") ?? "", /text\/html/);
});

test("a wrong claim token is 409 already_claimed, never 403", { skip }, async () => {
  // Same code as a consumed token, so a guesser learns nothing from the
  // difference — and `setup:ip` is what makes guessing cost money.
  const res = await app.request("/api/v1/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "definitely-not-the-token",
      orgName: "Nope",
      email: "a@b.test",
      password: "123456789012",
    }),
  });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "already_claimed");
});

test("the claim creates a WORKING instance in one transaction", { skip }, async () => {
  const res = await app.request("/api/v1/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // No token: this IS the path now, and the test that used to prove the
      // token flow proves the flow people actually take.
      orgName: "A studio",
      // What the owner's browser was at. Kept, since the environment names no address.
      address: "https://review.example.studio",
      email: "owner@example.test",
      password: "a-long-enough-password",
      projectName: "Kilnwork",
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    project: { uid: string; keyPrefix: string };
    csrfToken: string;
  };

  // And the CHECK is what actually enforces it.
  assert.match(body.project.uid, /^prj_[0-9abcdefghjkmnpqrstvwxyz]{12}$/);
  assert.equal(body.project.keyPrefix, "SN", "not 'CD' — the rename residue this milestone removed");
  // The session is a COOKIE now, not a token in the body — the design makes the
  // `user_sessions` row the authority and the transport a first-party cookie.
  // What the body carries is the CSRF half, which is deliberately readable.
  assert.ok(body.csrfToken.length >= 40, "the double-submit token comes back once");
  const cookies = res.headers.getSetCookie();
  {
    // The claim kept the address, and the row says where it came from.
    const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const csrf = body.csrfToken; // already parsed above — the body reads once
    const inst = await app.request("/api/v1/instance", { headers: { Cookie: cookie, "x-snagset-csrf": csrf } });
    assert.equal(inst.status, 200, await inst.clone().text());
    const address = ((await inst.json()) as { address: { url: string; source: string } }).address;
    assert.equal(address.source, "stored");
    assert.equal(address.url, "https://review.example.studio");
  }
  assert.ok(
    cookies.some((c) => c.startsWith(`${DASHBOARD_SESSION_COOKIE}=`) && c.includes("HttpOnly")),
    "the session cookie is set, HttpOnly",
  );
  assert.ok(
    cookies.some((c) => c.startsWith(`${DASHBOARD_CSRF_COOKIE}=`) && !c.includes("HttpOnly")),
    "the CSRF cookie is set and readable — double-submit needs the page to echo it",
  );

  // Everything the FIRST THREAD needs, which is the only useful definition of
  // "the claim worked". A missing environment or a missing round makes the
  // instance look claimed and refuse the first comment on a NOT NULL.
  const [counts] = await sql<{ [k: string]: number }[]>`
    SELECT (SELECT count(*) FROM orgs)::int          AS orgs,
           (SELECT count(*) FROM users)::int         AS users,
           (SELECT count(*) FROM memberships WHERE role = 'owner')::int AS owners,
           (SELECT count(*) FROM projects)::int      AS projects,
           (SELECT count(*) FROM environments)::int  AS envs,
           (SELECT count(*) FROM rounds)::int        AS rounds,
           (SELECT count(*) FROM user_sessions)::int AS sessions
  `;
  assert.deepEqual(counts, { orgs: 1, users: 1, owners: 1, projects: 1, envs: 2, rounds: 1, sessions: 1 });

  // The first round has to exist, or `threads.round_id NOT NULL` makes the
  // very first comment impossible on a freshly claimed instance.
  const [round] = await sql<{ number: number; name: string }[]>`SELECT number, name FROM rounds`;
  assert.deepEqual({ ...round }, { number: 1, name: "Round 1" });

  // The CHECK (octet_length(ip_salt) = 32) — a salt that changes size means
  // every historical ip_hash becomes unmatchable by the erasure path.
  const [p] = await sql<{ salt: number }[]>`SELECT octet_length(ip_salt)::int AS salt FROM projects`;
  assert.equal(p!.salt, 32);

  // No token was involved, so there is nothing to consume — and the sweep in
  // the claim transaction means none is left lying around either.
  const [t] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM setup_tokens`;
  assert.equal(t?.total, 0, "claimed with no token, and none left behind");

  assert.equal(deps.state, "READY", "the gate lifts without a restart");
});

test("a replayed claim is 409, and the gate is gone", { skip }, async () => {
  const res = await app.request("/api/v1/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orgName: "Second",
      email: "b@c.test",
      password: "123456789012",
    }),
  });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "already_claimed");

  // 404, not 409: the instance is claimed, so an unknown route is just unknown.
  //
  // The path used to be `/api/v1/projects`, chosen when nothing was mounted
  // there. The decision made it a real route (POST, add a site), so the assertion began
  // reading `requireOwner()`'s 401 instead — a test that silently stopped
  // checking what it was named for. Any genuinely unrouted path works.
  assert.equal((await app.request("/api/v1/no-such-route")).status, 404);
});

test("`snagset bootstrap` no longer mints anything", { skip }, async () => {
  // This used to assert that bootstrap minted a fresh token and voided the
  // old one. Nothing mints now: an unclaimed instance is claimable by whoever
  // reaches it first, so a token beside that path guards nothing.
  //
  // What is asserted instead is the property that replaced it — that boot
  // leaves NO token behind, so an operator cannot find one and conclude they
  // need it.
  await sql`DELETE FROM setup_tokens`;
  const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM setup_tokens`;
  assert.equal(n?.n, 0);
  assert.equal(
    typeof (await import("../src/boot.ts") as Record<string, unknown>)["mintClaim"],
    "undefined",
    "mintClaim is gone, not merely unused — a mint function nothing calls is a mint waiting to be called",
  );
});

test("the RLS probe tells the truth about this database", { skip }, async () => {
  const s = await rlsStatus(sql);
  // Whatever the answer is, these hold: the migration created a policy for
  // every tenanted table and FORCEd all of them. What varies by target is
  // whether the connecting role is permitted to ignore them.
  assert.deepEqual(s.unprotected, [], "every org_id table has a policy");
  assert.deepEqual(s.notForced, [], "and every one of them is FORCEd");
  assert.equal(
    s.effective,
    !s.roleBypassesRls,
    "effective iff the role cannot bypass — the third switch",
  );
  if (s.roleBypassesRls) {
    // The whole point: the gap is REPORTED rather than silently accepted.
    assert.match(s.warning ?? "", /BYPASSRLS[\s\S]*DATABASE_URL at it/);
  } else {
    assert.equal(s.warning, null);
  }
});

/**
 * ── The claim, after the first-visitor-wins ────────────────────────────
 */

test("GET /api/v1/setup tells a browser which screen to draw", { skip }, async () => {
  // The setup screen exists because an unclaimed instance used to serve a
  // sign-in form for an account that did not exist. It cannot know which to
  // draw without asking, so this is public — one bit, and that bit is
  // inherent to first-run setup being open at all.
  const res = await app.request("/api/v1/setup");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { claimed: true, signup: false });
});

test("a TOKENLESS claim on a claimed instance is 409 — the window shuts", { skip }, async () => {
  // The other half. Dropping the token requirement is only safe if
  // "already claimed" is answered correctly forever after, so this is the
  // assertion the whole decision rests on.
  const res = await app.request("/api/v1/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgName: "Squatter", email: "x@y.test", password: "123456789012" }),
  });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "already_claimed");
});

test("isClaimed is true WITHOUT rolbypassrls — the count that lied", { skip }, async () => {
  // THE BUG THIS PINS, which was live and silent.
  //
  // `orgs` is FORCE ROW LEVEL SECURITY under
  //     id = NULLIF(current_setting('app.org_id', true), '')::uuid
  //       OR current_setting('app.maintenance', true) = 'on'
  // and the claim check runs before any org exists to scope to. With neither
  // setting made, `count(*) FROM orgs` returns 0 on any role that does not
  // bypass RLS — whatever the table holds. It read correctly only because the
  // role we develop against carries `rolbypassrls`, and `rlsStatus` never
  // caught it: that check inspects tables having an `org_id` column, and
  // `orgs` matches on `id`.
  //
  // Under first-visitor-wins it stops being untidy and becomes the whole
  // problem — a live instance offering itself to whoever asks next.
  //
  // So this test asserts the CONTRAST, not just the result: the naive count
  // must lie and `isClaimed` must not. If someone ever removes the
  // maintenance claim, the first assertion fails too and says why.
  const su = await sql`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
  if (!su[0]?.rolsuper) return; // cannot create a role to test with; nothing to prove here

  const pw = "probe_pw_12345";
  await sql.unsafe(`DROP ROLE IF EXISTS snagset_rls_probe`);
  await sql.unsafe(`CREATE ROLE snagset_rls_probe LOGIN PASSWORD '${pw}' NOBYPASSRLS`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO snagset_rls_probe`);
  await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO snagset_rls_probe`);

  const url = new URL(URL_!);
  url.username = "snagset_rls_probe";
  url.password = pw;
  const restricted = connect(url.toString(), {});
  try {
    const naive = await restricted<{ n: number }[]>`SELECT count(*)::int AS n FROM orgs`;
    assert.equal(naive[0]?.n, 0, "the naive count still lies — that is the trap this closes");
    assert.equal(await isClaimed(restricted), true, "…and isClaimed sees past it");
  } finally {
    await restricted.end({ timeout: 5 });
    await sql.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM snagset_rls_probe`);
    await sql.unsafe(`REVOKE USAGE ON SCHEMA public FROM snagset_rls_probe`);
    await sql.unsafe(`DROP ROLE IF EXISTS snagset_rls_probe`);
  }
});

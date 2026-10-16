import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { validateOrigins } from "../src/projects.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * Adding a site — the multi-site, against a real Postgres.
 *
 * ── WHY EVERY ASSERTION IS "AND THEN A COMMENT LANDS ON IT" ──
 *
 * A project is a row PLUS two environments PLUS a round, and the two of those
 * that matter are NOT NULL foreign keys on `threads`. So a create route that
 * writes only the row produces a project which looks perfectly healthy — it
 * lists, it switches, it renders a script tag — and rejects the first pin
 * anybody tries to leave. Asserting `201` and a uid would pass over exactly
 * that bug, which is why the central test here creates a site through the route
 * and then posts a real thread to it.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the site tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let owner: { cookie: string; csrf: string };
let orgId: string;

const SECRET = Buffer.alloc(32, 5).toString("base64url");
const PASSWORD = "correct horse battery staple";

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `login failed: ${text}`);
  return {
    cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "),
    csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken,
  };
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
  const userId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, password_hash)
      VALUES (${userId}, ${orgId}, 'o@e.test', ${hashPassword(PASSWORD)})`;
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
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>;
// The header name comes from the constants module, never typed. Hardcoding
// `x-snag-csrf` here (the real one is `x-snagset-csrf`) made every write in
// this file 403 — and made the "without the CSRF header it is refused" test
// pass for entirely the wrong reason, which is the worse half.
const asOwner = () => ({
  "content-type": "application/json",
  Cookie: owner.cookie,
  [HTTP_HEADER.csrf]: owner.csrf,
});

async function addSite(name: string, origins?: string): Promise<Record<string, any>> {
  const res = await app.request("/api/v1/projects", {
    method: "POST",
    headers: asOwner(),
    body: JSON.stringify({ name, ...(origins ? { origins } : {}) }),
  });
  const b = await json(res);
  assert.equal(res.status, 201, JSON.stringify(b));
  return b;
}

// ── the thing that was missing ───────────────────────────────────────────

test("a second site can be added at all — and a THIRD", { skip }, async () => {
  // The dashboard shipped with a project switcher over a list nothing could
  // add to. This is the assertion that gap could not have passed.
  const a = await addSite("Acme redesign", "https://staging.acme.com");
  const b = await addSite("Beta shop", "https://shop.beta.test");
  assert.match(a.uid, /^prj_[0-9abcdefghjkmnpqrstvwxyz]{12}$/);
  assert.notEqual(a.uid, b.uid);

  const me = await json(await app.request("/api/v1/me", { headers: { Cookie: owner.cookie } }));
  assert.equal(me.projects.length, 2, "both are on the switcher");
  assert.deepEqual(me.projects.map((p: any) => p.name).sort(), ["Acme redesign", "Beta shop"]);
});

test("a site created through the route ACCEPTS A COMMENT", { skip }, async () => {
  /**
   * The test that matters. `threads.environment_id` and `threads.round_id` are
   * both NOT NULL, so a create route that writes only the projects row yields
   * a site that lists, switches and renders a tag — and rejects the first pin.
   * A 201-and-a-uid assertion sails straight past that.
   */
  const site = await addSite("Live site", "https://live.test");

  const session = await app.request(`/api/v1/projects/${site.uid}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://live.test" },
    body: JSON.stringify({ identity: { kind: "guest", name: "Ada" } }),
  });
  const s = await json(session);
  assert.equal(session.status, 201, JSON.stringify(s));

  const thread = await app.request(`/api/v1/projects/${site.uid}/threads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: "https://live.test",
      Authorization: `Bearer ${s.sessionToken}`,
    },
    body: JSON.stringify({
      comment: { body: "The button does nothing" },
      anchor: {
        offset: { x: 0.5, y: 0.5 },
        page: { route: "/", pathname: "/", origin: "https://live.test" },
      },
      context: { url: "https://live.test/" },
    }),
  });
  const t = await json(thread);
  assert.equal(thread.status, 201, JSON.stringify(t));
  assert.equal(t.key, "SN-1", "and it got a key, so it has a round");
});

test("the new site's allow-list reaches CORS — the header, which is the control", { skip }, async () => {
  /**
   * The first version asserted the un-allowed origin got a NON-201, and it
   * failed because CORS does not work that way: the server processes the
   * request and withholds `Access-Control-Allow-Origin`, so the BROWSER
   * refuses to hand the response to the page. This repo has already paid for
   * that confusion once — the review-link route was mintable by `curl`
   * precisely because absent CORS headers stop a browser and nothing else.
   *
   * So the assertion is on the header. That IS the control, and it is the one
   * that has to be wired to the allow-list the create route just wrote.
   */
  const site = await addSite("Fenced", "https://allowed.test");
  const path = `/api/v1/projects/${site.uid}/sessions`;
  const body = JSON.stringify({ identity: { kind: "guest", name: "Ada" } });

  const allowed = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://allowed.test" },
    body,
  });
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "https://allowed.test",
    "the origin passed to POST /projects is echoed, so the widget can read its credential",
  );

  const stranger = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://not-allowed.test" },
    body,
  });
  assert.equal(
    stranger.headers.get("access-control-allow-origin"),
    null,
    "and an origin nobody allow-listed gets no header, so no page on it can read the token",
  );
});

// ── who may add one ──────────────────────────────────────────────────────

test("no owner cookie → 401, and curl cannot add a site", { skip }, async () => {
  // The review-link route was mintable by `curl` because absent CORS headers
  // stop a BROWSER and nothing else. Same class, checked before shipping.
  const res = await app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Sneaky" }),
  });
  assert.equal(res.status, 401);
});

test("an owner cookie WITHOUT the CSRF header is refused", { skip }, async () => {
  const res = await app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ name: "No CSRF" }),
  });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error.code, "csrf_failed");

  // …and the same request WITH it succeeds, which is what stops this from
  // passing because the header name is wrong. It did exactly that once.
  const ok = await app.request("/api/v1/projects", {
    method: "POST",
    headers: asOwner(),
    body: JSON.stringify({ name: "With CSRF" }),
  });
  assert.equal(ok.status, 201);
});

// ── the input ────────────────────────────────────────────────────────────

test("a bad origin is REFUSED with a fixable sentence, never silently dropped", { skip }, async () => {
  // Silently dropping it is the worst outcome available: the site is added,
  // the tag is pasted, every request is refused by CORS, and nothing said so.
  const res = await app.request("/api/v1/projects", {
    method: "POST",
    headers: asOwner(),
    body: JSON.stringify({ name: "Typo", origins: "staging.acme.com" }),
  });
  assert.equal(res.status, 400);
  assert.match((await json(res)).error.message, /needs a scheme/);

  const me = await json(await app.request("/api/v1/me", { headers: { Cookie: owner.cookie } }));
  assert.ok(!me.projects.some((p: any) => p.name === "Typo"), "and nothing was created");
});

test("a site with no origins is created, and SAYS it cannot be talked to", { skip }, async () => {
  const b = await addSite("Origins later");
  assert.match(b.warning, /No origins allowed yet/);
});

test("origins are normalised, so one origin cannot become two rows", { skip }, () => {
  // `project_origins` is UNIQUE on (project_id, pattern) and would happily
  // hold `https://Acme.com/` and `https://acme.com` as different origins.
  assert.deepEqual(validateOrigins(["HTTPS://Staging.Acme.com/"]), ["https://staging.acme.com"]);
  assert.deepEqual(validateOrigins(["https://*.acme.com"]), ["https://*.acme.com"]);
  assert.throws(() => validateOrigins(["https://acme.com/path"]), /has a path/);
  assert.throws(() => validateOrigins(["ftp://acme.com"]), /must be http/);
});

// ── adding an origin after the fact ──────────────────────────────────────

test("an origin can be added later, and adding it twice is a no-op", { skip }, async () => {
  const site = await addSite("Later");
  for (let i = 0; i < 2; i++) {
    const res = await app.request(`/api/v1/projects/${site.uid}/origins`, {
      method: "POST",
      headers: asOwner(),
      body: JSON.stringify({ origin: "https://later.test" }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual((await json(res)).origins, ["https://later.test"], `call ${i + 1}`);
  }
});

test("a site in another org is reported ABSENT, not forbidden", { skip }, async () => {
  const otherOrg = randomUUID();
  const otherUser = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${otherOrg}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${otherOrg}, 'Other', 'other')`;
    await tx`INSERT INTO users (id, org_id, email) VALUES (${otherUser}, ${otherOrg}, 'x@other.test')`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${otherOrg}, ${otherUser}, 'owner')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag)
      VALUES (${randomUUID()}, ${otherOrg}, 'prj_zzzzzzzzzzzz', 'Theirs', ${Buffer.alloc(32, 3)}, 'e')`;
  });
  const res = await app.request("/api/v1/projects/prj_zzzzzzzzzzzz/origins", {
    method: "POST",
    headers: asOwner(),
    body: JSON.stringify({ origin: "https://evil.test" }),
  });
  // 404, not 403 — a uid's validity must leak nothing about somebody else's org.
  assert.equal(res.status, 404);
});

// ──: who sees the toolbar ────────────────────────────────────────────

test("/config reports the EFFECTIVE write mode, not the raw column", { skip }, async () => {
  /**
   * The decision makes this field the thing that decides whether every visitor sees
   * the toolbar, and the raw value lies during the grace: a site 25 hours
   * old still says `open` while every write is already refused. A toolbar
   * shown off the raw column is a comment form the product fills in and then
   * tears up.
   */
  const site = await addSite("Graced", "https://graced.test");
  const row = await sql<{ id: string }[]>`SELECT id FROM projects WHERE uid = ${site.uid}`;
  await sql`
    UPDATE projects SET write_mode = 'open', write_mode_downgrade_at = now() - interval '1 hour'
     WHERE id = ${row[0]!.id}::uuid`;

  const conf = await json(await app.request(`/api/v1/projects/${site.uid}/config`));
  assert.equal(conf.writeMode, "link-required", "the grace expired, and the config must say so");
});

test("the dashboard says what the widget enforces, before any sweep has caught the row up", { skip }, async () => {
  /**
   * The reaper that rewrites the row runs with the sweep, which the decision made
   * hourly on the bin and daily on Vercel's Hobby plan. Until it does, the
   * row says `open` while every write is refused, so the owner's sites list
   * and the answer to an edit must compute the downgrade the way `/config`
   * does, or they show a site open to everyone that nobody can comment on.
   */
  const site = await addSite("Unswept", "https://unswept.test");
  await sql`
    UPDATE projects SET write_mode = 'open', write_mode_downgrade_at = now() - interval '1 hour'
     WHERE uid = ${site.uid}`;

  const me = await json(await app.request("/api/v1/me", { headers: asOwner() }));
  const listed = (me.projects as { uid: string; writeMode: string }[]).find((p) => p.uid === site.uid);
  assert.equal(listed?.writeMode, "link-required", "the sites list");

  const renamed = await app.request(`/api/v1/projects/${site.uid}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ name: "Unswept, renamed" }),
  });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  assert.equal((await json(renamed)).writeMode, "link-required", "the answer to an edit that did not touch the audience");

  const [row] = await sql<{ write_mode: string }[]>`SELECT write_mode FROM projects WHERE uid = ${site.uid}`;
  assert.equal(row!.write_mode, "open", "the row itself is still waiting for the sweep");
});

test("the owner can open a site to everyone, and that CLEARS the grace timer", { skip }, async () => {
  const site = await addSite("Toggled", "https://toggled.test");
  const res = await app.request(`/api/v1/projects/${site.uid}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ writeMode: "open" }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const [p] = await sql<{ write_mode: string; write_mode_downgrade_at: Date | null }[]>`
    SELECT write_mode, write_mode_downgrade_at FROM projects WHERE uid = ${site.uid}`;
  assert.equal(p!.write_mode, "open");
  // Choosing "everyone" deliberately is the opposite of the forgetting the
  // 24-hour timer guards; leaving it set would make the toolbar silently
  // vanish a day later — this product's most mysterious possible bug report.
  assert.equal(p!.write_mode_downgrade_at, null);

  const conf = await json(await app.request(`/api/v1/projects/${site.uid}/config`));
  assert.equal(conf.writeMode, "open");
});

test("closing a site to link-holders works, and the config follows", { skip }, async () => {
  const site = await addSite("Closed", "https://closed.test");
  await app.request(`/api/v1/projects/${site.uid}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ writeMode: "link-required" }),
  });
  const conf = await json(await app.request(`/api/v1/projects/${site.uid}/config`));
  assert.equal(conf.writeMode, "link-required");
});

// ──: the origin-aware config body (conformed at last) ───────

test("/config from an ALLOW-LISTED origin gets the full body, writable", { skip }, async () => {
  const site = await addSite("Placed", "https://placed.test");
  const res = await app.request(`/api/v1/projects/${site.uid}/config`, {
    headers: { Origin: "https://placed.test" },
  });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://placed.test");
  const conf = await json(res);
  assert.equal(conf.writable, true);
  assert.ok("keyPrefix" in conf, "an allow-listed origin gets the private half");
  assert.ok(Array.isArray(conf.rounds));
});

test("/config from a STRANGER origin: 200, public subset, writable false", { skip }, async () => {
  /**
   * The maintainer's design, verbatim: "the api gets the url that should be there and
   * then just validates in the frontend." The server judges the origin the
   * browser already sends and ships the VERDICT — never the allow-list
   * itself, because the list is the customer's own map of their staging
   * hostnames and the uid needed to ask for it is printed in page source.
   *
   * 200 and not 403, because this same fetch is how the origin suggestion is
   * born, and the stub on a mirrored page needs a READABLE `writable: false`
   * to stay dormant.
   */
  const site = await addSite("Mirrored", "https://real.test");
  const res = await app.request(`/api/v1/projects/${site.uid}/config`, {
    headers: { Origin: "https://web.archive.org" },
  });
  assert.equal(res.status, 200);
  // Public-read: the stranger can READ the verdict (that is the point) …
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://web.archive.org");
  // … and a shared cache must never replay one origin's body to another.
  assert.equal(res.headers.get("Vary"), "Origin");
  // … and since some shared caches ignore Vary (Vercel's edge replayed a
  // localhost copy to a client site), none of them may keep it at all.
  assert.equal(res.headers.get("Cache-Control"), "private, max-age=60");
  const conf = await json(res);
  assert.equal(conf.writable, false);
  assert.equal(conf.reason, "origin_not_allowed");
  assert.ok(conf.writeMode, "the public subset still carries the audience");
  assert.ok(!("keyPrefix" in conf), "the private half must not leak to a stranger");
  assert.ok(!("rounds" in conf), "round names are the project's business, not the internet's");
});

test("/config with NO Origin header is not a stranger", { skip }, async () => {
  // Same-origin pages and curl send no Origin; treating absence as refusal
  // would break the operator poking their own instance.
  const site = await addSite("Local", "https://own.test");
  const conf = await json(await app.request(`/api/v1/projects/${site.uid}/config`));
  assert.equal(conf.writable, true);
  assert.ok("keyPrefix" in conf);
});

test("the audience PATCH is dashboard-class — no cookie 401, no CSRF 403", { skip }, async () => {
  const site = await addSite("Guarded", "https://guarded.test");
  const bare = await app.request(`/api/v1/projects/${site.uid}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ writeMode: "open" }),
  });
  assert.equal(bare.status, 401);
  const noCsrf = await app.request(`/api/v1/projects/${site.uid}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ writeMode: "open" }),
  });
  assert.equal(noCsrf.status, 403);
});

test("a nonsense writeMode is refused with the vocabulary", { skip }, async () => {
  const site = await addSite("Strict", "https://strict.test");
  const res = await app.request(`/api/v1/projects/${site.uid}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ writeMode: "everyone" }),
  });
  assert.equal(res.status, 400);
  assert.match((await json(res)).error.message, /open, link-required or verified-only/);
});

// ── Sites are editable, and deletable — 2026-09-01 ────────────────────────

test("a site's NAME and ORIGINS can be corrected after creation", { skip }, async () => {
  // Mounted PATCH for `writeMode` alone, so a site was create-once: a typo
  // in the name was permanent, and a staging URL that moved could only be
  // ADDED to. The maintainer, using it: "the sites we should be able to edit the url
  // and name and delete or edit it, right now is just one time."
  const site = await addSite("Typo Nmae", "https://old.example.com");
  const res = await app.request(`/api/v1/projects/${site.uid}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ name: "Kilnwork (staging)", origins: ["https://new.example.com"] }),
  });
  // Read ONCE. `assert.equal(..., await res.text())` in the message consumes
  // the body, and the `res.json()` below then throws "Body is unusable" —
  // which reports as a failure of the thing under test rather than of the
  // assertion's own message.
  const body = (await res.json()) as { name: string; origins: string[] };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.name, "Kilnwork (staging)");
  assert.deepEqual(
    body.origins,
    ["https://new.example.com"],
    "REPLACED, not merged — an edit form must be able to remove",
  );
});

test("each field is optional, so the writeMode callers are unchanged", { skip }, async () => {
  const site = await addSite("Mode Only", "https://mode.example.com");
  const res = await app.request(`/api/v1/projects/${site.uid}`, {
    method: "PATCH",
    headers: asOwner(),
    body: JSON.stringify({ writeMode: "open" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { name: string; writeMode: string; origins: string[] };
  assert.equal(body.writeMode, "open");
  assert.equal(body.name, "Mode Only", "and the name it did not mention survives");
  assert.deepEqual(body.origins, ["https://mode.example.com"], "as do the origins");
});

test("a site cannot be left nameless or origin-less", { skip }, async () => {
  // An origin-less site accepts nothing from anywhere, which is a confusing
  // way to discover you have switched your own widget off.
  const site = await addSite("Guarded", "https://guard.example.com");
  for (const bad of [{ name: "  " }, { origins: [] }, {}]) {
    const res = await app.request(`/api/v1/projects/${site.uid}`, {
      method: "PATCH",
      headers: asOwner(),
      body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`);
  }
});

test("DELETE is SOFT — the site goes, the client's words stay", { skip }, async () => {
  const site = await addSite("Doomed", "https://doomed.example.com");
  const res = await app.request(`/api/v1/projects/${site.uid}`, { method: "DELETE", headers: asOwner() });
  assert.equal(res.status, 204);

  const [row] = await sql<{ deleted_at: Date | null }[]>`
    SELECT deleted_at FROM projects WHERE uid = ${site.uid}
  `;
  assert.ok(row?.deleted_at, "the row is marked, not removed — a client's words survive a misclick");

  // Gone from every read, second delete included.
  assert.equal(
    (await app.request(`/api/v1/projects/${site.uid}`, { method: "DELETE", headers: asOwner() })).status,
    404,
  );
});

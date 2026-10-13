import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { inviteRoutes } from "../src/routes/invites.ts";
import { UNLIMITED } from "../src/plan.ts";
import type { Mail } from "../src/mail/index.ts";
import { DASHBOARD_CSRF_COOKIE, DASHBOARD_SESSION_COOKIE, HTTP_HEADER } from "@snagset/types/names";
import { accept, invite, someAddress } from "./join.ts";

/**
 * Member invites. The studio's half (mint, list, revoke, mail) and the
 * invitee's (look up, accept), against a real Postgres, because the property
 * that matters most — one token, one accept, even under a race — is the
 * database's row lock and nothing a stub could show.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL`; drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the invite tests";

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let orgId: string;
let ownerId: string;
const SECRET = Buffer.alloc(32, 9).toString("base64url");
const PASSWORD = "correct horse battery staple";
const json = { "content-type": "application/json" };
type Who = { cookie: string; csrf: string };
const as = (a: Who) => ({ ...json, Cookie: a.cookie, [HTTP_HEADER.csrf]: a.csrf });
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");

async function login(email: string, password = PASSWORD): Promise<Who> {
  const res = await app.request("/auth/login", { method: "POST", headers: json, body: JSON.stringify({ email, password }) });
  const text = await res.text();
  assert.equal(res.status, 200, `login failed: ${text}`);
  return { cookie: cookiesOf(res), csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken };
}

const lookup = (token: string, from = someAddress()) =>
  app.request("/auth/invites/lookup", { method: "POST", headers: { ...json, "x-forwarded-for": from }, body: JSON.stringify({ token }) });

async function mint(owner: Who, body: { role?: string; email?: string } = {}): Promise<{ id: string; token: string; url: string; mail: boolean }> {
  const res = await invite(app, as(owner), body);
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const out = JSON.parse(text) as { invite: { id: string }; token: string; url: string; mail: boolean };
  return { id: out.invite.id, token: out.token, url: out.url, mail: out.mail };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

before(async () => {
  if (skip) return;
  if (URL_ === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  sql = connect(URL_!, { max: 6 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  const cfg = loadConfig({ DATABASE_URL: URL_!, SNAGSET_BASE_URL: "http://localhost:8080" });
  app = createApp({ sql, cfg, secretKey: SECRET, state: "READY", version: "0.0.0-test", commit: "test", sourceUrl: "", modified: false, env: {} });
  orgId = randomUUID();
  ownerId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Kilnwork', 'kilnwork')`;
    await tx`INSERT INTO users (id, org_id, email, name, password_hash, email_verified) VALUES (${ownerId}, ${orgId}, 'owner@kilnwork.test', 'Edith',${hashPassword(PASSWORD)}, true)`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${ownerId}, 'owner')`;
  });
});
after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

test("an owner mints an invite: the link appears once, the list never carries it", { skip }, async () => {
  const owner = await login("owner@kilnwork.test");
  const open = await mint(owner, { role: "admin" });
  const fixed = await mint(owner, { role: "owner", email: "Fixed@Kilnwork.test" });
  assert.match(open.token, /^[A-Za-z0-9_-]{43}$/, "32 bytes, unpadded base64url — the review links' shape");
  assert.equal(open.url, `http://localhost:8080/invite#${open.token}`, "in the fragment, so no log line and no Referer carries it");
  assert.equal(open.mail, false, "no transport, so no mail option");

  const res = await app.request("/api/v1/members/invites", { headers: as(owner) });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(open.token) && !text.includes(fixed.token), "no token in the list");
  const body = JSON.parse(text) as { data: { id: string; role: string; email: string | null; createdBy: { email: string } | null; expiresAt: string; createdAt: string }[]; mail: boolean };
  assert.deepEqual(body.data.map((r) => [r.id, r.role, r.email]), [[fixed.id, "owner", "fixed@kilnwork.test"], [open.id, "admin", null]]);
  assert.equal(body.data[0]!.createdBy?.email, "owner@kilnwork.test");
  const days = (Date.parse(body.data[0]!.expiresAt) - Date.parse(body.data[0]!.createdAt)) / 86_400_000;
  assert.ok(Math.abs(days - 7) < 0.01, `expires in seven days, not ${days}`);

  // Stored as a hash and nothing else.
  const [row] = await sql<{ token_hash: Buffer }[]>`SELECT token_hash FROM member_invites WHERE id = ${open.id}`;
  assert.equal(row!.token_hash.length, 32);
  assert.ok(!row!.token_hash.toString("utf8").includes(open.token));

  // Revoke them both so later tests count from clean.
  for (const id of [open.id, fixed.id]) assert.equal((await app.request(`/api/v1/members/invites/${id}`, { method: "DELETE", headers: as(owner) })).status, 200);
});

test("an invite to an address already in the studio is refused at once, with a sentence", { skip }, async () => {
  const owner = await login("owner@kilnwork.test");
  const res = await invite(app, as(owner), { email: "owner@kilnwork.test" });
  assert.equal(res.status, 409);
  assert.equal(await code(res), "already_a_member");
  const bad = await invite(app, as(owner), { email: "not an email" });
  assert.equal(bad.status, 400);
});

test("accepting signs the person in exactly as /auth/login would, with a membership in the studio", { skip }, async () => {
  const owner = await login("owner@kilnwork.test");
  const inv = await mint(owner, { role: "admin" });

  const seen = await lookup(inv.token);
  assert.equal(seen.status, 200);
  const info = (await seen.json()) as { org: { name: string }; role: string; email: string | null; invitedBy: string };
  assert.deepEqual([info.org.name, info.role, info.email, info.invitedBy], ["Kilnwork", "admin", null, "Edith"]);

  const res = await accept(app, { token: inv.token, name: "Ada Lovelace", email: "Ada@Kilnwork.test", password: "a passphrase of her own" });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const body = JSON.parse(text) as { org: { name: string; slug: string }; user: { email: string; name: string }; role: string; csrfToken: string };
  assert.deepEqual([body.org.slug, body.user.email, body.user.name, body.role], ["kilnwork", "ada@kilnwork.test", "Ada Lovelace", "admin"]);

  // The same two cookies login sets, the CSRF half equal to the body's.
  const set = res.headers.getSetCookie();
  assert.ok(set.some((s) => s.startsWith(`${DASHBOARD_SESSION_COOKIE}=`) && /HttpOnly/.test(s)), "the session cookie, HttpOnly");
  assert.ok(set.some((s) => s.startsWith(`${DASHBOARD_CSRF_COOKIE}=${body.csrfToken};`) && !/HttpOnly/.test(s)), "the CSRF cookie, readable");
  const ada = { cookie: cookiesOf(res), csrf: body.csrfToken };
  const me = await app.request("/api/v1/me", { headers: as(ada) });
  assert.equal(me.status, 200);
  const m = (await me.json()) as { user: { email: string; role: string }; org: { name: string } };
  assert.deepEqual([m.user.email, m.user.role, m.org.name], ["ada@kilnwork.test", "admin", "Kilnwork"]);
  // …and a mutation works with it, which is what the CSRF half is for.
  assert.equal((await app.request("/api/v1/me", { method: "PATCH", headers: as(ada), body: JSON.stringify({ name: "Ada" }) })).status, 200);
  // The password she chose is hers: an ordinary sign-in works.
  await login("ada@kilnwork.test", "a passphrase of her own");

  // In the list, assignable, and the invite is spent.
  const members = (await (await app.request("/api/v1/members", { headers: as(owner) })).json()) as { data: { email: string; role: string }[] };
  assert.ok(members.data.some((r) => r.email === "ada@kilnwork.test" && r.role === "admin"));
  const pending = (await (await app.request("/api/v1/members/invites", { headers: as(owner) })).json()) as { data: unknown[] };
  assert.equal(pending.data.length, 0);
  const [row] = await sql<{ accepted_by: string | null }[]>`SELECT accepted_by FROM member_invites WHERE id = ${inv.id}`;
  assert.ok(row?.accepted_by, "who accepted it is recorded");

  const twice = await accept(app, { token: inv.token, name: "Mallory", email: "mallory@kilnwork.test", password: "another passphrase here" });
  assert.equal(twice.status, 410);
  const err = ((await twice.json()) as { error: { code: string; message: string } }).error;
  assert.equal(err.code, "invite_used");
  assert.match(err.message, /already been used/);
  assert.equal((await lookup(inv.token)).status, 410);
});

test("one token, two browsers, the same instant: exactly one accept wins", { skip }, async () => {
  const owner = await login("owner@kilnwork.test");
  const inv = await mint(owner, { role: "admin" });
  // A real race, not two requests that merely start together: scrypt runs
  // synchronously, so left alone the second accept would usually begin after
  // the first had committed. Hold the invite's row lock from outside until
  // BOTH accepts are parked on their consume, then let go.
  let release!: () => void;
  let held!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const locked = new Promise<void>((r) => (held = r));
  const holder = sql.begin(async (tx) => {
    await tx`SELECT id FROM member_invites WHERE id = ${inv.id} FOR UPDATE`;
    held();
    await gate;
  });
  await locked;
  const both = Promise.all([
    accept(app, { token: inv.token, name: "Racer A", email: "racer-a@kilnwork.test", password: "racing passphrase one" }),
    accept(app, { token: inv.token, name: "Racer B", email: "racer-b@kilnwork.test", password: "racing passphrase two" }),
  ]);
  let waiting = 0;
  for (let i = 0; i < 400 && waiting < 2; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const [w] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query LIKE '%UPDATE member_invites SET accepted_at%'
    `;
    waiting = w!.n;
  }
  assert.equal(waiting, 2, "both accepts reached the consume while the row was held");
  release();
  await holder;
  const [a, b] = await both;
  assert.deepEqual([a.status, b.status].sort(), [201, 410], `${await a.clone().text()} / ${await b.clone().text()}`);
  const loser = a.status === 410 ? a : b;
  assert.equal(await code(loser), "invite_used");
  const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE email LIKE 'racer-%' AND deleted_at IS NULL`;
  assert.equal(n!.n, 1, "the loser's account was rolled back with its accept");
});

test("expired and revoked links say so, and cannot be accepted", { skip }, async () => {
  const owner = await login("owner@kilnwork.test");
  const old = await mint(owner);
  await sql`UPDATE member_invites SET expires_at = now() - interval '1 minute' WHERE id = ${old.id}`;
  const seen = await lookup(old.token);
  assert.equal(seen.status, 410);
  const e = ((await seen.json()) as { error: { code: string; message: string } }).error;
  assert.equal(e.code, "invite_expired");
  assert.match(e.message, /expired on \d{4}-\d{2}-\d{2}/);
  assert.equal(await code(await accept(app, { token: old.token, email: "late@kilnwork.test", password: PASSWORD })), "invite_expired");
  const listed = (await (await app.request("/api/v1/members/invites", { headers: as(owner) })).json()) as { data: { id: string }[] };
  assert.ok(!listed.data.some((r) => r.id === old.id), "an expired invite is not pending");

  const withdrawn = await mint(owner);
  assert.equal((await app.request(`/api/v1/members/invites/${withdrawn.id}`, { method: "DELETE", headers: as(owner) })).status, 200);
  assert.equal((await app.request(`/api/v1/members/invites/${withdrawn.id}`, { method: "DELETE", headers: as(owner) })).status, 404, "revoking twice is not found");
  assert.equal(await code(await lookup(withdrawn.token)), "invite_revoked");
  assert.equal(await code(await accept(app, { token: withdrawn.token, email: "gone@kilnwork.test", password: PASSWORD })), "invite_revoked");

  const nonsense = await lookup("x".repeat(43));
  assert.equal(nonsense.status, 404);
  assert.equal(await code(nonsense), "invite_not_found");
});

test("an invite for one address refuses another, and fills itself in when none is typed", { skip }, async () => {
  const owner = await login("owner@kilnwork.test");
  const inv = await mint(owner, { role: "admin", email: "bea@kilnwork.test" });
  const info = (await (await lookup(inv.token)).json()) as { email: string };
  assert.equal(info.email, "bea@kilnwork.test", "the page shows it rather than asking");
  const wrong = await accept(app, { token: inv.token, email: "someone-else@kilnwork.test", password: PASSWORD });
  assert.equal(wrong.status, 403);
  assert.equal(await code(wrong), "invite_email_mismatch");
  assert.equal((await lookup(inv.token)).status, 200, "a refused accept does not spend the invite");
  const right = await accept(app, { token: inv.token, name: "Bea", password: PASSWORD });
  assert.equal(right.status, 201, await right.clone().text());
  const [u] = await sql<{ email_verified: boolean }[]>`SELECT email_verified FROM users WHERE email = 'bea@kilnwork.test'`;
  assert.equal(u!.email_verified, true, "the owner named the address");
});

test("the accept's own refusals: a short password, an address already in, another site's form", { skip }, async () => {
  const owner = await login("owner@kilnwork.test");
  const inv = await mint(owner);
  const short = await accept(app, { token: inv.token, email: "shorty@kilnwork.test", password: "too short" });
  assert.equal(short.status, 400);
  const member = await accept(app, { token: inv.token, email: "ada@kilnwork.test", password: "a passphrase of her own" });
  assert.equal(member.status, 409);
  assert.equal(await code(member), "already_a_member");
  const cross = await app.request("/auth/invites/accept", {
    method: "POST",
    headers: { ...json, Origin: "https://evil.test", "x-forwarded-for": someAddress() },
    body: JSON.stringify({ token: inv.token, email: "csrf@kilnwork.test", password: PASSWORD }),
  });
  assert.equal(cross.status, 403, "login CSRF: another site cannot sign a browser in");
  assert.equal((await lookup(inv.token)).status, 200, "none of those spent it");
});

test("a person with an account in another studio joins with that account, not a second one", { skip }, async () => {
  // Elsewhere, and its person, made directly: a second studio on the instance.
  const otherOrg = randomUUID();
  const carlaId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${otherOrg}, 'Elsewhere', 'elsewhere')`;
    await tx`INSERT INTO users (id, org_id, email, name, password_hash, email_verified) VALUES (${carlaId}, ${otherOrg}, 'carla@elsewhere.test', 'Carla', ${hashPassword(PASSWORD)}, true)`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${otherOrg}, ${carlaId}, 'owner')`;
  });
  const owner = await login("owner@kilnwork.test");
  const inv = await mint(owner, { role: "admin", email: "carla@elsewhere.test" });

  const wrong = await accept(app, { token: inv.token, name: "Not Carla", password: "a brand new password" });
  assert.equal(wrong.status, 409);
  const err = ((await wrong.json()) as { error: { code: string; message: string } }).error;
  assert.equal(err.code, "account_exists");
  assert.match(err.message, /Enter its password/);

  const ok = await accept(app, { token: inv.token, password: PASSWORD });
  assert.equal(ok.status, 201, await ok.clone().text());
  const carla = { cookie: cookiesOf(ok), csrf: ((await ok.json()) as { csrfToken: string }).csrfToken };
  const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE email = 'carla@elsewhere.test'`;
  assert.equal(n!.n, 1, "one account");
  const me = (await (await app.request("/api/v1/me", { headers: as(carla) })).json()) as { org: { name: string }; user: { name: string; role: string }; orgs: { slug: string; current: boolean }[] };
  assert.equal(me.org.name, "Kilnwork", "signed in to the studio that invited her");
  assert.equal(me.user.name, "Carla", "her name is her account's, not what the form said");
  assert.deepEqual(me.orgs.map((o) => [o.slug, o.current]), [["kilnwork", true], ["elsewhere", false]]);

  // Removed from Kilnwork, she keeps Elsewhere — and can still sign in.
  const out = await app.request("/api/v1/members/carla%40elsewhere.test", { method: "DELETE", headers: as(owner) });
  assert.equal(out.status, 200, await out.clone().text());
  assert.equal((await app.request("/api/v1/me", { headers: as(carla) })).status, 401, "her Kilnwork session ended");
  const again = await login("carla@elsewhere.test");
  const after_ = (await (await app.request("/api/v1/me", { headers: as(again) })).json()) as { org: { name: string }; orgs: unknown[] };
  assert.equal(after_.org.name, "Elsewhere");
  assert.equal(after_.orgs.length, 1);
});

test("removing somebody from their HOME studio re-homes them to the one they are still in", { skip }, async () => {
  // Dan is invited to Kilnwork (his home, then) and later joins Elsewhere.
  const owner = await login("owner@kilnwork.test");
  const first = await mint(owner, { email: "dan@kilnwork.test" });
  assert.equal((await accept(app, { token: first.token, name: "Dan", password: PASSWORD })).status, 201);
  const carla = await login("carla@elsewhere.test");
  const second = await mint(carla, { email: "dan@kilnwork.test" });
  assert.equal((await accept(app, { token: second.token, password: PASSWORD })).status, 201);

  assert.equal((await app.request("/api/v1/members/dan%40kilnwork.test", { method: "DELETE", headers: as(owner) })).status, 200);
  const dan = await login("dan@kilnwork.test");
  const me = (await (await app.request("/api/v1/me", { headers: as(dan) })).json()) as { org: { name: string } };
  assert.equal(me.org.name, "Elsewhere", "sign-in lands in the studio he is still in");
});

test("the public routes are rate-limited per address", { skip }, async () => {
  const from = "203.0.113.77";
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await lookup("y".repeat(43), from)).status;
  assert.equal(last, 429);
  const blocked = await accept(app, { token: "y".repeat(43), email: "z@kilnwork.test", password: PASSWORD }, from);
  assert.equal(blocked.status, 429, "the accept shares the budget");
  assert.equal((await lookup("y".repeat(43), "203.0.113.78")).status, 404, "another address is unaffected");
});

test("mailing the link: sent inline, only with the link it was shown, with the provider's sentence on failure", { skip }, async () => {
  const sent: Mail[] = [];
  let fail = false;
  const routes = inviteRoutes({
    sql,
    limits: async () => ({ ...UNLIMITED, source: "default" }),
    address: async () => "https://snag.kilnwork.test/",
    mailer: async () => ({
      kind: "http",
      from: "studio@kilnwork.test",
      send: async (m: Mail) => {
        if (fail) throw new Error("resend said no (403): domain not verified");
        sent.push(m);
        return { id: "msg_1" };
      },
    }),
    origin: "https://snag.kilnwork.test",
    secure: true,
  });
  // The router alone, with the claims the session middleware would stamp.
  const mailApp = new Hono();
  mailApp.use("*", async (c, next) => {
    c.set("requestId" as never, "r1" as never);
    c.set("owner" as never, { userId: ownerId, orgId, email: "owner@kilnwork.test", name: "Edith", sessionId: "s1", role: "owner" } as never);
    await next();
  });
  mailApp.route("/", routes);
  const post = (path: string, body: unknown) => mailApp.request(path, { method: "POST", headers: json, body: JSON.stringify(body) });

  const made = await post("/api/v1/members/invites", { role: "admin", email: "fran@kilnwork.test" });
  assert.equal(made.status, 201);
  const inv = (await made.json()) as { invite: { id: string }; token: string; url: string; mail: boolean };
  assert.equal(inv.mail, true, "a transport is connected, so the dialog offers it");
  assert.equal(inv.url, `https://snag.kilnwork.test/invite#${inv.token}`);

  const forged = await post(`/api/v1/members/invites/${inv.invite.id}/send`, { token: "z".repeat(43) });
  assert.equal(forged.status, 403, "only the link this invite was minted with");
  const ok = await post(`/api/v1/members/invites/${inv.invite.id}/send`, { token: inv.token });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "fran@kilnwork.test");
  assert.match(sent[0]!.subject, /Edith invited you to Kilnwork/);
  assert.ok(sent[0]!.text.includes(inv.url), "the mail carries the link");
  const [queued] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE event::text LIKE ${"%" + inv.token + "%"}`;
  assert.equal(queued!.n, 0, "never queued: the outbox would keep the link at rest");

  fail = true;
  const bounced = await post(`/api/v1/members/invites/${inv.invite.id}/send`, { token: inv.token });
  assert.equal(bounced.status, 502);
  assert.match(((await bounced.json()) as { error: { message: string } }).error.message, /domain not verified/);

  const open = await post("/api/v1/members/invites", { role: "admin" });
  const o = (await open.json()) as { invite: { id: string }; token: string };
  fail = false;
  const nowhere = await post(`/api/v1/members/invites/${o.invite.id}/send`, { token: o.token });
  assert.equal(nowhere.status, 400, "an invite with no address has nowhere to go");
});

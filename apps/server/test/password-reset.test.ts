import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { rlsStatus } from "../src/db/rls.ts";
import { createApp } from "../src/app.ts";
import { runDueJobs } from "../src/jobs/index.ts";
import { expireRows } from "../src/jobs/reaper.ts";
import { mailboxOf } from "../src/routes/passwordReset.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { HTTP_HEADER } from "@snagset/types/names";
import { startInbox, type Inbox } from "./inbox.ts";
import { someAddress } from "./join.ts";

/**
 * A forgotten password, by a mailed link — and the three faults in
 * what was already there that building it turned up: a sign-in that outlived
 * a change of password, a studio address chosen twice, and a typed address
 * recorded as checked.
 *
 * Run the way a secured deployment runs, because that is where a forgotten
 * claim costs something: the WHOLE app, on a role that cannot bypass
 * row-level security, mailing through the real SMTP transport into a mailbox
 * this file can read. So a query that forgot its claim fails here, a link
 * that was never put on the wire fails here, and nothing below is seeded:
 * every account, link and session arrives through the route a person would
 * use. The two races are staged rather than hoped for.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL`; drops the schema. The URL
 * must be a superuser's (it creates the role and grants the tables).
 */

const ADMIN = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = ADMIN ? false : "set SNAGSET_TEST_DATABASE_URL to run the password-reset suite";
const ROLE = "snagset_reset_test";
const BASE = "https://studio.kilnwork.test";

let admin: postgres.Sql;
let sql: postgres.Sql;
let inbox: Inbox;
/** Sign-up open and a transport in the environment. */
let app: ReturnType<typeof createApp>;
/** The same instance with no transport. */
let quiet: ReturnType<typeof createApp>;
let build: (extra: Record<string, string>) => ReturnType<typeof createApp>;

const SECRET = Buffer.alloc(32, 14).toString("base64url");
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new passphrase";
const json = { "content-type": "application/json" };
type Who = { cookie: string; csrf: string };
const as = (a: Who) => ({ ...json, Cookie: a.cookie, [HTTP_HEADER.csrf]: a.csrf });
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** A public POST, each from its own made-up caller unless the test is about the caller. */
const post = (to: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve(to.request(path, { method: "POST", headers: { ...json, "x-forwarded-for": someAddress(), ...headers }, body: JSON.stringify(body) }));
const code = async (res: Response): Promise<string> => ((await res.json()) as { error?: { code?: string } }).error?.code ?? "";
const ask = (email: string, headers: Record<string, string> = {}) => post(app, "/auth/reset/request", { email }, headers);
const login = (email: string, password: string) => post(app, "/auth/login", { email, password });

/** The budgets are hourly and the suite is not: each test starts with none spent. */
const fresh = async (): Promise<void> => {
  await admin`DELETE FROM rate_counters`;
  inbox.messages.length = 0;
};

/**
 * Resolves once some query on this database is waiting for a lock. The races
 * below are staged: this file holds a row from its admin connection, starts
 * the request, waits until the request is really queued behind that row, and
 * only then lets go.
 */
const untilBlocked = async (): Promise<void> => {
  const end = Date.now() + 5000;
  for (;;) {
    const [w] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if (w!.n > 0) return;
    if (Date.now() > end) throw new Error("nothing queued behind the lock within five seconds");
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** The token out of a mailed link, which travels in the fragment. */
const tokenIn = (text: string): string => {
  const hit = new RegExp(`${BASE}/reset#([A-Za-z0-9_-]{43})`).exec(text);
  assert.ok(hit, `the mail carries a reset link on the instance's own address:\n${text}`);
  return hit[1]!;
};

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && ADMIN === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  admin = connect(ADMIN!, { max: 2 });
  await admin`DROP SCHEMA IF EXISTS public CASCADE`;
  await admin`CREATE SCHEMA public`;
  await migrate(admin, () => {});
  await admin.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
      CREATE ROLE ${ROLE} LOGIN PASSWORD 'reset' NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$`);
  // CREATE as well as USAGE, as a secured deployment's role needs: the jobs
  // runner makes its own bookkeeping table the first time it is asked to run.
  await admin.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE}`);
  await admin.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  await admin.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
  await admin.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROLE}`);
  const u = new URL(ADMIN!);
  u.username = ROLE;
  u.password = "reset";
  sql = connect(u.toString(), { max: 4 });
  inbox = await startInbox();
  build = (extra) =>
    createApp({
      sql,
      cfg: loadConfig({ SNAGSET_TRUST_PROXY: "1", DATABASE_URL: u.toString(), SNAGSET_SECRET_KEY: SECRET, SNAGSET_BASE_URL: BASE, SNAGSET_SIGNUP_OPEN: "true", ...extra }),
      secretKey: SECRET,
      state: "READY",
      version: "0.0.0-test",
      commit: "test",
      sourceUrl: "https://example.test",
      modified: false,
      env: {},
    });
  app = build({ SNAGSET_MAIL_URL: inbox.url, SNAGSET_MAIL_FROM: "studio@kilnwork.test" });
  quiet = build({});
});

after(async () => {
  await inbox?.close();
  await sql?.end({ timeout: 5 });
  if (!skip) {
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
  }
  await admin?.end({ timeout: 5 });
});

test("the role cannot bypass, and the new table is policed like every other", { skip }, async () => {
  const st = await rlsStatus(sql);
  assert.equal(st.roleBypassesRls, false);
  assert.deepEqual(st.unprotected, []);
  assert.deepEqual(st.notForced, []);
  assert.equal(st.effective, true, st.warning ?? "");
});

test("a sign-up is one step, and the address it was typed with is recorded as unchecked", { skip }, async () => {
  const res = await post(app, "/auth/register", { email: "ada@kilnwork.test", password: PASSWORD, orgName: "Kilnwork", name: "Ada" });
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(inbox.messages.length, 0, "nothing was mailed for it");
  // Typed, not proven: until 2026-11-10 this was written `true`.
  const [u] = await admin<{ email_verified: boolean }[]>`SELECT email_verified FROM users WHERE email = 'ada@kilnwork.test'`;
  assert.equal(u!.email_verified, false);
});

test("the signed-out pages are told what this instance can do, and where sign-up lives when it is not here", { skip }, async () => {
  assert.deepEqual(await (await app.request("/api/v1/setup")).json(), { claimed: true, signup: true, mail: true, signupUrl: null, billingUrl: null, closeUrl: null, cloud: false });
  assert.deepEqual(await (await quiet.request("/api/v1/setup")).json(), { claimed: true, signup: true, mail: false, signupUrl: null, billingUrl: null, closeUrl: null, cloud: false });
  const elsewhere = build({ SNAGSET_SIGNUP_URL: "https://studio.kilnwork.test/sign-up" });
  assert.equal(((await (await elsewhere.request("/api/v1/setup")).json()) as { signupUrl: string }).signupUrl, "https://studio.kilnwork.test/sign-up");
  const sells = build({ SNAGSET_BILLING_URL: "https://studio.kilnwork.test/billing" });
  assert.equal(((await (await sells.request("/api/v1/setup")).json()) as { billingUrl: string }).billingUrl, "https://studio.kilnwork.test/billing");
  const closes = build({ SNAGSET_CLOSE_URL: "https://studio.kilnwork.test/close-studio" });
  assert.equal(((await (await closes.request("/api/v1/setup")).json()) as { closeUrl: string }).closeUrl, "https://studio.kilnwork.test/close-studio");
});

test("a reset for an address with no account gets the same answer, and nothing is mailed or stored", { skip }, async () => {
  await fresh();
  const res = await ask("nobody@kilnwork.test");
  assert.equal(res.status, 202, await res.clone().text());
  assert.deepEqual(await res.json(), { ok: true });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(inbox.messages.length, 0);
  const [n] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM password_resets`;
  assert.equal(n!.n, 0);

  const bad = await ask("not an address");
  assert.equal(bad.status, 400);
  assert.equal(await code(bad), "validation_failed");
});

test("a reset link is mailed, sets the password once, signs the person in and everybody else out", { skip }, async () => {
  await fresh();
  const before = await login("ada@kilnwork.test", PASSWORD);
  assert.equal(before.status, 200, await before.clone().text());
  const old: Who = { cookie: cookiesOf(before), csrf: ((await before.json()) as { csrfToken: string }).csrfToken };

  const asked = await ask(" Ada@Kilnwork.test ");
  assert.equal(asked.status, 202, await asked.clone().text());
  assert.deepEqual(await asked.json(), { ok: true }, "the same body as for an address with no account");
  await inbox.until(1);
  const mail = inbox.messages[0]!;
  assert.equal(mail.to, "ada@kilnwork.test");
  assert.equal(mail.subject, "Reset your Snagset password");
  assert.match(mail.text, /studio\.kilnwork\.test/);
  const token = tokenIn(mail.text);

  // The row holds the hash, and nothing anywhere holds the token.
  const [row] = await admin<{ token_hash: Buffer; email: string; ttl: number }[]>`
    SELECT token_hash, email, extract(epoch FROM expires_at - created_at)::int AS ttl FROM password_resets
  `;
  assert.equal(row!.email, "ada@kilnwork.test");
  // An hour, give or take the two clocks (this process minted the expiry, the database stamped the creation).
  assert.ok(Math.abs(row!.ttl - 3600) < 120, `an hour, not ${row!.ttl}s`);
  assert.ok(Buffer.compare(row!.token_hash, sha256(token)) === 0);
  const [queued] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE event::text LIKE ${"%" + token + "%"}`;
  assert.equal(queued!.n, 0, "never queued: the outbox would keep the link at rest");

  const seen = await post(app, "/auth/reset/lookup", { token });
  assert.equal(seen.status, 200, await seen.clone().text());
  assert.equal(((await seen.json()) as { email: string }).email, "ada@kilnwork.test");

  const short = await post(app, "/auth/reset/confirm", { token, password: "too short" });
  assert.equal(short.status, 400);
  assert.equal(await code(short), "validation_failed");

  const done = await post(app, "/auth/reset/confirm", { token, password: NEW_PASSWORD });
  assert.equal(done.status, 200, await done.clone().text());
  const body = (await done.clone().json()) as { user: { email: string; name: string }; csrfToken: string };
  assert.deepEqual(body.user, { email: "ada@kilnwork.test", name: "Ada" });
  const now: Who = { cookie: cookiesOf(done), csrf: body.csrfToken };
  const me = await app.request("/api/v1/me", { headers: as(now) });
  assert.equal(me.status, 200, "the confirm signed her in");
  assert.equal(((await me.json()) as { org: { name: string } }).org.name, "Kilnwork");

  assert.equal((await app.request("/api/v1/me", { headers: as(old) })).status, 401, "the session opened with the old password is gone");
  assert.equal((await login("ada@kilnwork.test", PASSWORD)).status, 401, "the old password is dead");
  assert.equal((await login("ada@kilnwork.test", NEW_PASSWORD)).status, 200, "the new one works");
  // The mailbox is proven now, whatever the column said before.
  const [u] = await admin<{ email_verified: boolean }[]>`SELECT email_verified FROM users WHERE email = 'ada@kilnwork.test'`;
  assert.equal(u!.email_verified, true);

  const twice = await post(app, "/auth/reset/confirm", { token, password: "yet another passphrase" });
  assert.equal(twice.status, 410);
  assert.equal(await code(twice), "link_used");
  assert.equal(await code(await post(app, "/auth/reset/lookup", { token })), "link_used");
  assert.equal((await login("ada@kilnwork.test", NEW_PASSWORD)).status, 200, "and the second try changed nothing");
});

test("a second link dies with the password it would have replaced; an expired one and a made-up one say so", { skip }, async () => {
  await fresh();
  await ask("ada@kilnwork.test");
  await ask("ada@kilnwork.test");
  await inbox.until(2);
  const [first, second] = inbox.messages.map((m) => tokenIn(m.text));
  assert.notEqual(first, second);
  assert.equal((await post(app, "/auth/reset/confirm", { token: first, password: PASSWORD })).status, 200);
  const late = await post(app, "/auth/reset/confirm", { token: second, password: "the attacker's passphrase" });
  assert.equal(late.status, 410);
  assert.equal(await code(late), "link_used");
  assert.equal((await login("ada@kilnwork.test", PASSWORD)).status, 200);

  await ask("ada@kilnwork.test");
  await inbox.until(3);
  const stale = tokenIn(inbox.messages[2]!.text);
  await admin`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE token_hash = ${sha256(stale)}`;
  const expired = await post(app, "/auth/reset/confirm", { token: stale, password: NEW_PASSWORD });
  assert.equal(expired.status, 410);
  assert.equal(await code(expired), "link_expired");

  const unknown = await post(app, "/auth/reset/lookup", { token: "z".repeat(43) });
  assert.equal(unknown.status, 404);
  assert.equal(await code(unknown), "link_not_found");
});

test("a mailbox gets three an hour and then silence; a caller gets ten and then a 429; another site gets nothing", { skip }, async () => {
  await fresh();
  for (let i = 0; i < 5; i++) {
    const res = await ask("ada@kilnwork.test");
    assert.equal(res.status, 202, "the fourth and fifth are answered exactly as the first");
  }
  await inbox.until(3);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(inbox.messages.length, 3, "and three were sent");

  // Requests that mail nobody spend no mailbox's count: only a mail does.
  await fresh();
  for (let i = 0; i < 4; i++) await ask("somebody-else@kilnwork.test");
  const [counted] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM rate_counters WHERE bucket_key LIKE 'reset:to:%'`;
  assert.equal(counted!.n, 0);

  await fresh();
  const one = { "x-forwarded-for": "203.0.113.9" };
  for (let i = 0; i < 10; i++) assert.equal((await ask(`nobody-${i}@kilnwork.test`, one)).status, 202);
  const eleventh = await ask("nobody-11@kilnwork.test", one);
  assert.equal(eleventh.status, 429);
  assert.equal(await code(eleventh), "quota_exceeded");
  assert.equal((await ask("nobody-12@kilnwork.test")).status, 202, "another caller is untouched");

  await fresh();
  const evil = { Origin: "https://evil.test" };
  assert.equal((await ask("ada@kilnwork.test", evil)).status, 403);
  assert.equal((await post(app, "/auth/reset/confirm", { token: "z".repeat(43), password: NEW_PASSWORD }, evil)).status, 403);
});

test("an address built to make the pattern backtrack is refused by its length, before anything reads it closely", { skip }, async () => {
  // `/auth/reset/request` answers anybody. 200 KB of `a@.a.a.a…@` read by
  // the pattern held one request for a quarter of a minute.
  const began = performance.now();
  const res = await ask(`a@${".a".repeat(100_000)}@`, { "x-forwarded-for": "198.51.100.98" });
  assert.equal(res.status, 400);
  assert.equal(await code(res), "validation_failed");
  assert.ok(performance.now() - began < 2_000, `answered in ${Math.round(performance.now() - began)} ms`);
});

test("one inbox is one mailbox where it is known to be one, and nobody's count is spent by mail they never see", { skip }, async () => {
  // Gmail is where two spellings are KNOWN to be one inbox: a tag after `+`,
  // and dots anywhere. A tag is a provider's feature, not a rule of mail.
  assert.equal(mailboxOf("z.e.d+x@gmail.com"), "zed@gmail.com");
  assert.equal(mailboxOf("z.e.d@googlemail.com"), "zed@gmail.com");
  assert.equal(mailboxOf("zed+one@elsewhere.test"), "zed+one@elsewhere.test", "a tag is folded only where it is known to be one inbox");
  assert.equal(mailboxOf("z.e.d@elsewhere.test"), "z.e.d@elsewhere.test", "and so are dots");
  assert.equal(mailboxOf("+odd@gmail.com"), "+odd@gmail.com", "a local part that IS a tag is left alone");

  // Two accounts, one Gmail inbox: four requests between them are three mails, not four.
  for (const tag of ["a", "b"]) {
    const made = await post(quiet, "/auth/register", { email: `zed+${tag}@gmail.com`, password: PASSWORD, orgName: `Zed ${tag}` });
    assert.equal(made.status, 201, await made.clone().text());
  }
  await fresh();
  for (const tag of ["a", "b", "a", "b"]) assert.equal((await ask(`zed+${tag}@gmail.com`)).status, 202);
  await inbox.until(3);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(inbox.messages.length, 3);

  // Folding a tag everywhere was a way to lock somebody out of their own
  // reset. Where `victim+1@corp` is NOT delivered to `victim@corp`, whoever
  // holds an account spelled that way spent the other person's three an
  // hour on mail that person never saw.
  for (const address of ["victim@corp.test", "victim+1@corp.test"]) {
    const made = await post(quiet, "/auth/register", { email: address, password: PASSWORD, orgName: address });
    assert.equal(made.status, 201, await made.clone().text());
  }
  await fresh();
  for (let i = 0; i < 3; i++) assert.equal((await ask("victim+1@corp.test", { "x-forwarded-for": "198.51.100.61" })).status, 202);
  await inbox.until(3);
  assert.equal((await ask("victim@corp.test", { "x-forwarded-for": "198.51.100.62" })).status, 202);
  await inbox.until(4);
  assert.deepEqual(inbox.messages.map((m) => m.to).slice(-1), ["victim@corp.test"], "the person whose address it is still gets their link");
});

test("two reset links for one account, confirmed at once: one sets the password and the other says it was used", { skip }, async () => {
  await fresh();
  await ask("ada@kilnwork.test");
  await ask("ada@kilnwork.test");
  await inbox.until(2);
  const [a, b] = inbox.messages.map((m) => tokenIn(m.text));
  // Each confirm used to lock its own link and then reach for the other's;
  // Postgres ended one of them as a deadlock, which reached the person as a 500.
  const [one, two] = await Promise.all([
    post(app, "/auth/reset/confirm", { token: a, password: "passphrase number one" }),
    post(app, "/auth/reset/confirm", { token: b, password: "passphrase number two" }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 410], `${await one.clone().text()} / ${await two.clone().text()}`);
  assert.equal(await code(one.status === 410 ? one : two), "link_used");
  await admin`UPDATE users SET password_hash = ${hashPassword(PASSWORD)} WHERE email = 'ada@kilnwork.test'`;
});

test("a reset signs the widget out too: a member's widget session from before it is refused", { skip }, async () => {
  await fresh();
  const signed = await login("ada@kilnwork.test", PASSWORD);
  assert.equal(signed.status, 200, await signed.clone().text());
  const ada: Who = { cookie: cookiesOf(signed), csrf: ((await signed.json()) as { csrfToken: string }).csrfToken };
  const site = await app.request("/api/v1/projects", { method: "POST", headers: as(ada), body: JSON.stringify({ name: "Kilnwork site", domain: "kilnwork.test" }) });
  assert.equal(site.status, 201, await site.clone().text());
  const uid = ((await site.json()) as { uid: string }).uid;
  const SITE = "https://kilnwork.test";
  const minted = await app.request(`/api/v1/projects/${uid}/sessions/member`, { method: "POST", headers: as(ada), body: JSON.stringify({ origin: SITE }) });
  assert.equal(minted.status, 201, await minted.clone().text());
  const widget = ((await minted.json()) as { sessionToken: string }).sessionToken;
  const refresh = () =>
    app.request(`/api/v1/projects/${uid}/sessions`, { method: "POST", headers: { ...json, Authorization: `Bearer ${widget}`, Origin: SITE }, body: "{}" });
  assert.equal((await refresh()).status, 200, "the widget session works before the reset");

  await ask("ada@kilnwork.test");
  await inbox.until(1);
  // A token's `iat` is in whole seconds and the sign-out is an instant: let the second turn, as a person's reading of the mail does.
  await new Promise((r) => setTimeout(r, 1100));
  const done = await post(app, "/auth/reset/confirm", { token: tokenIn(inbox.messages[0]!.text), password: PASSWORD });
  assert.equal(done.status, 200, await done.clone().text());

  const after = await refresh();
  assert.equal(after.status, 401, await after.clone().text());
  assert.equal(await code(after), "session_revoked");
});

test("a sign-in already in flight when the password changes gets no session", { skip }, async () => {
  // Staged, not raced: the admin connection changes the password and holds
  // the row; the sign-in reads the OLD hash, verifies against it, and queues
  // behind that row; then the change commits. The sign-in must look again.
  let pending!: Promise<Response>;
  const [{ at: before } = { at: new Date() }] = await admin<{ at: Date }[]>`SELECT now() AS at`;
  await admin.begin(async (tx) => {
    await tx`UPDATE users SET password_hash = ${hashPassword("changed while you were signing in")} WHERE email = 'ada@kilnwork.test'`;
    pending = login("ada@kilnwork.test", PASSWORD);
    await untilBlocked();
  });
  const res = await pending;
  assert.equal(res.status, 401, await res.clone().text());
  assert.equal(await code(res), "invalid_credentials");
  assert.equal(res.headers.getSetCookie().length, 0, "and no cookie was set");
  const [open] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE u.email = 'ada@kilnwork.test' AND s.created_at >= ${before}
  `;
  assert.equal(open!.n, 0, "no session row was made for it, revoked or not");
  await admin`UPDATE users SET password_hash = ${hashPassword(PASSWORD)} WHERE email = 'ada@kilnwork.test'`;
  assert.equal((await login("ada@kilnwork.test", PASSWORD)).status, 200, "and an ordinary sign-in is what it was");
});

test("two studios that choose one address at once are both made, and nobody is told their email is taken", { skip }, async () => {
  // Staged the same way: another studio takes `slug-race` and holds it
  // uncommitted; the sign-up reads the list (which does not show it yet),
  // chooses the same slug, and queues behind it; then the other commits.
  let pending!: Promise<Response>;
  await admin.begin(async (tx) => {
    await tx`INSERT INTO orgs (id, name, slug, plan) VALUES (gen_random_uuid(), 'The other one', 'slug-race', 'selfhost')`;
    pending = post(quiet, "/auth/register", { email: "hal@elsewhere.test", password: PASSWORD, orgName: "Slug race" });
    await untilBlocked();
  });
  const res = await pending;
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(((await res.json()) as { org: { slug: string } }).org.slug, "slug-race-2");
  // And the sentence about an email is still said when it IS the email.
  const again = await post(quiet, "/auth/register", { email: "hal@elsewhere.test", password: PASSWORD, orgName: "Hal again" });
  assert.equal(again.status, 409);
  assert.equal(await code(again), "email_taken");
});

test("a half-set mail environment is an instance that cannot mail, not one that cannot answer", { skip }, async () => {
  // The bin refuses to boot like this; a serverless deploy only meets it at request time.
  const broken = build({ SNAGSET_MAIL_URL: inbox.url });
  const res = await broken.request("/api/v1/setup");
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { claimed: true, signup: true, mail: false, signupUrl: null, billingUrl: null, closeUrl: null, cloud: false });
  assert.equal(await code(await post(broken, "/auth/reset/request", { email: "ada@kilnwork.test" })), "integration_not_configured");
});

test("with no transport nothing is offered, and the shell command is what there is", { skip }, async () => {
  await fresh();
  const reset = await post(quiet, "/auth/reset/request", { email: "ada@kilnwork.test" });
  assert.equal(reset.status, 409, await reset.clone().text());
  const said = ((await reset.json()) as { error: { code: string; message: string } }).error;
  assert.equal(said.code, "integration_not_configured");
  assert.match(said.message, /snagset passwd/);
  assert.equal(inbox.messages.length, 0);
});

test("the reaper keeps a spent link for a day, so yesterday's mail says why, and then removes it", { skip }, async () => {
  const [{ n: had } = { n: 0 }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM password_resets`;
  assert.ok(had > 0, "the tests above left links behind");
  await admin`UPDATE password_resets SET expires_at = now() - interval '23 hours'`;
  await runDueJobs(sql, [expireRows], { budgetMs: 5000, now: () => new Date() });
  const [{ n: kept } = { n: 0 }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM password_resets`;
  assert.equal(kept, had, "23 hours past its expiry: still there to answer for itself");

  await admin`UPDATE password_resets SET expires_at = now() - interval '25 hours'`;
  // Sixteen minutes on: the job is due again (it runs every fifteen).
  await runDueJobs(sql, [expireRows], { budgetMs: 5000, now: () => new Date(Date.now() + 16 * 60_000) });
  const [{ n: left } = { n: 0 }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM password_resets`;
  assert.equal(left, 0, "deleted on the role that cannot bypass, under the job's own claim");
});

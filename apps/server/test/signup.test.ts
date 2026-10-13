import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { isClaimed } from "../src/boot.ts";
import { createApp } from "../src/app.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * Sign-up, the switcher and the second studio. Two apps
 * on one database: `open` carries `SNAGSET_SIGNUP_OPEN=true` the way the
 * cloud will, `closed` carries nothing the way every self-host does. Starts
 * on an EMPTY schema, because the first sign-up on an unclaimed instance is
 * its claim. Skipped without `SNAGSET_TEST_DATABASE_URL`; drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the sign-up tests";

let sql: postgres.Sql;
let open: ReturnType<typeof createApp>;
let closed: ReturnType<typeof createApp>;
const SECRET = Buffer.alloc(32, 11).toString("base64url");
const PASSWORD = "correct horse battery staple";
const json = { "content-type": "application/json" };
type Who = { cookie: string; csrf: string };
const as = (a: Who) => ({ ...json, Cookie: a.cookie, [HTTP_HEADER.csrf]: a.csrf });
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");

function build(env: Record<string, string>) {
  return createApp({
    sql,
    cfg: loadConfig({ DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET, SNAGSET_BASE_URL: "https://cloud.snagset.test", ...env }),
    secretKey: SECRET,
    state: "READY",
    version: "0.0.0-test",
    commit: "test",
    sourceUrl: "https://example.test",
    modified: false,
    env: {},
  });
}
const register = (app: ReturnType<typeof createApp>, body: Record<string, unknown>, ip = "198.51.100.7") =>
  app.request("/auth/register", { method: "POST", headers: { ...json, "x-forwarded-for": ip }, body: JSON.stringify(body) });
const me = async (app: ReturnType<typeof createApp>, who: Who) => {
  const res = await app.request("/api/v1/me", { headers: as(who) });
  return { status: res.status, body: (await res.json()) as any };
};

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  open = build({ SNAGSET_SIGNUP_OPEN: "true" });
  closed = build({});
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

let ada: Who;
let adaSecond: Who;

test("closed is every self-host: the door answers 403 registration_closed, and the front door says so", { skip }, async () => {
  const res = await register(closed, { email: "ada@kilnwork.test", password: PASSWORD, orgName: "Kilnwork" });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as any).error.code, "registration_closed");
  assert.deepEqual(await (await closed.request("/api/v1/setup")).json(), { claimed: false, signup: false });
  assert.deepEqual(await (await open.request("/api/v1/setup")).json(), { claimed: false, signup: true });
});

test("open: a stranger's studio — validated, made in one transaction with its owner, site and session, and the first one claims the instance", { skip }, async () => {
  const short = await register(open, { email: "ada@kilnwork.test", password: "short" });
  assert.equal(short.status, 400);
  assert.equal(((await short.json()) as any).error.details.field, "password");
  const bad = await register(open, { email: "not-an-email", password: PASSWORD });
  assert.equal(((await bad.json()) as any).error.details.field, "email");

  const res = await register(open, { email: "Ada@Kilnwork.test", password: PASSWORD, name: "Ada", orgName: "Kilnwork" });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as any;
  assert.deepEqual(body.org, { name: "Kilnwork", slug: "kilnwork" });
  assert.equal(body.user.email, "ada@kilnwork.test", "lower-cased, like every other door");
  assert.match(body.project.uid, /^prj_/);
  assert.equal(body.project.keyPrefix, "SN");
  const cookie = cookiesOf(res);
  assert.match(cookie, /snag/);
  ada = { cookie, csrf: body.csrfToken };
  assert.equal(await isClaimed(sql), true, "the first studio is the claim");
  assert.equal(((await (await open.request("/api/v1/setup")).json()) as any).claimed, true);

  const m = await me(open, ada);
  assert.equal(m.status, 200);
  assert.equal(m.body.user.name, "Ada");
  assert.equal(m.body.org.slug, "kilnwork");
  assert.deepEqual(m.body.orgs, [{ slug: "kilnwork", name: "Kilnwork", role: "owner", current: true }]);
  assert.equal(m.body.signupOpen, true);
  assert.equal(m.body.projects.length, 1);
  assert.equal(m.body.limits.members.used, 1);
});

test("the same email is a 409 email_taken; the same studio name is a second slug", { skip }, async () => {
  const dup = await register(open, { email: "ada@kilnwork.test", password: PASSWORD });
  assert.equal(dup.status, 409);
  assert.equal(((await dup.json()) as any).error.code, "email_taken");
  const bob = await register(open, { email: "bob@elsewhere.test", password: PASSWORD, orgName: "Kilnwork" });
  assert.equal(bob.status, 201, await bob.clone().text());
  assert.equal(((await bob.json()) as any).org.slug, "kilnwork-2");
});

test("a second studio for a signed-in person: made, owned, moved to; the old session is gone; closed refuses", { skip }, async () => {
  const login = await open.request("/auth/login", { method: "POST", headers: json, body: JSON.stringify({ email: "ada@kilnwork.test", password: PASSWORD }) });
  assert.equal(login.status, 200, "the password set at sign-up signs in");

  const made = await open.request("/api/v1/orgs", { method: "POST", headers: as(ada), body: JSON.stringify({ name: "Second" }) });
  assert.equal(made.status, 201, await made.clone().text());
  const body = (await made.json()) as any;
  assert.deepEqual(body.org, { name: "Second", slug: "second" });
  adaSecond = { cookie: cookiesOf(made), csrf: body.csrfToken };

  const m = await me(open, adaSecond);
  assert.equal(m.body.org.slug, "second");
  assert.deepEqual(m.body.orgs.map((o: any) => [o.slug, o.role, o.current]), [["kilnwork", "owner", false], ["second", "owner", true]]);
  assert.equal(m.body.projects.length, 1, "its own first site, not Kilnwork's");
  assert.equal((await me(open, ada)).status, 401, "the session that made it was moved, not copied");

  const refused = await closed.request("/api/v1/orgs", { method: "POST", headers: as(adaSecond), body: JSON.stringify({ name: "Third" }) });
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as any).error.code, "registration_closed");
});

test("the switcher: back to the first studio, never to one you are not in — and it needs no flag", { skip }, async () => {
  const back = await closed.request("/auth/switch", { method: "POST", headers: as(adaSecond), body: JSON.stringify({ slug: "kilnwork" }) });
  assert.equal(back.status, 200, await back.clone().text());
  const body = (await back.json()) as any;
  assert.equal(body.org.slug, "kilnwork");
  assert.equal(body.role, "owner");
  const who: Who = { cookie: cookiesOf(back), csrf: body.csrfToken };
  assert.equal((await me(closed, who)).body.org.slug, "kilnwork");
  assert.equal((await me(closed, adaSecond)).status, 401);

  for (const slug of ["kilnwork-2", "nope"]) {
    const no = await closed.request("/auth/switch", { method: "POST", headers: as(who), body: JSON.stringify({ slug }) });
    assert.equal(no.status, 404, slug);
    assert.equal(((await no.json()) as any).error.code, "not_a_member");
  }
  const noCsrf = await closed.request("/auth/switch", { method: "POST", headers: { ...json, Cookie: who.cookie }, body: JSON.stringify({ slug: "second" }) });
  assert.equal(noCsrf.status, 403);
});

test("ten sign-ups an hour per address, counted before any work", { skip }, async () => {
  for (let i = 0; i < 10; i++) assert.equal((await register(open, { email: `x${i}@flood.test`, password: "short" }, "203.0.113.9")).status, 400);
  const eleventh = await register(open, { email: "x10@flood.test", password: PASSWORD, orgName: "Flood" }, "203.0.113.9");
  assert.equal(eleventh.status, 429);
  assert.equal(((await eleventh.json()) as any).error.code, "quota_exceeded");
  assert.equal((await register(open, { email: "y@calm.test", password: "short" }, "203.0.113.10")).status, 400, "another address is untouched");
});

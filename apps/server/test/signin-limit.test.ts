import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { callerMiddleware } from "../src/net/caller.ts";
import { hashPassword, ownerRoutes } from "../src/routes/owner.ts";
import { wrongPasswords, MAX_EMAIL_LENGTH, WRONG_PER_ACCOUNT, WRONG_PER_CALLER, WRONG_WINDOW_MS } from "../src/wrongPasswords.ts";
import { UNLIMITED } from "../src/plan.ts";

/**
 * The sign-in count: wrong passwords, ten for one address and thirty from one
 * caller, in fifteen minutes. Against a real Postgres because the route is
 * the real one; the clock is the test's.
 */
const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the sign-in limit tests";
const PASSWORD = "correct horse battery staple";
const json = { "content-type": "application/json" };

let sql: postgres.Sql;
let clock = Date.parse("2026-11-12T12:00:00Z");

/** A fresh app, so each test starts with nothing counted. `hops` is the deployment's SNAGSET_TRUST_PROXY. */
function door(opts: { hops?: number; counting?: boolean } = {}) {
  const app = new Hono();
  app.use("*", callerMiddleware(() => opts.hops ?? 1));
  app.route("/", ownerRoutes({ sql, limits: async () => ({ ...UNLIMITED, source: "default" }), origin: "http://localhost:8080", secure: false, now: () => new Date(clock), wrong: wrongPasswords(() => clock, () => opts.counting ?? true) }) as never);
  const login = (email: string, password: string, from = "203.0.113.1", forged?: string) =>
    app.request("/auth/login", { method: "POST", headers: { ...json, "x-forwarded-for": forged ? `${forged}, ${from}` : from }, body: JSON.stringify({ email, password }) });
  return { login };
}

before(async () => {
  if (skip) return;
  if (URL_ === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  sql = connect(URL_!, { max: 4 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  const orgId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Kilnwork', 'kilnwork')`;
    for (const email of ["ada@kilnwork.test", "bob@kilnwork.test"]) {
      const id = randomUUID();
      await tx`INSERT INTO users (id, org_id, email, name, password_hash, email_verified) VALUES (${id}, ${orgId}, ${email}, 'Somebody', ${hashPassword(PASSWORD)}, true)`;
      await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${id}, 'owner')`;
    }
  });
});
after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

test("ten wrong passwords for one address, from anywhere, and the eleventh try is refused even when it is right", { skip }, async () => {
  const d = door();
  for (let i = 0; i < WRONG_PER_ACCOUNT; i++) assert.equal((await d.login("ada@kilnwork.test", "wrong", `198.51.100.${i}`)).status, 401, `wrong ${i + 1}`);
  const locked = await d.login("ada@kilnwork.test", PASSWORD, "198.51.100.200");
  assert.equal(locked.status, 429, "the right password, from a place that never guessed");
  assert.equal(locked.headers.get("retry-after"), String(WRONG_WINDOW_MS / 1000));
  const said = (await locked.json()) as { error: { code: string; message: string } };
  assert.equal(said.error.code, "quota_exceeded");
  assert.match(said.error.message, /Try again in 15 minutes, or reset the password/);
  assert.equal(locked.headers.getSetCookie().length, 0, "nobody was signed in");
  assert.equal((await d.login("bob@kilnwork.test", PASSWORD, "198.51.100.200")).status, 200, "another account is not held for it");

  // The window is from each wrong one: a second before the first ages out, still shut; then open.
  clock += WRONG_WINDOW_MS - 1000;
  assert.equal((await d.login("ada@kilnwork.test", PASSWORD)).status, 429);
  clock += 1000;
  assert.equal((await d.login("ada@kilnwork.test", PASSWORD)).status, 200);
});

test("nine wrong and then right: in, and what was mistyped is forgotten", { skip }, async () => {
  const d = door();
  for (let i = 0; i < WRONG_PER_ACCOUNT - 1; i++) assert.equal((await d.login("ada@kilnwork.test", "wrong", `198.51.100.${i}`)).status, 401);
  assert.equal((await d.login("ada@kilnwork.test", PASSWORD)).status, 200);
  for (let i = 0; i < WRONG_PER_ACCOUNT - 1; i++) assert.equal((await d.login("ada@kilnwork.test", "wrong", `198.51.100.${i}`)).status, 401, "a fresh nine");
  assert.equal((await d.login("ada@kilnwork.test", PASSWORD)).status, 200);
});

test("thirty wrong from one caller across many addresses, and that caller is refused for every account; an address that is no account counts the same", { skip }, async () => {
  const d = door();
  const from = "203.0.113.50";
  for (let i = 0; i < WRONG_PER_CALLER; i++) assert.equal((await d.login(`nobody-${i}@nowhere.test`, "a common password", from)).status, 401);
  assert.equal((await d.login("ada@kilnwork.test", PASSWORD, from)).status, 429);
  assert.equal((await d.login("ada@kilnwork.test", PASSWORD, "203.0.113.51")).status, 200, "its owner, from elsewhere, is not held for it");
  // One right password does not buy the caller thirty more guesses.
  const e = door();
  for (let i = 0; i < WRONG_PER_CALLER - 1; i++) await e.login(`nobody-${i}@nowhere.test`, "x", from);
  assert.equal((await e.login("bob@kilnwork.test", PASSWORD, from)).status, 200);
  assert.equal((await e.login("nobody@nowhere.test", "x", from)).status, 401);
  assert.equal((await e.login("bob@kilnwork.test", PASSWORD, from)).status, 429);

  // An address that is not an account is counted like one, so the count says nothing about which are.
  const f = door();
  for (let i = 0; i < WRONG_PER_ACCOUNT; i++) assert.equal((await f.login("ghost@nowhere.test", "x", `198.51.100.${i}`)).status, 401);
  assert.equal((await f.login("ghost@nowhere.test", "x", "198.51.100.99")).status, 429);
});

test("a forged X-Forwarded-For does not make a new caller: one trusted hop reads the entry the proxy wrote", { skip }, async () => {
  const d = door({ hops: 1 });
  for (let i = 0; i < WRONG_PER_CALLER; i++) assert.equal((await d.login(`nobody-${i}@nowhere.test`, "x", "203.0.113.60", `10.1.1.${i}`)).status, 401);
  assert.equal((await d.login("ada@kilnwork.test", PASSWORD, "203.0.113.60", "10.9.9.9")).status, 429);
  // With no trusted hop the header is nothing: every request here is the same (unknown) caller.
  const z = door({ hops: 0 });
  for (let i = 0; i < WRONG_PER_CALLER; i++) await z.login(`nobody-${i}@nowhere.test`, "x", `198.51.100.${i}`);
  assert.equal((await z.login("ada@kilnwork.test", PASSWORD, "192.0.2.1")).status, 429);
});

test("SNAGSET_RATE_LIMIT_ENABLED=false turns the count off", { skip }, async () => {
  const d = door({ counting: false });
  for (let i = 0; i < WRONG_PER_ACCOUNT + 2; i++) assert.equal((await d.login("ada@kilnwork.test", "wrong")).status, 401);
  assert.equal((await d.login("ada@kilnwork.test", PASSWORD)).status, 200);
});


test("fifty sign-ins sent together are counted as they arrive, not after: ten are looked at and the rest refused", { skip }, async () => {
  const d = door();
  const all = await Promise.all(Array.from({ length: 50 }, (_, i) => d.login("ada@kilnwork.test", "wrong", `198.51.100.${i}`)));
  const by = (n: number) => all.filter((r) => r.status === n).length;
  assert.equal(by(401), WRONG_PER_ACCOUNT, "only ten passwords were ever checked");
  assert.equal(by(429), 50 - WRONG_PER_ACCOUNT);
  // And from one caller, across addresses.
  const e = door();
  const many = await Promise.all(Array.from({ length: 50 }, (_, i) => e.login(`nobody-${i}@nowhere.test`, "x", "203.0.113.70")));
  assert.equal(many.filter((r) => r.status === 401).length, WRONG_PER_CALLER);
});

test("an address longer than any account's is refused before it is counted or looked up", { skip }, async () => {
  const d = door();
  const long = `${"a".repeat(MAX_EMAIL_LENGTH)}@nowhere.test`;
  for (let i = 0; i < WRONG_PER_ACCOUNT + 2; i++) assert.equal((await d.login(long, "x", `198.51.100.${i}`)).status, 400);
});

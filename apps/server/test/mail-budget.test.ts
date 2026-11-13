import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { DAY_MS, capsFrom, spendMail } from "../src/mail/budget.ts";
import { loadConfig } from "../src/config.ts";

/**
 * How much mail a studio and its owner may cause in a day. One person
 * owns two studios here, so the owner's count is the one a second studio
 * would otherwise step round. Skipped without `SNAGSET_TEST_DATABASE_URL`;
 * drops the schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the mail budget tests";

let sql: postgres.Sql;
let home: string, second: string, stranger: string;

async function studio(tx: postgres.TransactionSql, name: string): Promise<string> {
  const id = randomUUID();
  await tx`INSERT INTO orgs (id, name, slug, plan) VALUES (${id}, ${name}, ${name.toLowerCase() + id.slice(0, 6)}, 'free')`;
  return id;
}

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  sql = connect(URL_!, { max: 4 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
  await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    home = await studio(tx, "Home");
    second = await studio(tx, "Second");
    stranger = await studio(tx, "Stranger");
    const owner = randomUUID();
    await tx`INSERT INTO users (id, org_id, email, name, password_hash, email_verified) VALUES (${owner}, ${home}, 'o@studio.test', 'Owner', 'x', true)`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${home}, ${owner}, 'owner'), (${second}, ${owner}, 'owner')`;
    const other = randomUUID();
    await tx`INSERT INTO users (id, org_id, email, name, password_hash, email_verified) VALUES (${other}, ${stranger}, 's@else.test', 'Someone', 'x', true)`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${stranger}, ${other}, 'owner')`;
  });
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

const reset = () => sql.begin(async (tx) => {
  await tx`SET LOCAL app.maintenance = 'on'`;
  await tx`DELETE FROM rate_counters`;
});

test("no limit set is no limit, and nothing is written", { skip }, async () => {
  await reset();
  const now = new Date();
  for (let i = 0; i < 50; i++) assert.equal(await spendMail(sql, home, { studio: 0, owner: 0 }, now), null);
  const rows = await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    return tx`SELECT 1 FROM rate_counters`;
  });
  assert.equal(rows.length, 0);
});

test("a studio's day: up to the number, then refused until it turns, then fresh", { skip }, async () => {
  await reset();
  const t0 = new Date("2026-11-13T10:00:00Z");
  const caps = { studio: 3, owner: 0 };
  for (let i = 0; i < 3; i++) assert.equal(await spendMail(sql, home, caps, new Date(t0.getTime() + i * 1000)), null);
  const refused = await spendMail(sql, home, caps, new Date(t0.getTime() + 60_000));
  assert.ok(refused, "the fourth is refused");
  assert.equal(refused!.getTime(), t0.getTime() + DAY_MS, "and told when the day that began with the first send turns");
  assert.ok(await spendMail(sql, home, caps, new Date(t0.getTime() + DAY_MS - 1)), "still refused a moment before");
  assert.equal(await spendMail(sql, home, caps, new Date(t0.getTime() + DAY_MS)), null, "and free at the turn itself");
  assert.equal(await spendMail(sql, home, caps, new Date(t0.getTime() + DAY_MS + 1)), null, "a new day");
  assert.equal(await spendMail(sql, stranger, caps, t0), null, "another studio has its own day");
});

test("one owner's studios share the owner's day: a second studio brings no fresh allowance", { skip }, async () => {
  await reset();
  const now = new Date();
  const caps = { studio: 10, owner: 4 };
  for (let i = 0; i < 2; i++) assert.equal(await spendMail(sql, home, caps, now), null);
  for (let i = 0; i < 2; i++) assert.equal(await spendMail(sql, second, caps, now), null);
  assert.ok(await spendMail(sql, second, caps, now), "the owner's fifth, from either studio, is refused");
  assert.ok(await spendMail(sql, home, caps, now), "from either");
  assert.equal(await spendMail(sql, stranger, caps, now), null, "a studio somebody else owns is not counted with them");
});

test("a refusal spends nothing: the studio's count is not taken when the owner's is full", { skip }, async () => {
  await reset();
  const now = new Date();
  const caps = { studio: 2, owner: 2 };
  assert.equal(await spendMail(sql, home, caps, now), null);
  assert.equal(await spendMail(sql, home, caps, now), null);
  for (let i = 0; i < 5; i++) assert.ok(await spendMail(sql, second, caps, now));
  // The owner's day is full, but `second` never sent: its own count is untouched.
  const [row] = await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    return tx<{ count: string }[]>`SELECT count::text FROM rate_counters WHERE org_id = ${second} AND bucket_key = 'mail-day:studio'`;
  });
  assert.equal(Number(row?.count ?? 0), 0);
});

test("sends at the same moment do not each see the last place", { skip }, async () => {
  await reset();
  const now = new Date();
  const caps = { studio: 5, owner: 0 };
  const answers = await Promise.all(Array.from({ length: 20 }, () => spendMail(sql, stranger, caps, now)));
  assert.equal(answers.filter((a) => a === null).length, 5, "exactly the number go, however many ask together");
});

test("the settings: unset or 0 is no limit, a number is the number", () => {
  const base = { DATABASE_URL: "postgres://x/y", SNAGSET_SECRET_KEY: Buffer.alloc(32, 1).toString("base64url") };
  assert.deepEqual(capsFrom(loadConfig(base)), { studio: 0, owner: 0 });
  assert.deepEqual(capsFrom(loadConfig({ ...base, SNAGSET_MAIL_STUDIO_DAILY: "0" })), { studio: 0, owner: 0 });
  assert.deepEqual(capsFrom(loadConfig({ ...base, SNAGSET_MAIL_STUDIO_DAILY: "40", SNAGSET_MAIL_OWNER_DAILY: "60" })), { studio: 40, owner: 60 });
});

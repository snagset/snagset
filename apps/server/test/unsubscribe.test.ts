import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";
import { createKeyring } from "../src/keys.ts";
import { unsubscribeToken, readUnsubscribeToken, unsubscribeHeaders } from "../src/mail/unsubscribe.ts";

/**
 * One-click unsubscribe — B2.
 *
 * The whole point of this feature is that it works for somebody with no
 * session, possibly years later, possibly from a mail client that fetched the
 * link without being asked to. So the tests are about exactly those cases
 * rather than the happy path a logged-in person would take.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the unsubscribe tests";

const SECRET = Buffer.alloc(32, 9).toString("base64url");
let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let reviewerId: string;

before(async () => {
  if (skip) return;
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
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

  const orgId = randomUUID();
  const projectId = randomUUID();
  reviewerId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Org', 'org')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt)
      VALUES (${projectId}, ${orgId}, 'prj_qwerty123456', 'P', ${Buffer.alloc(32, 1)})`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, email, holder_secret_hash)
      VALUES (${reviewerId}, ${orgId}, ${projectId}, 'guest', 'Ada', 'ada@example.test', ${Buffer.alloc(32, 4)})`;
  });
});

after(async () => {
  if (!skip) await sql.end();
});

const offAt = async (): Promise<Date | null> => {
  const [row] = await sql<{ notifications_off_at: Date | null }[]>`
    SELECT notifications_off_at FROM reviewers WHERE id = ${reviewerId}::uuid`;
  return row?.notifications_off_at ?? null;
};

test("a token round-trips, and a tampered one does not", { skip }, () => {
  const keys = createKeyring(SECRET);
  const token = unsubscribeToken(keys, reviewerId);
  assert.equal(readUnsubscribeToken(keys, token), reviewerId);

  // Swap the id, keep the signature: the classic forgery, and the reason the
  // MAC covers the id rather than sitting beside it.
  const [, mac] = token.split(".");
  assert.equal(readUnsubscribeToken(keys, `${randomUUID()}.${mac}`), null);
  // A truncated MAC must be null, not a thrown length error from
  // timingSafeEqual — that would be a 500 where a 404 belongs.
  assert.equal(readUnsubscribeToken(keys, `${reviewerId}.abc`), null);
  assert.equal(readUnsubscribeToken(keys, "nonsense"), null);

  // A token signed under a DIFFERENT secret is not ours.
  const other = createKeyring(Buffer.alloc(32, 7).toString("base64url"));
  assert.equal(readUnsubscribeToken(keys, unsubscribeToken(other, reviewerId)), null);
});

test("the header pair is RFC 8058 — both halves, or the button never renders", { skip }, () => {
  const h = unsubscribeHeaders("https://review.example.com/", unsubscribeToken(createKeyring(SECRET), reviewerId));
  assert.match(h["List-Unsubscribe"]!, /^<https:\/\/review\.example\.com\/unsubscribe\?t=.+>$/);
  assert.equal(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("GET does NOT unsubscribe — mail clients fetch every link in a message", { skip }, async () => {
  /**
   * The failure this prevents is silent and undetectable by the victim: a
   * scanner or a preview pane fetches the opt-out URL, and somebody who never
   * clicked stops receiving mail they wanted. RFC 8058 puts the act on POST
   * for exactly this reason.
   */
  const token = unsubscribeToken(createKeyring(SECRET), reviewerId);
  const res = await app.request(`/unsubscribe?t=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Stop the emails/);
  assert.equal(await offAt(), null, "a GET must not have changed anything");
});

test("POST unsubscribes, with no session anywhere in sight", { skip }, async () => {
  const token = unsubscribeToken(createKeyring(SECRET), reviewerId);
  const res = await app.request("/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: token }).toString(),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.match(await res.text(), /no more emails/i);
  assert.ok(await offAt(), "notifications_off_at must be set");
});

test("a provider's one-click POST works — token in the URL, One-Click in the body", { skip }, async () => {
  // What Gmail and friends actually send: the body is the literal
  // `List-Unsubscribe=One-Click` and the URL is left exactly as we wrote it.
  await sql`UPDATE reviewers SET notifications_off_at = NULL WHERE id = ${reviewerId}::uuid`;
  const token = unsubscribeToken(createKeyring(SECRET), reviewerId);
  const res = await app.request(`/unsubscribe?t=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(await offAt());
});

test("unsubscribing twice keeps the FIRST time — the one a complaint asks about", { skip }, async () => {
  const first = await offAt();
  assert.ok(first);
  const token = unsubscribeToken(createKeyring(SECRET), reviewerId);
  const res = await app.request("/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: token }).toString(),
  });
  assert.equal(res.status, 200);
  assert.equal((await offAt())!.getTime(), first!.getTime(), "the opt-out time must not move");
});

test("a forged token is refused by both verbs", { skip }, async () => {
  const forged = `${randomUUID()}.AAAA`;
  assert.equal((await app.request(`/unsubscribe?t=${forged}`)).status, 404);
  const res = await app.request("/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: forged }).toString(),
  });
  assert.equal(res.status, 404);
});

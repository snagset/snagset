import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/routes/owner.ts";
import { mintSession } from "../src/session.ts";
import { createKeyring } from "../src/keys.ts";
import { ensureStudioReviewers } from "../src/studioReviewers.ts";
import { deliverEmail } from "../src/mail/notify.ts";
import { ASSIGN_DELAY_MS, renderAssigned } from "../src/mail/assigned.ts";
import { threadUrl } from "../src/mail/links.ts";
import type { Mail, Mailer } from "../src/mail/mailer.ts";
import { HTTP_HEADER } from "@snagset/types/names";

/**
 * The assignment mail, through the real PATCH and the real delivery
 * job. "Pastel emails the assignee straight away; we do not want an email
 * every time." So: an hour late, only if still true, and several at once as
 * one mail.
 *
 * The clock is the job's `now`, pushed past the hour; the rows are queued
 * with the database's `now()`. Skipped without `SNAGSET_TEST_DATABASE_URL`,
 * and it DROPS THE SCHEMA, like every suite here that migrates.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the assignment-mail tests";
const SECRET = Buffer.alloc(32, 13).toString("base64url");
const PASSWORD = "correct horse battery staple";
const BASE = "https://snag.studio.test";
const MIN = 60_000;

let sql: postgres.Sql;
let app: ReturnType<typeof createApp>;
let quiet: ReturnType<typeof createApp>; // the same instance with no mail transport
let base: Record<string, string>;
let build: (env: Record<string, string>) => ReturnType<typeof createApp>;
let orgId: string, ownerUser: string, miaUser: string;
let owner: { cookie: string; csrf: string };
const site = { a: { uid: "", id: "" }, b: { uid: "", id: "" } };
let ada: string; // a client reviewer on site A, with an address
let me: string; // the owner's studio row on site A
let mia: string, miaB: string; // a studio member, on both sites
let meB: string; // the owner on site B
let adaBearer: string;

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const cookie = res.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  return { cookie, csrf: (JSON.parse(text) as { csrfToken: string }).csrfToken };
}

const asOwner = () => ({ "content-type": "application/json", Cookie: owner.cookie, [HTTP_HEADER.csrf]: owner.csrf });

async function makeSite(name: string, origin: string): Promise<{ uid: string; id: string }> {
  const made = await app.request("/api/v1/projects", {
    method: "POST",
    headers: asOwner(),
    body: JSON.stringify({ name, origins: origin }),
  });
  const text = await made.text();
  assert.equal(made.status, 201, text);
  const uid = (JSON.parse(text) as { uid: string }).uid;
  const [p] = await sql<{ id: string }[]>`SELECT id FROM projects WHERE uid = ${uid}`;
  return { uid, id: p!.id };
}

/** A thread on a site, written by `author`, with a first comment. */
async function makeThread(s: { id: string }, author: string, body: string): Promise<{ id: string; key: string }> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    const [env] = await tx<{ id: string }[]>`SELECT id FROM environments WHERE project_id = ${s.id} AND is_default`;
    const [round] = await tx<{ id: string }[]>`SELECT id FROM rounds WHERE project_id = ${s.id}`;
    const [n] = await tx<{ n: number }[]>`UPDATE projects SET thread_seq = thread_seq + 1 WHERE id = ${s.id} RETURNING thread_seq AS n`;
    const [pos] = await tx<{ n: number }[]>`UPDATE rounds SET thread_seq = thread_seq + 1 WHERE id = ${round!.id} RETURNING thread_seq AS n`;
    const id = randomUUID();
    const key = `SN-${n!.n}`;
    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                           anchor, context, created_by)
      VALUES (${id}, ${orgId}, ${s.id}, ${key}, ${env!.id}, ${round!.id}, ${pos!.n},
              ${tx.json({ offset: {}, page: {} })}, ${tx.json({ url: "https://client.test/pricing" })}, ${author})`;
    await tx`
      INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
      VALUES (${randomUUID()}, ${orgId}, ${s.id}, ${id}, 1, ${author}, ${body})`;
    return { id, key };
  }) as Promise<{ id: string; key: string }>;
}

async function patch(
  s: { uid: string },
  t: { id: string },
  body: Record<string, unknown>,
  headers: Record<string, string> = asOwner(),
  via = app,
) {
  const res = await via.request(`/api/v1/projects/${s.uid}/threads/thr_${t.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, await res.clone().text());
}

const assign = (s: { uid: string }, t: { id: string }, who: string | null, via = app) =>
  patch(s, t, { assignee: who ? `rev_${who}` : null }, asOwner(), via);

function recorder(): Mailer & { sent: Mail[] } {
  const m = {
    kind: "http" as const,
    from: "snagset@studio.test",
    sent: [] as Mail[],
    async send(mail: Mail) {
      m.sent.push(mail);
      return { id: `id-${m.sent.length}` };
    },
  };
  return m;
}

/** Run the delivery job at `at` until it says it is done, and return what went. */
async function drain(at: Date): Promise<Mail[]> {
  const mailer = recorder();
  const job = deliverEmail(mailer, async () => BASE, createKeyring(SECRET), "digest");
  for (let i = 0; i < 40; i++) {
    const out = await job.run({ sql, now: at, log: () => {} } as never);
    if (!out.more) break;
  }
  // Only the assignment mail — a resolve also queues its own (B2).
  return mailer.sent.filter((m) => /assigned to you/.test(m.subject));
}
/** A few seconds ahead (the container's clock — see notify-fanout's drain). */
const soon = () => new Date(Date.now() + 5_000);
const pastTheHour = () => new Date(Date.now() + ASSIGN_DELAY_MS + 5 * MIN);

const rows = () =>
  sql<{ id: string; status: string; last_error: string | null; event: Record<string, unknown>; next_attempt_at: Date; created_at: Date }[]>`
    SELECT id, status::text AS status, last_error, event, next_attempt_at, created_at
      FROM outbox WHERE topic = 'thread.assigned' ORDER BY created_at`;

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  }
  sql = connect(URL_!, { max: 4 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});

  orgId = randomUUID();
  ownerUser = randomUUID();
  miaUser = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, name, password_hash)
      VALUES (${ownerUser}, ${orgId}, 'o@e.test', 'Olive', ${hashPassword(PASSWORD)})`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${ownerUser}, 'owner')`;
    await tx`INSERT INTO users (id, org_id, email, name) VALUES (${miaUser}, ${orgId}, 'mia@e.test', 'Mia')`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${miaUser}, 'member')`;
  });

  base = { DATABASE_URL: URL_!, SNAGSET_SECRET_KEY: SECRET };
  build = (env: Record<string, string>) =>
    createApp({
      sql,
      cfg: loadConfig(env),
      secretKey: SECRET,
      state: "READY",
      version: "0.0.0-test",
      commit: "test",
      sourceUrl: "https://example.test",
      modified: false,
    });
  // A transport that is configured and never reached: nothing here drains
  // after a response (`afterResponse` is absent), the tests drain by hand.
  app = build({ ...base, SNAGSET_MAIL_URL: "resend://re_test_never_used", SNAGSET_MAIL_FROM: "snagset@studio.test" });
  quiet = build(base);
  owner = await login("o@e.test");

  site.a = await makeSite("Acme", "https://acme.test");
  site.b = await makeSite("Kiln", "https://kiln.test");

  ada = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await ensureStudioReviewers(tx as postgres.TransactionSql, { orgId });
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, email, holder_secret_hash)
      VALUES (${ada}, ${orgId}, ${site.a.id}, 'guest', 'Ada the client', 'ada@client.test', ${Buffer.alloc(32, 2)})`;
  });
  const studio = async (userId: string, projectId: string) =>
    (await sql<{ id: string }[]>`SELECT id FROM reviewers WHERE user_id = ${userId} AND project_id = ${projectId}`)[0]!.id;
  me = await studio(ownerUser, site.a.id);
  mia = await studio(miaUser, site.a.id);
  miaB = await studio(miaUser, site.b.id);
  meB = await studio(ownerUser, site.b.id);

  adaBearer = (
    await mintSession(
      createKeyring(SECRET),
      {
        projectUid: site.a.uid,
        reviewerId: ada,
        environmentKey: "production",
        kind: "guest",
        reviewLinkId: null,
        permissions: ["thread:create", "comment:create", "thread:resolve"],
        sessionEpoch: 1,
      },
      { slidingS: 900, absoluteS: 43_200 },
    )
  ).token;
});

beforeEach(async () => {
  if (skip) return;
  await sql`DELETE FROM outbox`;
  await sql`DELETE FROM rate_counters`;
});

after(async () => {
  if (!skip) {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }
  await sql?.end({ timeout: 5 });
});

test("assigning queues ONE row, due an hour later — and nothing goes before then", { skip }, async () => {
  const t = await makeThread(site.a, ada, "The logo is blurry on retina\nand also too small");
  await assign(site.a, t, ada);

  const [row, extra] = await rows();
  assert.ok(row, "a row is queued");
  assert.equal(extra, undefined, "exactly one");
  assert.equal(row.event["toReviewer"], ada);
  const delay = row.next_attempt_at.getTime() - row.created_at.getTime();
  assert.ok(Math.abs(delay - ASSIGN_DELAY_MS) < 5_000, `due an hour after queueing, was ${delay}ms`);

  assert.equal((await drain(soon())).length, 0, "not before the hour");
  const sent = await drain(pastTheHour());
  assert.equal(sent.length, 1);
  const mail = sent[0]!;
  assert.equal(mail.to, "ada@client.test", "a client reviewer with an address gets it");
  assert.equal(mail.subject, `${t.key} was assigned to you on Acme`);
  assert.match(mail.text, /Olive assigned SN-\d+ to you on Acme/);
  assert.match(mail.text, /The logo is blurry on retina/);
  assert.doesNotMatch(mail.text, /too small/, "the first line only");
  assert.ok(mail.text.includes(threadUrl(BASE, site.a.uid, t.key, 1)), "the deep link");
  assert.match(mail.headers?.["List-Unsubscribe"] ?? "", /\/unsubscribe\?t=/, "a reviewer's opt-out rides along");
  assert.deepEqual((await rows()).map((r) => r.status), ["done"]);
});

test("assigning yourself queues nothing — by studio row, as the dashboard does", { skip }, async () => {
  const t = await makeThread(site.a, ada, "Self");
  await assign(site.a, t, me);
  assert.equal((await rows()).length, 0);
});

test("re-assigning the same person inside the hour is one row, pushed back; re-sending the holder is nothing", { skip }, async () => {
  const t = await makeThread(site.a, ada, "Twice");
  await assign(site.a, t, mia);
  const [first] = await rows();
  await sql`UPDATE outbox SET next_attempt_at = next_attempt_at - interval '30 minutes' WHERE id = ${first!.id}`;
  await assign(site.a, t, null);
  await assign(site.a, t, mia);
  const after = await rows();
  assert.equal(after.length, 1, "no second row");
  assert.ok(after[0]!.next_attempt_at.getTime() > first!.next_attempt_at.getTime() - 60_000, "the hour starts again");

  // Sending the assignee the thread already has is not an assignment.
  await sql`DELETE FROM outbox`;
  await assign(site.a, t, mia);
  assert.equal((await rows()).length, 0);
});

test("dropped at send: reassigned, unassigned, resolved, or the assignee has answered", { skip }, async () => {
  const moved = await makeThread(site.a, ada, "Moved");
  await assign(site.a, moved, ada);
  await assign(site.a, moved, mia);

  const cleared = await makeThread(site.a, ada, "Cleared");
  await assign(site.a, cleared, ada);
  await assign(site.a, cleared, null);

  const done = await makeThread(site.a, ada, "Done");
  await assign(site.a, done, mia);
  await patch(site.a, done, { status: "resolved" });

  const answered = await makeThread(site.a, me, "Answered");
  await assign(site.a, answered, ada);
  await sql`
    INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
    VALUES (${randomUUID()}, ${orgId}, ${site.a.id}, ${answered.id}, 2, ${ada}, 'on it')`;

  // The assignee moving the status themselves: dropped there and then.
  const touched = await makeThread(site.a, me, "Touched");
  await assign(site.a, touched, ada);
  await patch(site.a, touched, { status: "progress" }, { "content-type": "application/json", Authorization: `Bearer ${adaBearer}` });

  const sent = await drain(pastTheHour());
  // Mia still holds `moved`, and only that.
  assert.deepEqual(
    sent.map((m) => [m.to, m.subject]),
    [["mia@e.test", `${moved.key} was assigned to you on Acme`]],
  );
  const reasons = (await rows()).filter((r) => r.status === "dropped").map((r) => r.last_error).sort();
  assert.deepEqual(reasons, [
    "the assignee changed its status",
    "the assignee has replied since",
    "the thread is no longer assigned to them",
    "the thread is no longer assigned to them",
    "the thread was resolved",
  ]);
});

test("several assignments to one person are ONE mail — across sites too", { skip }, async () => {
  const one = await makeThread(site.a, ada, "First snag");
  const two = await makeThread(site.a, ada, "Second snag");
  await assign(site.a, one, mia);
  await assign(site.a, two, mia);
  assert.equal((await rows()).length, 2);

  const sent = await drain(pastTheHour());
  assert.equal(sent.length, 1, "one mail");
  assert.equal(sent[0]!.to, "mia@e.test");
  assert.equal(sent[0]!.subject, "2 snags assigned to you on Acme");
  assert.match(sent[0]!.text, /First snag/);
  assert.match(sent[0]!.text, /Second snag/);
  assert.ok(sent[0]!.text.includes(threadUrl(BASE, site.a.uid, one.key, 1)));
  assert.ok(sent[0]!.text.includes(threadUrl(BASE, site.a.uid, two.key, 1)));
  assert.deepEqual((await rows()).map((r) => r.status), ["done", "done"]);

  // Mia is one person on two sites (one reviewer row each): still one mail.
  await sql`DELETE FROM outbox`;
  const three = await makeThread(site.a, ada, "Third");
  const four = await makeThread(site.b, meB, "Fourth");
  await assign(site.a, three, mia);
  await assign(site.b, four, miaB);
  const across = await drain(pastTheHour());
  assert.equal(across.length, 1);
  assert.equal(across[0]!.subject, "2 snags assigned to you across 2 sites");
  assert.match(across[0]!.text, /Acme \(1\)/);
  assert.match(across[0]!.text, /Kiln \(1\)/);
});

test("rows not yet due wait for their own hour, and are not swept into an earlier batch", { skip }, async () => {
  const early = await makeThread(site.a, ada, "Early");
  const late = await makeThread(site.a, ada, "Late");
  await assign(site.a, early, mia);
  await assign(site.a, late, mia);
  await sql`UPDATE outbox SET next_attempt_at = now() + interval '3 hours' WHERE event->>'threadKey' = ${late.key}`;
  const sent = await drain(pastTheHour());
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.subject, `${early.key} was assigned to you on Acme`);
  assert.deepEqual((await rows()).map((r) => r.status).sort(), ["done", "pending"]);
});

test("an unsubscribed assignee, or no mail transport at all, queues nothing", { skip }, async () => {
  const t = await makeThread(site.a, ada, "Quiet");
  await assign(site.a, t, ada, quiet);
  assert.equal((await rows()).length, 0, "no transport: off, not queued");

  await assign(site.a, t, null);
  await sql`UPDATE reviewers SET notifications_off_at = now() WHERE id = ${ada}`;
  try {
    await assign(site.a, t, ada);
    assert.equal((await rows()).length, 0);
  } finally {
    await sql`UPDATE reviewers SET notifications_off_at = NULL WHERE id = ${ada}`;
  }
});

test("the mail sanitises what it is given", () => {
  const m = renderAssigned(
    [
      {
        rowId: "x",
        threadKey: "SN-1\r\nBcc: evil@x.test",
        site: "Site",
        siteUid: "prj_x",
        round: 1,
        actorName: "Olive",
        excerpt: "fine",
      },
    ],
    "a@b.test",
    BASE,
  );
  assert.doesNotMatch(m.subject, /[\r\n]/);
});

test("SNAGSET_ASSIGN_MAIL_DELAY_S sets the wait", { skip }, async () => {
  const tenMinutes = build({
    ...base,
    SNAGSET_MAIL_URL: "resend://re_test_never_used",
    SNAGSET_MAIL_FROM: "snagset@studio.test",
    SNAGSET_ASSIGN_MAIL_DELAY_S: "600",
  });
  const t = await makeThread(site.a, ada, "Footer overlaps on mobile");
  await assign(site.a, t, ada, tenMinutes);
  const row = (await rows()).at(-1)!;
  const delay = row.next_attempt_at.getTime() - row.created_at.getTime();
  assert.ok(Math.abs(delay - 600_000) < 5_000, `due ten minutes after queueing, was ${delay}ms`);
});

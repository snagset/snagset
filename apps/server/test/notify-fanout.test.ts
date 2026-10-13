import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID, randomBytes } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { createKeyring } from "../src/keys.ts";
import { queueCommentNotice, queueResolvedNotice, deliverEmail } from "../src/mail/notify.ts";
import type { Mail } from "../src/mail/mailer.ts";

/**
 * Who a notification actually reaches — B2's "created or replied".
 *
 * The subscription rule is DERIVED: a reviewer hears about a thread because
 * they wrote on it. There is deliberately no endpoint that subscribes an
 * arbitrary address, because that endpoint is the one an abuser wants — so
 * these tests are about who ends up in the outbox, and who does not.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the fan-out tests";
const SECRET = Buffer.alloc(32, 11).toString("base64url");

let sql: postgres.Sql;
let orgId: string, projectId: string, threadId: string;
let ada: string, grace: string, silent: string, mute: string;

/** Seed a reviewer who has commented on the thread. */
async function participant(
  tx: postgres.TransactionSql,
  name: string,
  email: string | null,
  opts: { off?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await tx`
    INSERT INTO reviewers (id, org_id, project_id, kind, name, email, holder_secret_hash, notifications_off_at)
    VALUES (${id}, ${orgId}, ${projectId}, 'guest', ${name}, ${email}, ${randomBytes(32)},
            ${opts.off ? new Date() : null})`;
  await tx`
    INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
    VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${threadId},
            (SELECT COALESCE(max(seq), 0) + 1 FROM comments WHERE thread_id = ${threadId}),
            ${id}, ${"from " + name})`;
  return id;
}

before(async () => {
  if (skip) return;
  sql = connect(URL_!, { max: 3 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});

  orgId = randomUUID();
  projectId = randomUUID();
  threadId = randomUUID();
  const userId = randomUUID();
  const envId = randomUUID();
  const roundId = randomUUID();

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email) VALUES (${userId}, ${orgId}, 'owner@studio.test')`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag)
      VALUES (${projectId}, ${orgId}, 'prj_fanqt1234567', 'P', ${Buffer.alloc(32, 1)}, 'e')`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${envId}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    const seed = randomUUID();
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${seed}, ${orgId}, ${projectId}, 'guest', 'Seed', ${Buffer.alloc(32, 2)})`;
    await tx`
      INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
      VALUES (${roundId}, ${orgId}, ${projectId}, 1, 'Round 1', ${userId})`;
    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                           anchor, context, created_by)
      VALUES (${threadId}, ${orgId}, ${projectId}, 'SN-1', ${envId}, ${roundId}, 1,
              ${tx.json({ offset: {}, page: {} })},
              ${tx.json({ url: "https://client.test/pricing" })}, ${seed})`;

    ada = await participant(tx, "Ada", "ada@example.test");
    grace = await participant(tx, "Grace", "grace@example.test");
    silent = await participant(tx, "Silent", null); // took part, left no address
    mute = await participant(tx, "Mute", "mute@example.test", { off: true }); // unsubscribed
  });
});

after(async () => {
  if (!skip) await sql.end();
});

async function queueFrom(authorId: string, commentId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await queueCommentNotice(
      tx,
      {
        orgId, projectId, threadId, commentId,
        threadKey: "SN-1",
        authorId,
        authorName: "Ada",
        body: "the button is the wrong blue",
        pageUrl: "https://client.test/pricing",
      },
      randomUUID(),
    );
  });
}

const rowsFor = (commentId: string) => sql<{ event: Record<string, unknown> }[]>`
  SELECT event FROM outbox WHERE dedupe_key LIKE ${"comment.created:" + commentId + "%"} ORDER BY dedupe_key`;

test("the owner and every OTHER participant get a row; the author does not", { skip }, async () => {
  await resetSubscriptions();
  const commentId = randomUUID();
  await queueFrom(ada, commentId);
  const rows = await rowsFor(commentId);
  const recipients = rows.map((r) => r.event["toReviewer"] ?? "OWNER");

  assert.ok(recipients.includes("OWNER"), "the project owner is always notified");
  assert.ok(recipients.includes(grace), "a participant with an address is notified");
  assert.ok(!recipients.includes(ada), "the author must not be mailed about their own comment");
  assert.ok(!recipients.includes(silent), "no address, no row");
  assert.ok(!recipients.includes(mute), "an unsubscribed participant is never queued");
  assert.equal(rows.length, 2, `expected owner + Grace, got ${JSON.stringify(recipients)}`);
});

test("re-queuing the same comment adds nothing — per-recipient dedupe", { skip }, async () => {
  await resetSubscriptions();
  /**
   * The guarantee is per ROW, which is why the fan-out happens at enqueue:
   * `UNIQUE (provider, dedupe_key)` makes a retry a no-op for THAT recipient.
   * One row addressed to several people could not have this property.
   */
  const commentId = randomUUID();
  await queueFrom(ada, commentId);
  const before = (await rowsFor(commentId)).length;
  await queueFrom(ada, commentId);
  assert.equal((await rowsFor(commentId)).length, before, "a retry must not duplicate anyone");
});

/**
 * Put the cast back the way `before` left it.
 *
 * These tests share one database and several of them change who is
 * subscribed, so a test that merely *assumes* Grace can be mailed passes or
 * fails on what ran before it. Stating the precondition is what makes each
 * one mean something on its own.
 */
async function resetSubscriptions(): Promise<void> {
  await sql`UPDATE reviewers SET notifications_off_at = NULL WHERE id = ${grace}::uuid`;
  await sql`UPDATE reviewers SET notifications_off_at = now() WHERE id = ${mute}::uuid`;
  await sql`DELETE FROM outbox`;
  // AND the rate counters. Added after the limiter landed and quietly took
  // this file from 9 passing to 4: counters accumulate per address per hour,
  // so by the third test Grace was over her allowance and every later
  // assertion was really measuring the limiter rather than the thing it named.
  // Precondition, not leftovers — the same lesson as the subscriptions above.
  await sql`DELETE FROM rate_counters`;
}

/** Send everything currently queued, and report what went out. */
async function drain(): Promise<Mail[]> {
  const sent: Mail[] = [];
  const job = deliverEmail(
    { kind: "http" as const, send: async (m: Mail) => { sent.push(m); return { id: "x" }; } } as never,
    async () => "https://review.example.com",
    createKeyring(SECRET),
  );
  /**
   * A few seconds AHEAD, and the reason is not laziness.
   *
   * Rows are inserted with the DATABASE's `now()` and claimed with
   * `next_attempt_at <= ${now}` — where `now` comes from this process. Postgres
   * runs in a container whose clock can sit a fraction ahead of the host's, so
   * a test that queues and drains in the same instant asks "is anything due?"
   * a hair before the rows became due, and gets nothing. It cost half an hour
   * and looked exactly like a broken delivery job.
   *
   * Production never meets this: the job ticks every 30 seconds. Only a test
   * fast enough to outrun the clock skew does.
   */
  for (let i = 0; i < 40; i++) {
    const out = await job.run({ sql, now: new Date(Date.now() + 5_000), log: () => {} } as never);
    if (!out.more) break;
  }
  return sent;
}

test("reviewer mail carries List-Unsubscribe; the owner's does not", { skip }, async () => {
  // Seeds its OWN row rather than draining whatever an earlier test left —
  // shared outbox state between tests is how one of them starts depending on
  // another's leftovers and both stop meaning anything.
  await resetSubscriptions();
  await queueFrom(ada, randomUUID());
  const sent = await drain();

  const toGrace = sent.find((m) => m.to === "grace@example.test");
  assert.ok(toGrace, "Grace should have been mailed");
  assert.match(toGrace!.headers!["List-Unsubscribe"]!, /^<https:\/\/review\.example\.com\/unsubscribe\?t=/);
  assert.equal(toGrace!.headers!["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  const toOwner = sent.find((m) => m.to === "owner@studio.test");
  assert.ok(toOwner, "the owner should have been mailed");
  // The owner configured the mailer; their control is a setting, and a
  // one-click link signed over a reviewer id they do not have cannot work.
  assert.equal(toOwner!.headers?.["List-Unsubscribe"], undefined);

  assert.ok(!sent.some((m) => m.to === "mute@example.test"), "the unsubscribed address is never sent to");
});

test("unsubscribing BETWEEN queue and send drops the row", { skip }, async () => {
  /**
   * The window is real: the outbox retries over an hour, so a row queued
   * before the click can still be waiting after it. "I clicked unsubscribe and
   * then got another one" is exactly the complaint this feature exists to
   * prevent, so the check runs again at send.
   */
  await resetSubscriptions();
  const commentId = randomUUID();
  await queueFrom(ada, commentId);
  await sql`UPDATE reviewers SET notifications_off_at = now() WHERE id = ${grace}::uuid`;

  const sent = await drain();
  assert.ok(!sent.some((m) => m.to === "grace@example.test"), "no mail after unsubscribing");
  const [dropped] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM outbox WHERE status = 'dropped' AND last_error = 'no deliverable recipient'`;
  assert.ok(Number(dropped!.n) > 0, "the row is dropped rather than retried forever");
});

test("thread.resolved goes to participants, NOT the owner", { skip }, async () => {
  /**
   * The opposite audience from `comment.created`, deliberately. Resolving is
   * almost always the studio's own act, and mailing the owner about a button
   * they just pressed is the noise that teaches people to filter the sender.
   */
  await resetSubscriptions();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await queueResolvedNotice(tx, {
      orgId, projectId, threadId,
      threadKey: "SN-1",
      version: 2,
      actorId: ada,
      actorName: "Ada",
      pageUrl: "https://client.test/pricing",
    });
  });

  const rows = await sql<{ event: Record<string, unknown>; dedupe_key: string }[]>`
    SELECT event, dedupe_key FROM outbox WHERE topic = 'thread.resolved'`;
  const recipients = rows.map((r) => r.event["toReviewer"]);
  assert.ok(!recipients.includes(undefined), "no owner row for a resolve");
  assert.ok(!recipients.includes(ada), "the person who resolved it is not told");
  assert.ok(!recipients.includes(mute), "unsubscribed stays unsubscribed");
  assert.ok(recipients.includes(grace) || recipients.includes(silent) === false);

  // The dedupe key carries threads.version, so resolve → reopen → resolve is
  // three real events rather than one delivered and two swallowed.
  assert.ok(rows.every((r) => r.dedupe_key.includes(":2:")), rows.map((r) => r.dedupe_key).join(","));
});

test("resolving twice at DIFFERENT versions notifies twice", { skip }, async () => {
  await resetSubscriptions();
  for (const version of [3, 4]) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      await queueResolvedNotice(tx, {
        orgId, projectId, threadId, threadKey: "SN-1", version,
        actorId: ada, actorName: "Ada", pageUrl: "",
      });
    });
  }
  const [count] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM outbox WHERE topic = 'thread.resolved'`;
  const n = count!.n;
  // Two versions, two notifications — a reopened-and-reresolved thread is a
  // real event each time, and keying on the thread id alone would swallow it.
  assert.ok(Number(n) >= 2, `expected at least one row per version, got ${n}`);
});

test("the resolved email has no comment body — there is no new text", { skip }, async () => {
  await resetSubscriptions();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await queueResolvedNotice(tx, {
      orgId, projectId, threadId, threadKey: "SN-1", version: 9,
      actorId: ada, actorName: "Ada", pageUrl: "https://client.test/pricing",
    });
  });
  const sent = await drain();
  assert.ok(sent.length > 0, "somebody should have been mailed");
  const m = sent[0]!;
  assert.match(m.subject, /marked resolved/);
  assert.ok(!m.text.includes("wrong blue"), "the original comment must not be re-sent");
  assert.match(m.text, /marked SN-1 resolved/);
});

test("an address over its hourly allowance is DEFERRED, not dropped", { skip }, async () => {
  /**
   * A busy round is not abuse. Five people replying on one thread inside a
   * minute is four notifications each, and the right remedy is to slow the
   * mail rather than lose it — so the row goes back to `pending` with a later
   * attempt time, and nothing is thrown away.
   */
  await resetSubscriptions();
  await sql`DELETE FROM rate_counters`;

  // Well past the hourly allowance for one address.
  for (let i = 0; i < 16; i++) await queueFrom(ada, randomUUID());
  const sent = await drain();

  const toGrace = sent.filter((m) => m.to === "grace@example.test").length;
  assert.ok(toGrace > 0, "some mail gets through");
  assert.ok(toGrace <= 12, `the hourly cap is 12, ${toGrace} were sent`);

  const [deferred] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM outbox
     WHERE status = 'pending' AND last_error = 'rate limited for this address'`;
  assert.ok(Number(deferred!.n) > 0, "the excess is deferred rather than dropped");

  // Deferred means LATER, not never: the next attempt is inside the future.
  const [next] = await sql<{ ok: boolean }[]>`
    SELECT bool_and(next_attempt_at > now()) AS ok FROM outbox
     WHERE last_error = 'rate limited for this address'`;
  assert.equal(next!.ok, true, "a deferred row must be scheduled, not stalled");
});

test("the rate counter stores a HASH, never the address", { skip }, async () => {
  // rate_counters outlives the mail it governs, and the rule about not
  // keeping raw identifiers applies to a counter as much as to a log.
  const keys = await sql<{ bucket_key: string }[]>`SELECT bucket_key FROM rate_counters`;
  assert.ok(keys.length > 0, "the limiter should have written something");
  for (const k of keys) {
    assert.match(k.bucket_key, /^mail:/);
    assert.ok(!k.bucket_key.includes("@"), `an address leaked into ${k.bucket_key}`);
    assert.ok(!k.bucket_key.includes("example.test"));
  }
});

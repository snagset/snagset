import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID, randomBytes } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { queueCommentNotice, queueResolvedNotice, deliverEmail, isSamePerson } from "../src/mail/notify.ts";
import type { Mail } from "../src/mail/mailer.ts";

/**
 * "If there is a comment we made, we don't need to receive the email".
 *
 * The owner writes in two ways and both are theirs: from the dashboard, as
 * their studio reviewer row, and through the widget on their own site, as
 * whatever name they typed with their own address in it. Neither may reach
 * the owner's inbox — not by the owner's row, and not by the fan-out to the
 * thread's participants, which the studio row is one of once the owner has
 * replied.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the self-notification tests";

let sql: postgres.Sql;
let orgId: string, projectId: string, threadId: string, ownerUser: string;
/** The owner's studio row (dashboard replies), their widget identity, and a client. */
let studio: string, widgetSelf: string, client: string;

async function reviewer(
  tx: postgres.TransactionSql,
  name: string,
  email: string | null,
  userId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await tx`
    INSERT INTO reviewers (id, org_id, project_id, kind, name, email, user_id, holder_secret_hash)
    VALUES (${id}, ${orgId}, ${projectId}, ${userId ? "verified" : "guest"}, ${name}, ${email},
            ${userId}, ${userId ? null : randomBytes(32)})`;
  return id;
}

/** A comment on the thread, so the author becomes a participant of it. */
async function commentOn(tx: postgres.TransactionSql, authorId: string): Promise<void> {
  await tx`
    INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
    VALUES (${randomUUID()}, ${orgId}, ${projectId}, ${threadId},
            (SELECT COALESCE(max(seq), 0) + 1 FROM comments WHERE thread_id = ${threadId}),
            ${authorId}, 'earlier')`;
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
  ownerUser = randomUUID();
  const envId = randomUUID();
  const roundId = randomUUID();

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email) VALUES (${ownerUser}, ${orgId}, 'owner@studio.test')`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${ownerUser}, 'owner')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt)
      VALUES (${projectId}, ${orgId}, 'prj_sfsf00001234', 'Acme',${Buffer.alloc(32, 1)})`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${envId}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    await tx`
      INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
      VALUES (${roundId}, ${orgId}, ${projectId}, 1, 'Round 1', ${ownerUser})`;

    client = await reviewer(tx, "Dana", "dana@client.test");
    studio = await reviewer(tx, "Owner", "owner@studio.test", ownerUser);
    // The owner testing the widget on their own site: a guest identity whose
    // address is theirs, typed with whatever capitals the hand gave it.
    widgetSelf = await reviewer(tx, "owner-test", "Owner@Studio.TEST");

    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                           anchor, context, created_by)
      VALUES (${threadId}, ${orgId}, ${projectId}, 'SN-1', ${envId}, ${roundId}, 1,
              ${tx.json({ offset: {}, page: {} })},
              ${tx.json({ url: "https://client.test/pricing" })}, ${client})`;

    // The client opened the thread and the owner has replied from the
    // dashboard, so both are participants before any test runs.
    await commentOn(tx, client);
    await commentOn(tx, studio);
  });
});

after(async () => {
  if (!skip) await sql.end();
});

async function queueFrom(authorId: string, commentId = randomUUID()): Promise<string> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await queueCommentNotice(
      tx,
      {
        orgId, projectId, threadId, commentId,
        threadKey: "SN-1",
        authorId,
        authorName: "whoever",
        body: "the button is the wrong blue",
        pageUrl: "https://client.test/pricing",
      },
      randomUUID(),
    );
  });
  return commentId;
}

/** Who a comment's rows are addressed to: "OWNER", or a reviewer id. */
async function recipientsOf(commentId: string): Promise<string[]> {
  const rows = await sql<{ event: Record<string, unknown> }[]>`
    SELECT event FROM outbox WHERE dedupe_key LIKE ${"comment.created:" + commentId + "%"}`;
  return rows.map((r) => String(r.event["toReviewer"] ?? "OWNER"));
}

test("the identity check: user id first, then the address in any case", () => {
  const owner = { userId: "u1", email: "Owner@Studio.test" };
  assert.ok(isSamePerson({ userId: "u1", email: null }, owner), "the studio row");
  assert.ok(isSamePerson({ userId: null, email: "owner@studio.TEST " }, owner), "a widget identity with the owner's address");
  assert.ok(!isSamePerson({ userId: null, email: "dana@client.test" }, owner));
  assert.ok(!isSamePerson({ userId: null, email: null }, owner), "no address is nobody in particular");
  assert.ok(!isSamePerson(null, owner));
  assert.ok(!isSamePerson({ userId: "u1", email: null }, null), "no owner, nobody to be");
});

test("a reply the owner writes from the DASHBOARD queues nothing for the owner", { skip }, async () => {
  await sql`DELETE FROM outbox`;
  const recipients = await recipientsOf(await queueFrom(studio));
  assert.ok(!recipients.includes("OWNER"), "the owner is not told about their own reply");
  assert.ok(!recipients.includes(studio));
  assert.ok(recipients.includes(client), "the client who took part still hears about it");
});

test("a comment from the owner's WIDGET identity (same address, other case) queues nothing for the owner", { skip }, async () => {
  await sql`DELETE FROM outbox`;
  const recipients = await recipientsOf(await queueFrom(widgetSelf));
  assert.ok(!recipients.includes("OWNER"), "matched by address, case-insensitively");
  assert.ok(!recipients.includes(studio), "nor through the studio row the owner replied with earlier");
  assert.deepEqual(recipients, [client]);
});

test("someone else's comment reaches the owner ONCE, by the owner's row", { skip }, async () => {
  await sql`DELETE FROM outbox`;
  // The owner is a participant (they replied from the dashboard), and used to
  // get this comment twice: once as the owner, once as a participant.
  const recipients = await recipientsOf(await queueFrom(client));
  assert.deepEqual(recipients, ["OWNER"], `expected the owner's row alone, got ${JSON.stringify(recipients)}`);
});

test("in `each` mode, the owner's own comment sends nothing to the owner's address", { skip }, async () => {
  await sql`DELETE FROM outbox`;
  await sql`DELETE FROM rate_counters`;
  await queueFrom(widgetSelf);
  await queueFrom(studio);

  const sent: Mail[] = [];
  const job = deliverEmail(
    { kind: "http" as const, send: async (m: Mail) => { sent.push(m); return { id: "x" }; } } as never,
    async () => "https://review.example.com",
  );
  for (let i = 0; i < 20; i++) {
    const out = await job.run({ sql, now: new Date(Date.now() + 5_000), log: () => {} } as never);
    if (!out.more) break;
  }
  assert.ok(!sent.some((m) => m.to.toLowerCase() === "owner@studio.test"), JSON.stringify(sent.map((m) => m.to)));
  assert.ok(sent.some((m) => m.to === "dana@client.test"), "the client is still mailed");
});

test("resolving from the owner's widget identity does not mail the owner's studio row", { skip }, async () => {
  await sql`DELETE FROM outbox`;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await queueResolvedNotice(tx, {
      orgId, projectId, threadId, threadKey: "SN-1", version: 7,
      actorId: widgetSelf, actorName: "owner-test", pageUrl: "",
    });
  });
  const rows = await sql<{ event: Record<string, unknown> }[]>`
    SELECT event FROM outbox WHERE topic = 'thread.resolved'`;
  const recipients = rows.map((r) => r.event["toReviewer"]);
  assert.ok(!recipients.includes(studio), "the same person, by address");
  assert.ok(recipients.includes(client));
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type postgres from "postgres";
import { randomUUID, randomBytes } from "node:crypto";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { loadConfig } from "../src/config.ts";
import { createKeyring } from "../src/keys.ts";
import { runDueJobs } from "../src/jobs/index.ts";
import { jobSet } from "../src/jobs/set.ts";
import { queueCommentNotice, deliverEmail, type NotifyMode } from "../src/mail/notify.ts";
import {
  buildDigests,
  digestCutoff,
  digestKey,
  renderDigest,
  DIGEST_LISTED,
  type DigestEvent,
} from "../src/mail/digest.ts";
import { threadUrl } from "../src/mail/links.ts";
import type { Mail, Mailer } from "../src/mail/mailer.ts";

/**
 * The daily digest — "we don't need to send the email every time there
 * is a comment, maybe once in a while".
 *
 * What is promised, and tested here: many comments become ONE mail; nothing new
 * is no mail; a job that runs every hour (the bin) or twice by hand still sends
 * one a day; the owner's own comments are not in it; and `each` still sends
 * one per comment for whoever sets it.
 *
 * The clock is injected and set to TOMORROW (UTC) on purpose. A digest folds
 * the rows queued before the current day's midnight, and the rows here are
 * queued with the database's real `now()` — so "tomorrow, an hour after
 * midnight" is the moment at which everything queued during the test is in
 * yesterday's window, whatever hour the suite happens to run at.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the digest tests";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const BASE = "https://snag.studio.test";

const MIDNIGHT = digestCutoff(new Date(Date.now() + DAY));
const DAY1 = new Date(MIDNIGHT.getTime() + HOUR);

let sql: postgres.Sql;
let orgId: string;
let ownerUser: string;
const site = {
  acme: { id: "", uid: "prj_brngg0000001", thread: "", env: "", round: "" },
  kiln: { id: "", uid: "prj_knwrk0000001", thread: "", env: "", round: "" },
};
let dana: string, studio: string, widgetSelf: string;

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

before(async () => {
  if (skip) return;
  sql = connect(URL_!, { max: 4 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});

  orgId = randomUUID();
  ownerUser = randomUUID();

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`INSERT INTO users (id, org_id, email) VALUES (${ownerUser}, ${orgId}, 'owner@studio.test')`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${ownerUser}, 'owner')`;

    for (const [name, s, number] of [["Acme", site.acme, 2], ["Kiln", site.kiln, 1]] as const) {
      s.id = randomUUID();
      s.env = randomUUID();
      s.round = randomUUID();
      s.thread = randomUUID();
      await tx`
        INSERT INTO projects (id, org_id, uid, name, ip_salt)
        VALUES (${s.id}, ${orgId}, ${s.uid}, ${name}, ${randomBytes(32)})`;
      await tx`
        INSERT INTO environments (id, org_id, project_id, key, label, is_default)
        VALUES (${s.env}, ${orgId}, ${s.id}, 'production', 'Production', true)`;
      // Acme is on its SECOND round, so the link has to carry the round for
      // the comments page to open the thread rather than the latest list.
      await tx`
        INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
        VALUES (${s.round}, ${orgId}, ${s.id}, ${number}, ${`Round ${number}`}, ${ownerUser})`;
    }

    dana = randomUUID();
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, email, holder_secret_hash)
      VALUES (${dana}, ${orgId}, ${site.acme.id}, 'guest', 'Dana', 'dana@client.test', ${randomBytes(32)})`;
    studio = randomUUID();
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, email, user_id)
      VALUES (${studio}, ${orgId}, ${site.acme.id}, 'verified', 'Owner', 'owner@studio.test', ${ownerUser})`;
    widgetSelf = randomUUID();
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, email, holder_secret_hash)
      VALUES (${widgetSelf}, ${orgId}, ${site.acme.id}, 'guest', 'owner-test', 'OWNER@Studio.test',${randomBytes(32)})`;

    for (const [s, key] of [[site.acme, "SN-14"], [site.kiln, "SN-3"]] as const) {
      await tx`
        INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                             anchor, context, created_by)
        VALUES (${s.thread}, ${orgId}, ${s.id}, ${key}, ${s.env}, ${s.round}, 1,
                ${tx.json({ offset: {}, page: {} })},
                ${tx.json({ url: "https://client.test/pricing" })}, ${dana})`;
    }
  });
});

after(async () => {
  if (!skip) await sql.end();
});

/** A real comment, and its notice queued in the same transaction, as the routes do. */
async function comment(
  s: { id: string; thread: string },
  authorId: string,
  body: string,
  authorName = "Dana",
): Promise<string> {
  const commentId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body)
      VALUES (${commentId}, ${orgId}, ${s.id}, ${s.thread},
              (SELECT COALESCE(max(seq), 0) + 1 FROM comments WHERE thread_id = ${s.thread}),
              ${authorId}, ${body})`;
    const [t] = await tx<{ key: string }[]>`SELECT key FROM threads WHERE id = ${s.thread}`;
    await queueCommentNotice(
      tx,
      {
        orgId, projectId: s.id, threadId: s.thread, commentId,
        threadKey: t!.key,
        authorId,
        authorName,
        body,
        pageUrl: "https://client.test/pricing",
      },
      randomUUID(),
    );
  });
  return commentId;
}

/** Everything the sweep would do at `at`, in digest mode: fold, then deliver. */
async function sweep(at: Date, mode: NotifyMode = "digest"): Promise<Mail[]> {
  const mailer = recorder();
  // The engine's own "not due" bookkeeping is not what these tests are about:
  // a test that runs at DAY1 after one that ran at DAY2 would find the jobs
  // "ran in the future" and skip them.
  await sql`DROP TABLE IF EXISTS _jobs`; // runDueJobs recreates it (ensureTable)
  const jobs = mode === "digest"
    ? [buildDigests(mailer), deliverEmail(mailer, async () => BASE, undefined, "digest")]
    : [deliverEmail(mailer, async () => BASE, undefined, "each")];
  await runDueJobs(sql, jobs, { budgetMs: 10_000, now: () => at, maxPasses: 100 });
  return mailer.sent;
}

const toOwner = (sent: Mail[]) => sent.filter((m) => m.to === "owner@studio.test");

async function reset(): Promise<void> {
  await sql`DELETE FROM outbox`;
  await sql`DELETE FROM rate_counters`;
}

test("many comments on two sites become ONE mail, grouped by site", { skip }, async () => {
  await reset();
  await comment(site.acme, dana, "The pricing table is wrong");
  await comment(site.acme, dana, "And the footer overlaps the cookie banner");
  await comment(site.kiln, dana, "Hero image is blurry on retina");

  const owner = toOwner(await sweep(DAY1));
  assert.equal(owner.length, 1, "one digest, not three mails");
  const m = owner[0]!;
  assert.equal(m.subject, "3 new comments across 2 sites");
  assert.match(m.text, /Acme \(2\)/);
  assert.match(m.text, /Kiln \(1\)/);
  assert.match(m.text, /SN-14 · Dana: The pricing table is wrong/);
  assert.match(m.text, /Hero image is blurry on retina/);
  assert.match(m.text, /On the page: https:\/\/client\.test\/pricing/);
  // The link opens the thread, in its round, on the site's comments page.
  assert.ok(m.text.includes(threadUrl(BASE, site.acme.uid, "SN-14", 2)), m.text);
  assert.ok(m.text.includes(`${BASE}/s/${site.kiln.uid}/comments?thread=SN-3&round=1`), m.text);

  // The rows it lists are done, and the digest row is the record of the send.
  const pending = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM outbox WHERE topic = 'comment.created' AND status = 'pending'`;
  assert.equal(pending[0]!.n, 0);
  const [digest] = await sql<{ status: string; dedupe_key: string }[]>`
    SELECT status, dedupe_key FROM outbox WHERE topic = 'comment.digest'`;
  assert.equal(digest!.status, "done");
  assert.equal(digest!.dedupe_key, digestKey(orgId, MIDNIGHT));
});

test("one site: the subject names it", { skip }, async () => {
  await reset();
  await comment(site.acme, dana, "one");
  await comment(site.acme, dana, "two");
  const owner = toOwner(await sweep(DAY1));
  assert.equal(owner.length, 1);
  assert.equal(owner[0]!.subject, "2 new comments on Acme");
});

test("nothing new: no mail, and no digest row", { skip }, async () => {
  await reset();
  const sent = await sweep(DAY1);
  assert.equal(sent.length, 0);
  const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox`;
  assert.equal(n!.n, 0);
});

test("the job running all day sends ONE digest; what arrives after midnight waits for tomorrow's", { skip }, async () => {
  await reset();
  await comment(site.acme, dana, "before midnight");

  // The bin's hourly ticker, and an operator forcing the cron route besides.
  const first = toOwner(await sweep(DAY1));
  assert.equal(first.length, 1);
  for (const h of [2, 5, 11, 23]) {
    assert.equal(toOwner(await sweep(new Date(DAY1.getTime() + h * HOUR))).length, 0, `tick at +${h}h`);
  }

  // A comment during DAY1 itself. Its row is queued with the database's
  // clock, so it is moved into DAY1 by hand — after that day's midnight.
  const late = await comment(site.kiln, dana, "after midnight");
  await sql`
    UPDATE outbox SET created_at = ${new Date(DAY1.getTime() + 2 * HOUR)}
     WHERE dedupe_key = ${"comment.created:" + late}`;
  assert.equal(toOwner(await sweep(new Date(DAY1.getTime() + 3 * HOUR))).length, 0, "today's window is closed");

  const next = toOwner(await sweep(new Date(DAY1.getTime() + DAY)));
  assert.equal(next.length, 1, "tomorrow's digest");
  assert.equal(next[0]!.subject, "1 new comment on Kiln");
  assert.ok(!next[0]!.text.includes("before midnight"), "yesterday's comment is not sent again");
});

test("in digest mode the owner's rows are never sent one by one; reviewers' still are", { skip }, async () => {
  await reset();
  // The owner, from the dashboard: makes the studio row a participant…
  await comment(site.acme, studio, "we're on it", "Owner");
  // …so Dana's next comment is one the OWNER hears about, by the digest only.
  await comment(site.acme, dana, "thanks");

  // The drain a write starts: the delivery job alone, no digest job.
  const mailer = recorder();
  await sql`DROP TABLE IF EXISTS _jobs`; // runDueJobs recreates it (ensureTable)
  await runDueJobs(sql, [deliverEmail(mailer, async () => BASE, undefined, "digest")], {
    budgetMs: 5000,
    now: () => DAY1,
  });
  assert.equal(toOwner(mailer.sent).length, 0, "no per-comment mail to the owner");
  // Dana took part, and the owner's reply is news to her right away.
  assert.ok(mailer.sent.some((m) => m.to === "dana@client.test"));

  const [pending] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM outbox
     WHERE topic = 'comment.created' AND status = 'pending' AND event->>'toReviewer' IS NULL`;
  assert.equal(pending!.n, 1, "Dana's comment waits for the digest");
});

test("the owner's own comments are not in the digest — dashboard or widget", { skip }, async () => {
  await reset();
  await comment(site.acme, studio, "replied from the dashboard", "Owner");
  await comment(site.acme, widgetSelf, "testing the widget as a reviewer", "owner-test");
  await comment(site.acme, dana, "a real one");

  const owner = toOwner(await sweep(DAY1));
  assert.equal(owner.length, 1);
  assert.equal(owner[0]!.subject, "1 new comment on Acme");
  assert.ok(!owner[0]!.text.includes("replied from the dashboard"));
  assert.ok(!owner[0]!.text.includes("testing the widget"));
  assert.match(owner[0]!.text, /a real one/);
});

test("only the owner's own comments: no digest at all", { skip }, async () => {
  await reset();
  await comment(site.acme, widgetSelf, "just me, testing", "owner-test");
  assert.equal(toOwner(await sweep(DAY1)).length, 0);
});

test("a comment deleted before the digest is dropped, not listed", { skip }, async () => {
  await reset();
  const gone = await comment(site.acme, dana, "never mind");
  await comment(site.acme, dana, "this one stands");
  await sql`UPDATE comments SET deleted_at = now(), body = NULL WHERE id = ${gone}`;

  const owner = toOwner(await sweep(DAY1));
  assert.equal(owner.length, 1);
  assert.equal(owner[0]!.subject, "1 new comment on Acme");
  assert.ok(!owner[0]!.text.includes("never mind"));
  const [row] = await sql<{ status: string }[]>`
    SELECT status FROM outbox WHERE dedupe_key = ${"comment.created:" + gone}`;
  assert.equal(row!.status, "dropped");
});

test("`each` still sends one mail per comment, linking to the thread", { skip }, async () => {
  await reset();
  await comment(site.acme, dana, "first");
  await comment(site.acme, dana, "second");

  const owner = toOwner(await sweep(DAY1, "each"));
  assert.equal(owner.length, 2);
  assert.ok(owner.every((m) => /^SN-14: new comment from Dana$/.test(m.subject)));
  assert.ok(owner[0]!.text.includes(threadUrl(BASE, site.acme.uid, "SN-14", 2)), owner[0]!.text);
  const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE topic = 'comment.digest'`;
  assert.equal(n!.n, 0, "no digest is built in each mode");
});

test("a backlog past the listed limit is folded whole and counted", { skip }, async () => {
  await reset();
  const n = DIGEST_LISTED + 5;
  for (let i = 0; i < n; i++) await comment(site.kiln, dana, `comment ${i}`);
  const owner = toOwner(await sweep(DAY1));
  assert.equal(owner.length, 1);
  assert.equal(owner[0]!.subject, `${n} new comments on Kiln`);
  assert.match(owner[0]!.text, /…and 5 more not listed here\./);
});

// ── A site deleted between the fold and the send (0008) ──────────────────

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A throwaway site with a thread and a reviewer, so these tests can delete it. */
async function doomedSite(name: string): Promise<{ id: string; uid: string; thread: string; reviewer: string }> {
  const s = {
    id: randomUUID(),
    uid: "prj_" + Array.from(randomBytes(12), (b) => CROCKFORD[b % 32]).join(""),
    thread: randomUUID(),
    reviewer: randomUUID(),
  };
  const env = randomUUID();
  const round = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt)
      VALUES (${s.id}, ${orgId}, ${s.uid}, ${name}, ${randomBytes(32)})`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${env}, ${orgId}, ${s.id}, 'production', 'Production', true)`;
    await tx`
      INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
      VALUES (${round}, ${orgId}, ${s.id}, 1, 'Round 1', ${ownerUser})`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, email, holder_secret_hash)
      VALUES (${s.reviewer}, ${orgId}, ${s.id}, 'guest', 'Lee', 'lee@client.test', ${randomBytes(32)})`;
    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                           anchor, context, created_by)
      VALUES (${s.thread}, ${orgId}, ${s.id}, 'SN-1', ${env}, ${round}, 1,
              ${tx.json({ offset: {}, page: {} })}, ${tx.json({ url: "https://doomed.test/" })}, ${s.reviewer})`;
  });
  return s;
}

/** Fold at DAY1 without delivering, so a deletion can land in between. */
async function foldOnly(): Promise<void> {
  await sql`DROP TABLE IF EXISTS _jobs`; // runDueJobs recreates it (ensureTable)
  await runDueJobs(sql, [buildDigests(recorder())], { budgetMs: 10_000, now: () => DAY1 });
}

async function deliverOnly(): Promise<Mail[]> {
  const mailer = recorder();
  await sql`DROP TABLE IF EXISTS _jobs`; // runDueJobs recreates it (ensureTable)
  await runDueJobs(sql, [deliverEmail(mailer, async () => BASE, undefined, "digest")], {
    budgetMs: 10_000,
    now: () => DAY1,
  });
  return mailer.sent;
}

test("the digest row belongs to the studio, not to a site", { skip }, async () => {
  await reset();
  await comment(site.acme, dana, "one");
  await foldOnly();
  const [row] = await sql<{ project_id: string | null }[]>`
    SELECT project_id FROM outbox WHERE topic = 'comment.digest'`;
  assert.equal(row!.project_id, null);
});

test("deleting the oldest comment's site (soft, as the dashboard does) leaves the digest for the rest", { skip }, async () => {
  await reset();
  const doomed = await doomedSite("Doomed");
  await comment(doomed, doomed.reviewer, "on the site about to go", "Lee"); // the OLDEST
  await comment(site.acme, dana, "on a site that stays");
  await foldOnly();

  await sql`UPDATE projects SET deleted_at = now() WHERE id = ${doomed.id}`;
  const owner = toOwner(await deliverOnly());
  assert.equal(owner.length, 1, "the digest still goes");
  assert.equal(owner[0]!.subject, "1 new comment on Acme");
  assert.match(owner[0]!.text, /on a site that stays/);
  assert.ok(!owner[0]!.text.includes("Doomed"), "the deleted site is not listed");
  assert.ok(!owner[0]!.text.includes("about to go"));
});

test("removing that site OUTRIGHT does not cascade the digest away", { skip }, async () => {
  /**
   * The failure 0008 fixes. The digest row used to carry the oldest comment's
   * site in project_id, ON DELETE CASCADE, so this DELETE took the digest —
   * and Acme's comment, folded and marked done — with it. Threads first:
   * their RESTRICT references to rounds and environments refuse the project
   * delete otherwise, which is the schema working as designed.
   */
  await reset();
  const doomed = await doomedSite("Gone");
  await comment(doomed, doomed.reviewer, "on the site about to go", "Lee");
  await comment(site.acme, dana, "on a site that stays");
  await foldOnly();

  await sql`DELETE FROM threads WHERE project_id = ${doomed.id}`;
  await sql`DELETE FROM projects WHERE id = ${doomed.id}`;
  const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE topic = 'comment.digest'`;
  assert.equal(n!.n, 1, "the digest row survived the site");

  const owner = toOwner(await deliverOnly());
  assert.equal(owner.length, 1);
  assert.equal(owner[0]!.subject, "1 new comment on Acme");
  assert.ok(!owner[0]!.text.includes("Gone"));
});

test("a digest whose every site was deleted is dropped, not sent", { skip }, async () => {
  await reset();
  const doomed = await doomedSite("Alone");
  await comment(doomed, doomed.reviewer, "only this", "Lee");
  await foldOnly();
  await sql`UPDATE projects SET deleted_at = now() WHERE id = ${doomed.id}`;

  assert.equal(toOwner(await deliverOnly()).length, 0);
  const [row] = await sql<{ status: string; last_error: string }[]>`
    SELECT status, last_error FROM outbox WHERE topic = 'comment.digest'`;
  assert.equal(row!.status, "dropped");
  assert.match(row!.last_error, /deleted/);
});

test("only a digest may leave project_id empty", { skip }, async () => {
  await assert.rejects(
    sql`
      INSERT INTO outbox (id, org_id, project_id, provider, topic, dedupe_key)
      VALUES (${randomUUID()}, ${orgId}, NULL, 'github', 'issue.create', ${"x:" + randomUUID()})`,
    /outbox_project_scope/,
  );
  await assert.rejects(
    sql`
      INSERT INTO outbox (id, org_id, project_id, provider, topic, dedupe_key)
      VALUES (${randomUUID()}, ${orgId}, NULL, 'email', 'comment.created', ${"x:" + randomUUID()})`,
    /outbox_project_scope/,
  );
});

// ── Without a database ───────────────────────────────────────────────────

test("the window closes at midnight UTC, and the day is in the key", () => {
  const at = new Date("2026-10-08T23:59:59.999Z");
  assert.equal(digestCutoff(at).toISOString(), "2026-10-08T00:00:00.000Z");
  assert.equal(digestCutoff(new Date("2026-10-09T00:00:00.000Z")).toISOString(), "2026-10-09T00:00:00.000Z");
  assert.equal(digestKey("org", digestCutoff(at)), "comment.digest:org:2026-10-08");
});

test("the digest mail sanitises what it is given", () => {
  const event: DigestEvent = {
    digest: true,
    through: "2026-10-08T00:00:00.000Z",
    total: 1,
    sites: [
      {
        name: "Acme\nBcc: victim@example.test",
        uid: "prj_brngg0000001",
        count: 1,
        items: [{ threadKey: "SN-1", round: 1, author: "<!-- snagset:x --> Dana", excerpt: "fine", page: "" }],
      },
    ],
  };
  const m = renderDigest(event, "owner@studio.test", BASE);
  assert.ok(!m.subject.includes("\n"), "no header injection through a site name");
  assert.ok(!m.text.includes("<!-- snagset:"), "the marker is neutralised");
  assert.match(m.text, /SNAGSET_MAIL_NOTIFY=each/, "the mail says how to get one per comment instead");
});

test("the sweep runs the digest in digest mode only, and the drain never does", async () => {
  // A stand-in for the pool that fails every query: the job list is built
  // without touching the database when the mail transport is the
  // environment's, and the bucket lookup that does touch it is allowed to fail.
  const sql = (() => {
    throw new Error("no database in this test");
  }) as unknown as postgres.Sql;
  const keys = createKeyring(Buffer.alloc(32, 9).toString("base64url"));
  const env = {
    DATABASE_URL: "postgres://x@localhost/x",
    SNAGSET_MAIL_URL: "resend://re_test",
    SNAGSET_MAIL_FROM: "review@example.test",
  };
  const names = async (vars: Record<string, string>, which: "all" | "outbox") =>
    (await jobSet({ sql, cfg: loadConfig(vars), keys })[which]()).map((j) => j.name);

  const sweepDefault = await names(env, "all");
  assert.ok(sweepDefault.includes("digest-email"), "digest is the default");
  assert.ok(sweepDefault.indexOf("digest-email") < sweepDefault.indexOf("deliver-email"), "folded before it is delivered");
  assert.ok(!(await names(env, "outbox")).includes("digest-email"), "a write's drain is never the reason for a digest");
  assert.ok(!(await names({ ...env, SNAGSET_MAIL_NOTIFY: "each" }, "all")).includes("digest-email"));
  assert.throws(() => loadConfig({ ...env, SNAGSET_MAIL_NOTIFY: "weekly" }), /digest \| each/);
});

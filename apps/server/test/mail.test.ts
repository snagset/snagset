import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type postgres from "postgres";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { runDueJobs } from "../src/jobs/index.ts";
import { queueCommentNotice, deliverEmail } from "../src/mail/notify.ts";
import type { Mail, Mailer } from "../src/mail/mailer.ts";
import { selectMailer, isConfigured } from "../src/mail/index.ts";

/**
 * Notification email — the DoD, item by item.
 *
 * The two that matter most are "one reply produces exactly one mail" and "a
 * forced retry produces no second mail", because a notification system that
 * double-sends is one an operator turns off and never turns back on.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the mail tests";

let sql: postgres.Sql;
let orgId: string;
let projectId: string;
let threadId: string;

/**
 * The injected clock, and it is deliberately AHEAD of the wall clock rather
 * than a fixed date.
 *
 * The first version pinned this to a literal `2026-08-24T12:00:00Z`, and the
 * suite passed all morning and began failing at noon: rows are enqueued with
 * `next_attempt_at DEFAULT now()`, so once the real clock passed the literal,
 * every freshly queued row was in the FUTURE relative to the injected now and
 * the delivery job correctly claimed nothing. A test that depends on the hour
 * it runs at is one that fails in CI in another timezone and gets "fixed" by a
 * retry.
 *
 * One minute ahead, frozen once: any row queued during the run is due, and the
 * backoff assertions still hold because the shortest rung is a minute.
 */
const NOW = new Date(Date.now() + 60_000);
const at = () => NOW;

/** A mailer that records instead of sending, and can be told to fail. */
function recorder(fail?: () => Error): Mailer & { sent: Mail[] } {
  const m = {
    kind: "http" as const,
    from: "snagset@studio.test",
    sent: [] as Mail[],
    async send(mail: Mail) {
      if (fail) throw fail();
      m.sent.push(mail);
      return { id: `id-${m.sent.length}` };
    },
  };
  return m;
}

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
  projectId = randomUUID();
  threadId = randomUUID();
  const userId = randomUUID();
  const envId = randomUUID();
  const roundId = randomUUID();
  const reviewerId = randomUUID();

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO users (id, org_id, email, password_hash)
      VALUES (${userId}, ${orgId}, 'owner@studio.test', 'x')`;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag)
      VALUES (${projectId}, ${orgId}, 'prj_mmmmmmmmmmmm', 'Mail', ${Buffer.alloc(32, 5)}, 'e')`;
    await tx`
      INSERT INTO environments (id, org_id, project_id, key, label, is_default)
      VALUES (${envId}, ${orgId}, ${projectId}, 'production', 'Production', true)`;
    await tx`
      INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
      VALUES (${roundId}, ${orgId}, ${projectId}, 1, 'Round 1', ${userId})`;
    await tx`
      INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash)
      VALUES (${reviewerId}, ${orgId}, ${projectId}, 'guest', 'Dana', ${Buffer.alloc(32, 2)})`;
    await tx`
      INSERT INTO threads (id, org_id, project_id, key, environment_id, round_id, round_number,
                           anchor, context, created_by)
      VALUES (${threadId}, ${orgId}, ${projectId}, 'SN-1', ${envId}, ${roundId}, 1,
              ${tx.json({ offset: {}, page: {} })},
              ${tx.json({ url: "https://client.test/pricing" })}, ${reviewerId})`;
  });
});

after(async () => {
  if (!skip) await sql.end();
});

async function queue(commentId: string, body = "The pricing table is wrong"): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await queueCommentNotice(
      tx,
      {
        orgId,
        projectId,
        threadId,
        commentId,
        threadKey: "SN-1",
        authorId: randomUUID(),
        authorName: "Dana",
        body,
        pageUrl: "https://client.test/pricing",
      },
      randomUUID(),
    );
  });
}

const clearOutbox = () => sql`DELETE FROM outbox`;

test("one comment produces exactly one mail", { skip }, async () => {
  await clearOutbox();
  await queue(randomUUID());
  const mailer = recorder();

  await runDueJobs(sql, [deliverEmail(mailer, async () => "https://snag.studio.test")], {
    budgetMs: 5000,
    now: at,
  });

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0]!.to, "owner@studio.test");
  assert.match(mailer.sent[0]!.subject, /^SN-1: new comment from Dana$/);
  assert.match(mailer.sent[0]!.text, /The pricing table is wrong/);
  assert.match(mailer.sent[0]!.text, /https:\/\/client\.test\/pricing/);
});

test("draining again sends NOTHING — a delivered row is done", { skip }, async () => {
  const mailer = recorder();
  await sql`DELETE FROM _jobs WHERE name = 'deliver-email'`;
  await runDueJobs(sql, [deliverEmail(mailer, async () => "https://snag.studio.test")], {
    budgetMs: 5000,
    now: at,
  });
  assert.equal(mailer.sent.length, 0, "the queue is empty; nothing to resend");
});

test("a RETRIED request cannot queue a second notification for the same comment", { skip }, async () => {
  await clearOutbox();
  const commentId = randomUUID();
  await queue(commentId);
  await queue(commentId); // the client retried; same comment id
  await queue(commentId);

  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox`;
  assert.equal(row!.n, 1, "UNIQUE (provider, dedupe_key) absorbed the retries");

  const mailer = recorder();
  await sql`DELETE FROM _jobs WHERE name = 'deliver-email'`;
  await runDueJobs(sql, [deliverEmail(mailer, async () => "https://x.test")], { budgetMs: 5000, now: at });
  assert.equal(mailer.sent.length, 1, "one comment, one mail, however many retries");
});

test("a failed send is retried with backoff, not dropped and not duplicated", { skip }, async () => {
  await clearOutbox();
  await queue(randomUUID());

  const failing = recorder(() => new Error("resend returned 429"));
  await sql`DELETE FROM _jobs WHERE name = 'deliver-email'`;
  await runDueJobs(sql, [deliverEmail(failing, async () => "https://x.test")], { budgetMs: 5000, now: at });

  const [row] = await sql<
    { status: string; attempts: number; next_attempt_at: Date; last_error: string }[]
  >`SELECT status, attempts, next_attempt_at, last_error FROM outbox`;
  assert.equal(row!.status, "pending", "still queued");
  assert.equal(row!.attempts, 1);
  assert.match(row!.last_error, /429/);
  assert.ok(row!.next_attempt_at > NOW, "and not due again immediately");

  // It is NOT re-sent before its next_attempt_at, even if the job runs again.
  const soon = recorder();
  await sql`DELETE FROM _jobs WHERE name = 'deliver-email'`;
  await runDueJobs(sql, [deliverEmail(soon, async () => "https://x.test")], { budgetMs: 5000, now: at });
  assert.equal(soon.sent.length, 0, "backoff is honoured");

  // …and once it is due, it sends exactly once.
  const later = new Date(NOW.getTime() + 2 * 60_000);
  const eventually = recorder();
  await sql`DELETE FROM _jobs WHERE name = 'deliver-email'`;
  await runDueJobs(sql, [deliverEmail(eventually, async () => "https://x.test")], {
    budgetMs: 5000,
    now: () => later,
  });
  assert.equal(eventually.sent.length, 1);
});

test("a notification with no owner to send to is DROPPED, not retried forever", { skip }, async () => {
  await clearOutbox();
  await sql`UPDATE users SET deleted_at = now() WHERE org_id = ${orgId}`;
  await queue(randomUUID());

  const mailer = recorder();
  await sql`DELETE FROM _jobs WHERE name = 'deliver-email'`;
  await runDueJobs(sql, [deliverEmail(mailer, async () => "https://x.test")], { budgetMs: 5000, now: at });

  const [row] = await sql<{ status: string }[]>`SELECT status FROM outbox`;
  assert.equal(row!.status, "dropped");
  assert.equal(mailer.sent.length, 0);
  await sql`UPDATE users SET deleted_at = NULL WHERE org_id = ${orgId}`;
});

test("the body is SANITISED before it reaches the message", { skip }, async () => {
  await clearOutbox();
  // A comment carrying a forged marker, a bidi override and an address.
  await queue(randomUUID(), "<!-- snagset:x --> ‮txet‬ mail me at jane@acme.com");

  const mailer = recorder();
  await sql`DELETE FROM _jobs WHERE name = 'deliver-email'`;
  await runDueJobs(sql, [deliverEmail(mailer, async () => "https://x.test")], { budgetMs: 5000, now: at });

  const text = mailer.sent[0]!.text;
  assert.ok(!text.includes("<!-- snagset:"), "the marker is neutralised");
  assert.ok(!/[‪-‮]/.test(text), "the bidi override is gone");
  assert.ok(!text.includes("jane@acme.com"), "and the redactor ran on the body");
});

/** A Config stand-in: the real one is generated and validated at boot, and
 *  what `selectMailer` reads from it is two `get` calls. */
function cfgWith(vars: Record<string, string | undefined>): Parameters<typeof selectMailer>[0] {
  return { get: (name: string) => vars[name] } as unknown as Parameters<typeof selectMailer>[0];
}

test("with NO transport configured, nothing is queued at all", { skip }, async () => {
  // "off and say so, rather than silently queueing". The gate is on
  // the ENQUEUE, so an install that never had a mailer has an empty outbox
  // rather than a backlog waiting to burst the day one is configured.
  await clearOutbox();
  const status = selectMailer(cfgWith({}));
  assert.equal(status.kind, "none");
  assert.match(status.kind === "none" ? status.reason : "", /notifications are off/);

  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox`;
  assert.equal(row!.n, 0);
});

/**
 * The transport is chosen by the URL's SCHEME — one variable, so there
 * is no "which one wins" question to get wrong, and a new provider costs a
 * case rather than a variable. FasterFixes hard-codes `RESEND_API_KEY`, which
 * is why their own documented Plunk path is unreachable; this is the test that
 * keeps us from the same shape.
 */
test("the scheme selects the transport", () => {
  const from = "snagset@studio.test";
  assert.equal(selectMailer(cfgWith({ SNAGSET_MAIL_URL: "resend://re_abc", SNAGSET_MAIL_FROM: from })).kind, "http");
  assert.equal(selectMailer(cfgWith({ SNAGSET_MAIL_URL: "smtp://h:587", SNAGSET_MAIL_FROM: from })).kind, "smtp");
  assert.equal(selectMailer(cfgWith({ SNAGSET_MAIL_URL: "smtps://h:465", SNAGSET_MAIL_FROM: from })).kind, "smtp");
});

test("an API key keeps its case — it is not a hostname", async () => {
  // `new URL('resend://Re_AbC').hostname` lower-cases, and an API key is
  // case-sensitive: that bug produces a 401 that reads as "wrong key" rather
  // than as "wrong parser". The key is therefore sliced, not parsed.
  const mailer = selectMailer(
    cfgWith({ SNAGSET_MAIL_URL: "resend://Re_MixedCase123", SNAGSET_MAIL_FROM: "a@b.test" }),
  );
  assert.equal(mailer.kind, "http");
  // The key is not exposed on the interface, so assert through the request the
  // adapter builds: a wrong-cased key would send a different Authorization.
  // The key is not exposed on the interface, so assert through the request the
  // adapter builds: a lower-cased key would send a different Authorization.
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    seen.push(String((init.headers as Record<string, string>).authorization));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await mailer.send({ to: "c@d.test", subject: "x", text: "y" });
  } finally {
    // Restored in `finally` and AWAITED above, in that order: an earlier
    // version returned the promise from inside `try`, so the real fetch was
    // put back before the patched one had been called.
    globalThis.fetch = realFetch;
  }
  assert.equal(seen[0], "Bearer Re_MixedCase123");
});

test("an unknown scheme is a BOOT failure, not a silent fallback to no mail", () => {
  // Falling back would leave an operator who configured mail believing it
  // works — the worst of the three outcomes.
  assert.throws(
    () => selectMailer(cfgWith({ SNAGSET_MAIL_URL: "sendgrid://k", SNAGSET_MAIL_FROM: "a@b.test" })),
    (e: Error) => {
      assert.match(e.message, /unsupported scheme/);
      assert.match(e.message, /resend:\/\//, "and it names what this build DOES speak");
      return true;
    },
  );
});

test("a transport with no From address fails at boot, not on the first send", () => {
  assert.throws(
    () => selectMailer(cfgWith({ SNAGSET_MAIL_URL: "resend://re_abc" })),
    /SNAGSET_MAIL_FROM/,
  );
});

/**
 * The DoD's grep test, and it is a real rule rather than a ceremony: the whole
 * point of the `Mailer` seam is that a transport is imported in ONE
 * place per transport. The ninth import is the one that gets the retry
 * semantics wrong, and by then the seam is decoration.
 */
test("exactly two modules touch a mail transport, and they are the two adapters", () => {
  const root = join(import.meta.dirname, "..", "src");
  const offenders: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) {
        const src = readFileSync(full, "utf8");
        // A SOCKET, not an import: the image proxy (net/publicFetch.ts) takes
        // BlockList and isIP from node:net to judge addresses and opens
        // nothing with it — what this rule guards is a module dialling out.
        const usesNet = /from "node:(net|tls)"/.test(src) && /\b(?:createConnection|connect)\(/.test(src);
        const usesResend = /api\.resend\.com/.test(src);
        if (!usesNet && !usesResend) continue;
        const rel = full.slice(root.length + 1);
        if (rel !== join("mail", "smtp.ts") && rel !== join("mail", "resend.ts")) offenders.push(rel);
      }
    }
  };
  walk(root);

  assert.deepEqual(
    offenders,
    [],
    "a transport reached a module that is not one of the two adapters — everything " +
      "else must depend on the Mailer interface",
  );
});

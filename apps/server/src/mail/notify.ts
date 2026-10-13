import type { AddressSource } from "../instance/address.ts";
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sanitise, sanitiseWithRedactor } from "@snagset/adapters";
import { redactText } from "@snagset/widget/redact";
import type { Job, JobContext, JobOutcome } from "../jobs/index.ts";
import { noteQueued } from "../jobs/soon.ts";
import { isConfigured, type Mailer, type MailerStatus } from "./mailer.ts";
import type { Keyring } from "../keys.ts";
import { unsubscribeHeaders, unsubscribeToken } from "./unsubscribe.ts";
import { DIGEST_TOPIC, pruneDigest, renderDigest, type DigestEvent } from "./digest.ts";
import { threadLink } from "./links.ts";
import {
  ASSIGNED_TOPIC,
  assignedRecipient,
  claimSiblings,
  liveAssignments,
  renderAssigned,
  type ClaimedRow,
} from "./assigned.ts";

/**
 * Notification email, and deliberately ONE event.
 *
 * `comment.created` → the project owner, and nothing else. Not because the
 * others are hard, but because of who they mail: `thread.created` and
 * `thread.resolved` go to *reviewers*, whose addresses are self-declared and
 * unverified, and a system that mails unverified third-party addresses on a
 * stranger's trigger is an open relay with extra steps. The owner's address is
 * one we verified at claim time, so with only owner mail that abuse surface
 * does not exist yet. The rest lands with full, behind subscription and
 * unsubscribe.
 *
 * Now the owner's half arrives as a DAILY DIGEST by default
 * (`SNAGSET_MAIL_NOTIFY=digest`): the rows below are queued exactly
 * as before, the delivery job leaves them alone, and `digest.ts` folds a day's
 * worth into one outbox row of its own. `each` restores one mail per comment.
 * In both modes nobody is mailed about a comment they wrote — see
 * `queueCommentNotice`.
 *
 * ── HOW "A RETRY NEVER DOUBLE-SENDS" IS ACTUALLY ACHIEVED ──
 *
 * Two mechanisms, and both are needed:
 *
 *   1. **Enqueue is idempotent.** The row is inserted in the SAME transaction
 *      as the comment, with `dedupe_key = 'comment.created:<commentId>'` and
 *      `UNIQUE (provider, dedupe_key)` behind it. A retried request that
 *      re-creates the same comment cannot create a second row.
 *   2. **Claiming is atomic.** The delivery job moves a row `pending →
 *      inflight` with `UPDATE … WHERE status = 'pending' … RETURNING` and
 *      `SKIP LOCKED`, so two instances draining at once take disjoint sets.
 *
 * What neither can prevent is a crash between "the provider accepted it" and
 * "we wrote `done`". That window is real and cannot be closed without a
 * distributed transaction across an HTTP API; the honest posture is to make it
 * SMALL and to fail toward not-sending rather than toward sending twice — so
 * the row is marked `inflight` before the send and only a completed send
 * writes `done`. A row stuck `inflight` is visible and is not retried
 * automatically, because an automatic retry is exactly the duplicate.
 */

const TOPIC = "comment.created";

export interface CommentNotice {
  readonly orgId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly commentId: string;
  /** Already-stored values; this function does not read them back. */
  readonly threadKey: string;
  /** The comment's author, so they are not mailed about their own words. */
  readonly authorId: string;
  readonly authorName: string;
  readonly body: string;
  readonly pageUrl: string;
}

/**
 * Queue one notification, INSIDE the caller's transaction.
 *
 * Taking `tx` rather than a pool is the whole design: The design requires outbox
 * rows to be inserted in the same transaction as the domain mutation, and the
 * reason is not tidiness. A comment that commits without its notification row
 * is a notification that never happens; a notification row that commits
 * without its comment is mail about something that does not exist. Only one
 * transaction can rule out both.
 *
 * `ON CONFLICT DO NOTHING` rather than an error: a duplicate here means the
 * caller retried, which is the case the dedupe key exists to absorb quietly.
 */
export async function queueCommentNotice(
  tx: postgres.TransactionSql | postgres.Sql,
  notice: CommentNotice,
  id: string,
): Promise<void> {
  const payload = {
    threadKey: notice.threadKey,
    authorName: notice.authorName,
    body: notice.body,
    pageUrl: notice.pageUrl,
    commentId: notice.commentId,
  };

  const owner = await ownerOf(tx, notice.orgId);
  const author = await reviewerIdentity(tx, notice.authorId);

  /**
   * THE OWNER's row — unless the owner wrote this comment.
   *
   * "If there is a comment we made, we don't need to receive the email." The
   * owner writes in two ways and both are theirs: from the dashboard, where
   * the author is their studio reviewer row (`user_id` set), and through the
   * widget on their own site, where the author is whatever reviewer identity
   * they typed — "owner-test" — with their own address in it. The first is
   * matched by user id, the second by address, case-insensitively, because an
   * address typed into a widget has whatever capitals the hand gave it.
   *
   * Decided HERE, at enqueue, rather than at send: the row that is never
   * written is the one that cannot be sent in `each` mode and cannot be folded
   * into a digest in `digest` mode, so one check covers both.
   *
   * No recipient in the event: the delivery job reads that absence as "the
   * project owner", which is what every row queued before the fan-out existed
   * also means. Backward compatibility by shape rather than by version flag.
   */
  if (!isSamePerson(author, owner)) {
    await tx`
      INSERT INTO outbox (id, org_id, project_id, thread_id, provider, topic, dedupe_key, event)
      VALUES (
        ${id}, ${notice.orgId}, ${notice.projectId}, ${notice.threadId},
        'email', ${TOPIC}, ${`${TOPIC}:${notice.commentId}`}, ${tx.json(payload)}
      )
      ON CONFLICT (provider, dedupe_key) DO NOTHING
    `;
  }

  /**
   * …and ONE ROW PER PARTICIPANT — B2's "created or replied".
   *
   * Fanned out at enqueue rather than at send, because every guarantee this
   * system has is per-row: `UNIQUE (provider, dedupe_key)` makes a retry a
   * no-op for THAT recipient, and a provider rejecting one address cannot
   * take the others down with it. One row addressed to N people would have
   * neither property.
   *
   * The subscription rule is derived, not stored — a reviewer is subscribed to
   * a thread because they wrote on it. There is deliberately no endpoint that
   * subscribes an arbitrary address, because that endpoint is the one an
   * abuser wants.
   *
   * Excluded: the author of this very comment (nobody needs mail about their
   * own typing), anyone with no address, anyone who unsubscribed, and anyone
   * blocked or erased.
   *
   * …and THE OWNER, under any identity. The owner already has the row
   * above; if they have also replied on this thread from the dashboard, their
   * studio reviewer row is a participant too, and without this they got the
   * same comment twice — and in `digest` mode the participant copy would have
   * arrived at once, around the digest that exists to stop exactly that.
   */
  await fanOut(tx, {
    orgId: notice.orgId,
    projectId: notice.projectId,
    threadId: notice.threadId,
    topic: TOPIC,
    keyPrefix: `${TOPIC}:${notice.commentId}`,
    exclude: notice.authorId,
    excludeEmail: author?.email ?? null,
    excludeOwner: owner,
    payload,
  });
  // The request drains this once its response is ready.
  noteQueued();
}

/**
 * Everyone who took part in a thread, minus one person, each in their own row.
 *
 * Shared by both topics because the SUBSCRIPTION RULE is the thing that must
 * not drift: "created or replied" answered in two places is how the two
 * answers diverge, and the divergence is always in the direction of mailing
 * somebody who did not ask.
 */
async function fanOut(
  tx: postgres.TransactionSql | postgres.Sql,
  o: {
    orgId: string;
    projectId: string;
    threadId: string;
    topic: string;
    /** `<topic>:<entityId>` — the recipient id is appended per row. */
    keyPrefix: string;
    /** The person who caused the event; they do not hear about themselves. */
    exclude: string;
    /**
     * …nor under ANOTHER identity with the same address. One person can
     * hold several reviewer rows in a project — a studio row from the
     * dashboard, a name typed into the widget to test it — and "their own
     * comment" is a fact about the person, which the address is the best
     * evidence of that we have. Null when the author left no address.
     */
    excludeEmail?: string | null;
    /** The owner, when they hear about this topic by their own row instead. */
    excludeOwner?: Owner | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const email = o.excludeEmail ?? null;
  const ownerUser = o.excludeOwner?.userId ?? null;
  const ownerEmail = o.excludeOwner?.email ?? null;
  const participants = await tx<{ id: string }[]>`
    SELECT DISTINCT r.id
      FROM comments c
      JOIN reviewers r ON r.id = c.author_id
     WHERE c.thread_id = ${o.threadId}
       AND c.deleted_at IS NULL
       AND r.id <> ${o.exclude}::uuid
       AND r.email IS NOT NULL
       AND r.notifications_off_at IS NULL
       AND r.blocked_at IS NULL
       AND r.erased_at IS NULL
       AND (${email}::text IS NULL OR lower(r.email) <> lower(${email}::text))
       AND (${ownerUser}::uuid IS NULL OR r.user_id IS DISTINCT FROM ${ownerUser}::uuid)
       AND (${ownerEmail}::text IS NULL OR lower(r.email) <> lower(${ownerEmail}::text))
  `;

  for (const p of participants) {
    await tx`
      INSERT INTO outbox (id, org_id, project_id, thread_id, provider, topic, dedupe_key, event)
      VALUES (
        ${randomUUID()}, ${o.orgId}, ${o.projectId}, ${o.threadId},
        'email', ${o.topic}, ${`${o.keyPrefix}:${p.id}`},
        ${tx.json({ ...o.payload, toReviewer: p.id })}
      )
      ON CONFLICT (provider, dedupe_key) DO NOTHING
    `;
  }
}

/** The person `comment.created` mail goes to when a row names no reviewer. */
export interface Owner {
  readonly userId: string;
  readonly email: string;
}

/**
 * THE owner of an org — the first `owner` membership, as it has always been
 * chosen for owner mail. One query in one place, because "who is the owner"
 * answered differently at enqueue (am I mailing myself?) and at send (whom do
 * I mail?) is how the self-check passes and the mail still arrives.
 */
export async function ownerOf(
  sql: postgres.Sql | postgres.TransactionSql,
  orgId: string,
): Promise<Owner | null> {
  const [owner] = await sql<{ user_id: string; email: string }[]>`
    SELECT u.id AS user_id, u.email
      FROM memberships m
      JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ${orgId} AND m.role = 'owner' AND u.deleted_at IS NULL
     ORDER BY m.created_at
     LIMIT 1`;
  return owner ? { userId: owner.user_id, email: owner.email } : null;
}

interface Identity {
  readonly userId: string | null;
  readonly email: string | null;
}

/** A reviewer row's link to a person: the dashboard user behind it, and its address. */
async function reviewerIdentity(
  sql: postgres.Sql | postgres.TransactionSql,
  reviewerId: string,
): Promise<Identity | null> {
  const [r] = await sql<{ user_id: string | null; email: string | null }[]>`
    SELECT user_id, email FROM reviewers WHERE id = ${reviewerId}::uuid`;
  return r ? { userId: r.user_id, email: r.email } : null;
}

/**
 * Is this reviewer identity the owner? By user id first — the studio row the
 * dashboard writes with — and then by address, case-insensitively, which is
 * what catches the owner reviewing their own site through the widget.
 */
export function isSamePerson(who: Identity | null, owner: Owner | null): boolean {
  if (!who || !owner) return false;
  if (who.userId && who.userId === owner.userId) return true;
  return !!who.email && who.email.trim().toLowerCase() === owner.email.trim().toLowerCase();
}

const RESOLVED = "thread.resolved";

export interface ResolvedNotice {
  readonly orgId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly threadKey: string;
  /** `threads.version` AFTER the update — see the dedupe note below. */
  readonly version: number;
  /** Who resolved it. They are not told about their own click. */
  readonly actorId: string;
  readonly actorName: string;
  readonly pageUrl: string;
}

/**
 * "Somebody marked your snag resolved" — B2's second topic.
 *
 * This one goes to PARTICIPANTS and not to the owner, which is the opposite of
 * `comment.created` and deliberate: resolving is almost always the studio's own
 * act, and mailing the owner about a button they just pressed is the noise that
 * teaches people to filter the sender.
 *
 * The dedupe key carries `threads.version`, which is the documented
 * composition (`'<topic>:<entityId>:<threads.version>'`) and matters here more
 * than anywhere else: a thread can be resolved, reopened and resolved again,
 * and each of those is a real event that people should hear about. Keying on
 * the thread id alone would send the first one and silently swallow every
 * reopening after it.
 */
export async function queueResolvedNotice(
  tx: postgres.TransactionSql | postgres.Sql,
  notice: ResolvedNotice,
): Promise<void> {
  await fanOut(tx, {
    orgId: notice.orgId,
    projectId: notice.projectId,
    threadId: notice.threadId,
    topic: RESOLVED,
    keyPrefix: `${RESOLVED}:${notice.threadId}:${notice.version}`,
    exclude: notice.actorId,
    // The person who clicked, under any identity — the same rule as a comment.
    excludeEmail: (await reviewerIdentity(tx, notice.actorId))?.email ?? null,
    payload: {
      threadKey: notice.threadKey,
      actorName: notice.actorName,
      pageUrl: notice.pageUrl,
      resolved: true,
    },
  });
  noteQueued();
}

/**
 * `SNAGSET_MAIL_NOTIFY`: how the OWNER hears about a comment.
 * `digest` — the product's default, applied by `jobs/set.ts` from the
 * registry — leaves the owner's `comment.created` rows for `digest.ts` to
 * fold into one mail a day; `each` sends them one by one, as.
 */
export type NotifyMode = "digest" | "each";

interface OutboxRow {
  id: string;
  org_id: string;
  /** Null only on a `comment.digest` row, which is the studio's (0008). */
  project_id: string | null;
  attempts: number;
  thread_id: string | null;
  topic: string;
  event: {
    threadKey?: string;
    authorName?: string;
    body?: string;
    pageUrl?: string;
    /** `thread.resolved` rows carry these two instead of a body. */
    resolved?: boolean;
    actorName?: string;
    /** Absent ⇒ the project owner. Present ⇒ this reviewer. */
    toReviewer?: string;
  };
}

/** Retry ladder, in minutes. Five attempts over roughly an hour, then the row
 *  is `failed` and stays for the dashboard's "these never sent" list
 *  keeps failed rows until an operator dismisses them. */
const BACKOFF_MIN = [1, 5, 15, 30, 60];

/**
 * The delivery job. Registered only when a mailer is configured — with none,
 * there is nothing to drain and the absence is reported at boot instead.
 *
 * `notify` defaults to `each` HERE — the job's behaviour, for a
 * caller that does not say — while the PRODUCT's default is `digest`, which
 * `jobs/set.ts` reads from the registry. The registry is where a default an
 * operator can see belongs; a function's default is only what it does when
 * nobody asked.
 */
export function deliverEmail(
  mailer: MailerStatus,
  address: AddressSource,
  keys?: Keyring,
  notify: NotifyMode = "each",
): Job {
  return {
    name: "deliver-email",
    everyMs: 30_000,
    async run({ sql, now, log }: JobContext): Promise<JobOutcome> {
      // The address as it is NOW — the owner may have changed it since boot.
      const baseUrl = await address();
      if (!isConfigured(mailer)) return { did: 0 };

      // Claim ONE row at a time. A batch would be faster and would also mean
      // that one provider timeout takes the whole batch's rows to `inflight`
      // with nothing sent. One row per pass, `more: true` to drain — the
      // engine's batching, reused rather than reinvented.
      //
      // In `digest` mode the owner's comment rows are NOT claimable: they wait
      // for `digest.ts` to fold them. Excluded in the claim itself rather than
      // claimed and put back, because a row moved to `inflight` and back is a
      // row the "never twice" machinery has to reason about for nothing.
      const [row] = await sql<OutboxRow[]>`
        UPDATE outbox SET status = 'inflight', attempts = attempts + 1
         WHERE id = (
           SELECT id FROM outbox
            WHERE provider = 'email'
              AND status = 'pending'
              AND next_attempt_at <= ${now}
              ${notify === "digest" ? sql`AND NOT (topic = ${TOPIC} AND event->>'toReviewer' IS NULL)` : sql``}
            ORDER BY next_attempt_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
        RETURNING id, org_id, project_id, thread_id, topic, attempts, event
      `;
      if (!row) return { did: 0 };

      // An assignment is delivered as a BATCH — this row and every
      // other due one for the same address — by its own path below.
      if (row.topic === ASSIGNED_TOPIC) {
        return deliverAssigned(sql, row as unknown as ClaimedRow, { mailer, keys, baseUrl, now, log });
      }

      /**
       * WHO this row is for. Absent `toReviewer` means the project owner —
       * which is also what every row queued before the fan-out existed means,
       * so the absence is the compatibility story rather than a version flag.
       */
      const to = await recipient(sql, row, keys, baseUrl);
      if (!to) {
        // Nothing to send this to is not a transient failure and is not
        // retried: it is `dropped`, the status the design has for exactly this.
        // Reached when the owner is gone, or when a reviewer unsubscribed,
        // was blocked or erased between enqueue and send — which is a real
        // window, and re-checking here is what closes it.
        await sql`UPDATE outbox SET status = 'dropped', last_error = 'no deliverable recipient', completed_at = ${now} WHERE id = ${row.id}`;
        return { did: 0, more: true, note: "one notification had no recipient — dropped" };
      }

      // A digest without the sites deleted since it was folded; with none
      // left there is nothing to say, and it is dropped before it can count
      // against the address's allowance.
      let digest: DigestEvent | null = null;
      if (row.topic === DIGEST_TOPIC) {
        digest = await pruneDigest(sql, row.org_id, row.event as unknown as DigestEvent);
        if (!digest) {
          await sql`UPDATE outbox SET status = 'dropped', last_error = 'every site in the digest was deleted', completed_at = ${now} WHERE id = ${row.id}`;
          return { did: 0, more: true, note: "one digest listed only deleted sites — dropped" };
        }
      }

      /**
       * PER-ADDRESS RATE LIMIT — B2's last piece.
       *
       * A busy round can produce a burst: five people replying on one thread
       * inside a minute is four notifications each. That is not abuse, it is
       * a lively review, and the remedy is not to drop mail but to slow it —
       * so an address over its hourly allowance has the row DEFERRED to the
       * end of its window rather than dropped. Nothing is lost; it arrives
       * late, which is the correct trade for a notification.
       *
       * The bucket key is a HASH of the address, never the address itself.
       * `rate_counters` is a durable table that outlives the mail it governs,
       * and the rule about not keeping raw identifiers applies to a
       * counter as much as to a log.
       */
      const over = await overRateLimit(sql, row.org_id, to.email, now);
      if (over) {
        await sql`
          UPDATE outbox
             SET status = 'pending', next_attempt_at = ${over},
                 last_error = 'rate limited for this address'
           WHERE id = ${row.id}`;
        return { did: 0, more: true, note: "one notification deferred — address over its hourly rate" };
      }

      // The digest is its own message (`digest.ts`); every other row links
      // to its thread, read now — outside the `try`, because a failing read
      // is the database's problem, not a send to back off from.
      const mail = digest
        ? renderDigest(digest, to.email, baseUrl)
        : render(row, to.email, await threadLink(sql, row.thread_id, baseUrl));

      try {
        await mailer.send({ ...mail, ...(to.headers ? { headers: to.headers } : {}) });
        await sql`
          UPDATE outbox SET status = 'done', completed_at = ${now}, last_error = NULL
           WHERE id = ${row.id}`;
        return { did: 1, more: true };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const wait = BACKOFF_MIN[Math.min(row.attempts - 1, BACKOFF_MIN.length - 1)]!;
        const exhausted = row.attempts >= BACKOFF_MIN.length;
        await sql`
          UPDATE outbox
             SET status = ${exhausted ? "failed" : "pending"},
                 last_error = ${message},
                 next_attempt_at = ${new Date(now.getTime() + wait * 60_000)}
           WHERE id = ${row.id}`;
        log(`jobs: deliver-email: attempt ${row.attempts} failed: ${message}`);
        // `more` even on failure: the NEXT row may be fine, and one bad
        // recipient must not stall the queue behind it.
        return { did: 0, more: true };
      }
    },
  };
}

/**
 * The delivery: one claimed `thread.assigned` row, plus every other due
 * assignment for the same address in the same studio, as ONE mail.
 *
 * Everything that makes the single-row path safe is kept, applied to the set:
 * every row is claimed `inflight` before the send and only a completed send
 * writes `done`; the per-address rate limit is counted ONCE (it is one mail),
 * and a deferral or a failure puts the whole set back together, so the next
 * attempt is the same batch rather than its pieces one by one. What is no
 * longer news — reassigned, resolved, deleted, already answered — is dropped
 * with its reason before anything is rendered.
 */
async function deliverAssigned(
  sql: postgres.Sql | postgres.TransactionSql,
  row: ClaimedRow,
  o: { mailer: Mailer; keys: Keyring | undefined; baseUrl: string; now: Date; log: (m: string) => void },
): Promise<JobOutcome> {
  const { now } = o;
  const to = await assignedRecipient(sql, row);
  if (!to) {
    await sql`UPDATE outbox SET status = 'dropped', last_error = 'no deliverable recipient', completed_at = ${now} WHERE id = ${row.id}`;
    return { did: 0, more: true, note: "one assignment had no recipient — dropped" };
  }

  const rows = [row, ...(await claimSiblings(sql, row, to.email, now))];
  const { live, dropped } = await liveAssignments(sql, rows);
  for (const d of dropped) {
    await sql`UPDATE outbox SET status = 'dropped', last_error = ${d.reason}, completed_at = ${now} WHERE id = ${d.id}`;
  }
  if (live.length === 0) return { did: 0, more: true, note: `${dropped.length} assignment(s) no longer news — dropped` };
  const ids = live.map((i) => i.rowId);

  const over = await overRateLimit(sql, row.org_id, to.email, now);
  if (over) {
    await sql`
      UPDATE outbox SET status = 'pending', next_attempt_at = ${over}, last_error = 'rate limited for this address'
       WHERE id = ANY(${ids}::uuid[])`;
    return { did: 0, more: true, note: "one assignment mail deferred — address over its hourly rate" };
  }

  const mail = renderAssigned(live, to.email, o.baseUrl);
  // The opt-out is the reviewer row's (B2) — this mail's own row. A studio
  // member is a reviewer too, so the link works for them as for a client.
  const headers = o.keys ? unsubscribeHeaders(o.baseUrl, unsubscribeToken(o.keys, to.reviewerId)) : undefined;
  try {
    await o.mailer.send({ ...mail, ...(headers ? { headers } : {}) });
    await sql`
      UPDATE outbox SET status = 'done', completed_at = ${now}, last_error = NULL
       WHERE id = ANY(${ids}::uuid[])`;
    return { did: 1, more: true, ...(live.length > 1 ? { note: `${live.length} assignments in one mail` } : {}) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const wait = BACKOFF_MIN[Math.min(row.attempts - 1, BACKOFF_MIN.length - 1)]!;
    const exhausted = row.attempts >= BACKOFF_MIN.length;
    await sql`
      UPDATE outbox
         SET status = ${exhausted ? "failed" : "pending"},
             last_error = ${message},
             next_attempt_at = ${new Date(now.getTime() + wait * 60_000)}
       WHERE id = ANY(${ids}::uuid[])`;
    o.log(`jobs: deliver-email: assignment mail attempt ${row.attempts} failed: ${message}`);
    return { did: 0, more: true };
  }
}

/**
 * How many notifications one address may receive per hour.
 *
 * A constant rather than a registered variable, on purpose: The config is
 * generated from the spec, and a number nobody has yet wanted to change is not
 * worth a variable an operator has to read past. It becomes one the first time
 * somebody asks — which is a better trigger than a guess.
 *
 * Twelve is roughly "a busy thread every five minutes" and well under what any
 * provider treats as a pattern.
 */
const PER_ADDRESS_HOURLY = 12;
const RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Count this send against the address's hourly allowance.
 *
 * Returns null when it is within the allowance, or the time the window resets
 * when it is not. The counter is incremented BEFORE the send, so a provider
 * timeout still consumes the allowance — deliberately, because the alternative
 * is a failing address retrying without limit.
 */
async function overRateLimit(
  sql: postgres.Sql | postgres.TransactionSql,
  orgId: string,
  email: string,
  now: Date,
): Promise<Date | null> {
  const key = `mail:${createHash("sha256").update(email.toLowerCase()).digest("base64url")}`;
  const windowStart = new Date(now.getTime() - RATE_WINDOW_MS);

  const [row] = await sql<{ count: string; window_start: Date }[]>`
    INSERT INTO rate_counters (org_id, bucket_key, window_start, count, expires_at)
    VALUES (${orgId}, ${key}, ${now}, 1, ${new Date(now.getTime() + RATE_WINDOW_MS)})
    ON CONFLICT (org_id, bucket_key) DO UPDATE
      SET count = CASE WHEN rate_counters.window_start < ${windowStart} THEN 1
                       ELSE rate_counters.count + 1 END,
          window_start = CASE WHEN rate_counters.window_start < ${windowStart} THEN ${now}
                              ELSE rate_counters.window_start END,
          expires_at = CASE WHEN rate_counters.window_start < ${windowStart}
                            THEN ${new Date(now.getTime() + RATE_WINDOW_MS)}
                            ELSE rate_counters.expires_at END
    RETURNING count::text, window_start
  `;
  if (!row) return null;
  if (Number(row.count) <= PER_ADDRESS_HOURLY) return null;
  return new Date(new Date(row.window_start).getTime() + RATE_WINDOW_MS);
}

/**
 * The address this row goes to, and the headers that go with it.
 *
 * Returns null when there is nobody to send to — including the reviewer who
 * unsubscribed AFTER the row was queued. That re-check is not belt-and-braces:
 * the outbox retries over an hour, and "I clicked unsubscribe and then got
 * another one" is precisely the complaint the feature exists to prevent.
 *
 * Only REVIEWER mail carries `List-Unsubscribe`. The owner is the operator of
 * the instance: they did not receive a message from a stranger, they configured
 * the mailer that sends it, and the control they need is a setting rather than
 * a link. Giving them a one-click opt-out signed over a reviewer id they do not
 * have would be a link that cannot work.
 */
async function recipient(
  sql: postgres.Sql | postgres.TransactionSql,
  row: OutboxRow,
  keys: Keyring | undefined,
  baseUrl: string,
): Promise<{ email: string; headers?: Record<string, string> } | null> {
  const reviewerId = row.event.toReviewer;
  if (reviewerId) {
    const [r] = await sql<{ email: string | null }[]>`
      SELECT email FROM reviewers
       WHERE id = ${reviewerId}::uuid
         AND notifications_off_at IS NULL
         AND blocked_at IS NULL
         AND erased_at IS NULL`;
    if (!r?.email) return null;
    // No keyring means no signable link, and an unsubscribe header we cannot
    // honour is worse than none: send the mail without it rather than mint a
    // URL that 404s.
    return keys
      ? { email: r.email, headers: unsubscribeHeaders(baseUrl, unsubscribeToken(keys, reviewerId)) }
      : { email: r.email };
  }

  const owner = await ownerOf(sql, row.org_id);
  return owner ? { email: owner.email } : null;
}

/**
 * The message.
 *
 * Every reviewer-supplied string goes through the sanitiser before it
 * reaches a subject line or a body — this is a channel we do not control, and
 * the name and body are exactly the Class R/P fields the design is about. The
 * body additionally gets the redactor, because a comment can contain anything
 * the reviewer typed, including an address or a token they pasted in.
 *
 * Text only, no HTML. An HTML part would need its own escaping rules on top of
 * the ones above, and the message is four lines: who, where, what, and a link.
 * There is nothing here that a `<div>` would make clearer.
 */
function render(row: OutboxRow, to: string, link: string): {
  to: string;
  subject: string;
  text: string;
} {
  const key = sanitise(row.event.threadKey ?? "a snag", "plain", { singleLine: true, max: 24 });
  const author = sanitise(row.event.authorName ?? "Someone", "plain", { singleLine: true, max: 60 });
  const body = sanitiseWithRedactor(row.event.body ?? "", "plain", redactText, { max: 2000 });
  const page = row.event.pageUrl ?? "";

  /**
   * `thread.resolved` — a different message, not the comment one with a
   * different noun. It carries NO body, because there is no new text: the
   * event is a state change, and padding it with the original comment would
   * re-send words the recipient already has.
   */
  if (row.event.resolved) {
    const actor = sanitise(row.event.actorName ?? "Someone", "plain", { singleLine: true, max: 60 });
    return {
      to,
      subject: `${key} was marked resolved`,
      text: [
        `${actor} marked ${key} resolved.`,
        "",
        page ? `On the page: ${page}` : "",
        `See the thread: ${link}`,
        "",
        "— Snagset",
      ]
        .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
        .join("\n"),
    };
  }

  return {
    to,
    subject: `${key}: new comment from ${author}`,
    text: [
      `${author} commented on ${key}:`,
      "",
      body,
      "",
      page ? `On the page: ${page}` : "",
      `Open the thread: ${link}`,
      "",
      "— Snagset",
    ]
      .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
      .join("\n"),
  };
}

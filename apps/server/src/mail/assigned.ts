import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sanitise, sanitiseWithRedactor } from "@snagset/adapters";
import { redactText } from "@snagset/widget/redact";
import { noteQueued } from "../jobs/soon.ts";
import { threadUrl } from "./links.ts";

/**
 * "This snag is yours now", and deliberately NOT sent at the click.
 *
 * Pastel mails the assignee the moment they are picked, and the maintainer's brief
 * was the opposite: assignment is something a studio does in bursts — triage
 * a round, hand out twelve snags, change its mind about three of them — and
 * twelve mails in a minute, three of them about work that has since moved to
 * somebody else, teach the recipient to filter the sender before the one that
 * matters arrives. So the mail WAITS, and when it goes it goes once.
 *
 * ── THREE RULES, ONE ROW EACH ──
 *
 *   1. **Late.** The row is queued in the PATCH's transaction (as
 *      every outbox row is) with `next_attempt_at = now() + ASSIGN_DELAY`.
 *      An hour, as a constant rather than a variable for the reason
 *      `PER_ADDRESS_HOURLY` gives in `notify.ts`: a number nobody has asked to
 *      change is not worth a line an operator has to read past.
 *   2. **Still true.** At send time the row is checked again and DROPPED —
 *      with a reason in `last_error`, the status the design has for "nothing to
 *      send" — when the snag is no longer theirs, is resolved or deleted, or
 *      they have clearly seen it: commented on it, or changed its status,
 *      after the assignment. The status half is decided at the PATCH that
 *      changes it (`dropAssignedBy`), because nothing records WHO moved a
 *      status and the moment of the move is the one place that knows.
 *   3. **Together.** The delivery job claims one row as it always has; when
 *      that row is an assignment, every other DUE assignment for the same
 *      address in the same studio is claimed with it and the lot goes as one
 *      mail — "3 snags assigned to you on Acme" — and all of them are
 *      marked `done` together. Across sites, too: a studio member has one
 *      reviewer row per site, and the address is what makes them one person.
 *
 * ── WHO IS NEVER QUEUED ──
 *
 * The person who assigned it to themselves (by reviewer row, by dashboard
 * user, or by address — `samePerson` below, the rule); anyone with no
 * address; anyone who unsubscribed, was blocked or erased; a studio member
 * whose user was deleted. All decided at enqueue AND again at send, because
 * an hour is long enough for any of them to change.
 *
 * ── THE DEDUPE KEY ──
 *
 * `thread.assigned:<threadId>:<threads.version>:<reviewerId>` — the
 * `<topic>:<entityId>:<version>` composition with the recipient appended, as
 * the fan-out does. The version is what lets a snag assigned, taken away and
 * given back NEXT WEEK be a new mail; it is not what stops the same person
 * being queued twice inside the hour. That is the push-back: a PENDING row
 * for this thread and this person is moved to an hour from now instead of a
 * second row being written. The thread's row lock, held by the PATCH's own
 * UPDATE, serialises two assigners racing on one thread, so the look-then-
 * insert cannot double.
 */

export const ASSIGNED_TOPIC = "thread.assigned";

/** How long an assignment waits before it is worth a mail. */
/** The default wait; `SNAGSET_ASSIGN_MAIL_DELAY_S` overrides it. */
export const ASSIGN_DELAY_MS = 60 * 60_000;

/** How many snags one mail LISTS — the digest's reason (event size, attention). */
export const ASSIGNED_LISTED = 50;

const NAME_MAX = 60;
const EXCERPT_MAX = 140;

/** A person as the PATCH knows them: a reviewer row, or a dashboard user. */
export interface Actor {
  readonly reviewerId?: string | undefined;
  readonly userId?: string | undefined;
  readonly email?: string | undefined;
}

/**
 * The SQL test "is reviewer `r` this actor?" — by row, by dashboard user, or
 * by address, case-insensitively. The rule, in the form the queries below
 * need. A session's row is expanded to its user and address first
 * (`expand`), so a member signed in through the widget is the same person as
 * their dashboard self.
 */
function matches(tx: postgres.TransactionSql | postgres.Sql, alias: string, a: Actor) {
  const r = tx(alias);
  return tx`(
    ${a.reviewerId ? tx`${r}.id = ${a.reviewerId}::uuid` : tx`false`}
    OR ${a.userId ? tx`${r}.user_id = ${a.userId}::uuid` : tx`false`}
    OR ${a.email ? tx`lower(${r}.email) = lower(${a.email})` : tx`false`}
  )`;
}

/** A session's reviewer row → the user and address behind it, when it has them. */
async function expand(tx: postgres.TransactionSql | postgres.Sql, a: Actor): Promise<Actor> {
  if (!a.reviewerId || (a.userId && a.email)) return a;
  const [r] = await tx<{ user_id: string | null; email: string | null }[]>`
    SELECT user_id, email FROM reviewers WHERE id = ${a.reviewerId}::uuid`;
  return {
    reviewerId: a.reviewerId,
    userId: a.userId ?? r?.user_id ?? undefined,
    email: a.email ?? r?.email ?? undefined,
  };
}

export interface AssignedNotice {
  readonly orgId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly threadKey: string;
  /** `threads.version` AFTER the update. */
  readonly version: number;
  /** The reviewer row the thread was handed to. */
  readonly assigneeId: string;
  /** Who handed it over — never mailed about their own act. */
  readonly actor: Actor;
  readonly actorName: string;
  /** SNAGSET_ASSIGN_MAIL_DELAY_S, in ms; ASSIGN_DELAY_MS when absent. */
  readonly delayMs?: number;
}

/**
 * Queue (or push back) one assignment mail, INSIDE the PATCH's transaction.
 * Returns whether a row now waits, for the tests and nothing else.
 */
export async function queueAssignedNotice(
  tx: postgres.TransactionSql | postgres.Sql,
  n: AssignedNotice,
): Promise<boolean> {
  const actor = await expand(tx, n.actor);
  /**
   * The assignee, deliverable or not. The studio member's address is the
   * USER's, read now: the reviewer row copied it when it was materialised and
   * a user who has since changed theirs should be mailed where they read.
   */
  const [to] = await tx<{ id: string; is_actor: boolean }[]>`
    SELECT r.id, ${matches(tx, "r", actor)} AS is_actor
      FROM reviewers r
      LEFT JOIN users u ON u.id = r.user_id
     WHERE r.id = ${n.assigneeId}::uuid
       AND r.notifications_off_at IS NULL
       AND r.blocked_at IS NULL
       AND r.erased_at IS NULL
       AND (r.user_id IS NULL OR u.deleted_at IS NULL)
       AND COALESCE(u.email, r.email) IS NOT NULL`;
  // Nobody to write to, or the assigner picked themselves: no row at all —
  // the row never written is the one that cannot be sent.
  if (!to || to.is_actor) return false;

  const event = {
    threadKey: n.threadKey,
    actorName: n.actorName,
    toReviewer: n.assigneeId,
  };

  // Already waiting for this person on this thread: wait an hour from NOW
  // instead, and remember the newer assignment time — "has since commented"
  // is measured from the assignment the mail is about.
  const [pushed] = await tx<{ id: string }[]>`
    UPDATE outbox
       SET next_attempt_at = now() + ${`${n.delayMs ?? ASSIGN_DELAY_MS} milliseconds`}::interval,
           event = event || jsonb_build_object('assignedAt', now(), 'actorName', ${n.actorName}::text)
     WHERE provider = 'email'
       AND topic = ${ASSIGNED_TOPIC}
       AND thread_id = ${n.threadId}::uuid
       AND status = 'pending'
       AND event->>'toReviewer' = ${n.assigneeId}
    RETURNING id`;
  if (pushed) return true;

  await tx`
    INSERT INTO outbox (id, org_id, project_id, thread_id, provider, topic, dedupe_key, event, next_attempt_at)
    VALUES (
      ${randomUUID()}, ${n.orgId}, ${n.projectId}, ${n.threadId},
      'email', ${ASSIGNED_TOPIC},
      ${`${ASSIGNED_TOPIC}:${n.threadId}:${n.version}:${n.assigneeId}`},
      ${tx.json(event)}::jsonb || jsonb_build_object('assignedAt', now()),
      now() + ${`${n.delayMs ?? ASSIGN_DELAY_MS} milliseconds`}::interval
    )
    ON CONFLICT (provider, dedupe_key) DO NOTHING`;
  // A drain after the response finds nothing due for an hour — and
  // then whatever else this write queued goes, which is the point of it.
  noteQueued();
  return true;
}

/**
 * The assignee moved the status themselves: they have seen it, and the mail
 * that would tell them is dropped now. Called by the PATCH that changes a
 * status, with whoever is pressing the button.
 */
export async function dropAssignedBy(
  tx: postgres.TransactionSql | postgres.Sql,
  threadId: string,
  actor: Actor,
): Promise<void> {
  const who = await expand(tx, actor);
  await tx`
    UPDATE outbox o
       SET status = 'dropped', last_error = 'the assignee changed its status', completed_at = now()
      FROM reviewers r
     WHERE o.provider = 'email'
       AND o.topic = ${ASSIGNED_TOPIC}
       AND o.thread_id = ${threadId}::uuid
       AND o.status = 'pending'
       AND r.id = CASE WHEN o.event->>'toReviewer' ~ '^[0-9a-fA-F-]{36}$'
                       THEN (o.event->>'toReviewer')::uuid END
       AND ${matches(tx, "r", who)}`;
}

/** An outbox row as the delivery job hands it over. */
export interface ClaimedRow {
  readonly id: string;
  readonly org_id: string;
  readonly attempts: number;
  readonly event: Record<string, unknown>;
}

/** A recipient as the delivery job resolved it. */
interface Recipient {
  readonly reviewerId: string;
  readonly userId: string | null;
  readonly email: string;
}

/** The reviewer an assignment row is for, if they can still be mailed. */
export async function assignedRecipient(
  sql: postgres.Sql | postgres.TransactionSql,
  row: ClaimedRow,
): Promise<Recipient | null> {
  const id = String(row.event["toReviewer"] ?? "");
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  const [r] = await sql<{ id: string; user_id: string | null; email: string | null }[]>`
    SELECT r.id, r.user_id, COALESCE(u.email, r.email) AS email
      FROM reviewers r
      LEFT JOIN users u ON u.id = r.user_id
     WHERE r.id = ${id}::uuid
       AND r.notifications_off_at IS NULL
       AND r.blocked_at IS NULL
       AND r.erased_at IS NULL
       AND (r.user_id IS NULL OR u.deleted_at IS NULL)`;
  return r?.email ? { reviewerId: r.id, userId: r.user_id, email: r.email } : null;
}

/**
 * Every OTHER due assignment for the same address in the same studio,
 * claimed (`inflight`, attempts + 1) exactly as the delivery job claims its
 * one row — `SKIP LOCKED`, so a second instance draining at once takes what
 * this one did not. Each candidate's own recipient is re-derived here, so a
 * row whose reviewer unsubscribed since is simply not part of the batch and
 * is dropped by its own claim later.
 */
export async function claimSiblings(
  sql: postgres.Sql | postgres.TransactionSql,
  first: ClaimedRow,
  email: string,
  now: Date,
): Promise<ClaimedRow[]> {
  return sql<ClaimedRow[]>`
    UPDATE outbox SET status = 'inflight', attempts = attempts + 1
     WHERE id IN (
       SELECT o.id
         FROM outbox o
         JOIN reviewers r ON r.id = CASE WHEN o.event->>'toReviewer' ~ '^[0-9a-fA-F-]{36}$'
                                         THEN (o.event->>'toReviewer')::uuid END
         LEFT JOIN users u ON u.id = r.user_id
        WHERE o.provider = 'email'
          AND o.topic = ${ASSIGNED_TOPIC}
          AND o.status = 'pending'
          AND o.org_id = ${first.org_id}
          AND o.id <> ${first.id}
          AND o.next_attempt_at <= ${now}
          AND r.notifications_off_at IS NULL
          AND r.blocked_at IS NULL
          AND r.erased_at IS NULL
          AND lower(COALESCE(u.email, r.email)) = lower(${email})
        ORDER BY o.next_attempt_at
        LIMIT ${ASSIGNED_LISTED - 1}
        FOR UPDATE OF o SKIP LOCKED
     )
    RETURNING id, org_id, attempts, event`;
}

export interface AssignedItem {
  readonly rowId: string;
  readonly threadKey: string;
  readonly site: string;
  readonly siteUid: string;
  readonly round: number | null;
  readonly actorName: string;
  readonly excerpt: string;
}

/**
 * Split claimed rows into what is still news and what is not, with the reason
 * for each drop. Read at SEND time, which is the point of waiting an hour.
 */
export async function liveAssignments(
  sql: postgres.Sql | postgres.TransactionSql,
  rows: readonly ClaimedRow[],
): Promise<{ live: AssignedItem[]; dropped: { id: string; reason: string }[] }> {
  const live: AssignedItem[] = [];
  const dropped: { id: string; reason: string }[] = [];
  for (const row of rows) {
    const to = String(row.event["toReviewer"] ?? "");
    const at = String(row.event["assignedAt"] ?? "") || "-infinity";
    const [t] = await sql<
      {
        key: string;
        status: string;
        gone: boolean;
        assignee_id: string | null;
        site: string;
        uid: string;
        round: number | null;
        first: string | null;
        seen: boolean;
      }[]
    >`
      SELECT t.key, t.status::text AS status,
             (t.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL) AS gone,
             t.assignee_id, p.name AS site, p.uid, rd.number AS round,
             (SELECT c.body FROM comments c
               WHERE c.thread_id = t.id AND c.deleted_at IS NULL
               ORDER BY c.seq LIMIT 1) AS first,
             -- "They have clearly seen it": a comment by the same person —
             -- this row, their dashboard self, or their address — written
             -- after the assignment the mail is about.
             EXISTS (
               SELECT 1 FROM comments c
                 JOIN reviewers cr ON cr.id = c.author_id
                 JOIN reviewers me ON me.id = ${to}::uuid
                WHERE c.thread_id = t.id
                  AND c.deleted_at IS NULL
                  AND c.created_at > ${at}::timestamptz
                  AND (cr.id = me.id
                       OR (me.user_id IS NOT NULL AND cr.user_id = me.user_id)
                       OR (me.email IS NOT NULL AND lower(cr.email) = lower(me.email)))
             ) AS seen
        FROM outbox o
        JOIN threads t ON t.id = o.thread_id
        JOIN projects p ON p.id = t.project_id
        LEFT JOIN rounds rd ON rd.id = t.round_id
       WHERE o.id = ${row.id}::uuid`;
    const reason = !t
      ? "the thread was deleted"
      : t.gone
        ? "the thread was deleted"
        : t.assignee_id !== to
          ? "the thread is no longer assigned to them"
          : t.status === "resolved"
            ? "the thread was resolved"
            : t.seen
              ? "the assignee has replied since"
              : null;
    if (reason || !t) {
      dropped.push({ id: row.id, reason: reason ?? "the thread was deleted" });
      continue;
    }
    live.push({
      rowId: row.id,
      threadKey: t.key,
      site: t.site,
      siteUid: t.uid,
      round: t.round,
      actorName: String(row.event["actorName"] ?? "Someone"),
      // Redacted BEFORE clamping, as the digest does: half a token is one the
      // redactor no longer recognises.
      excerpt: sanitiseWithRedactor((t.first ?? "").split("\n")[0] ?? "", "plain", redactText, {
        singleLine: true,
        max: EXCERPT_MAX,
      }),
    });
  }
  return { live, dropped };
}

/**
 * The mail. Text only, as every mail here is. One snag reads as a sentence;
 * several read as a list, grouped by site, each with its key, the first line
 * of what was said, and the link that opens it.
 */
export function renderAssigned(
  items: readonly AssignedItem[],
  to: string,
  baseUrl: string,
): { to: string; subject: string; text: string } {
  const plain = (s: string, max: number) => sanitise(s, "plain", { singleLine: true, max });
  const sites = [...new Set(items.map((i) => i.siteUid))];
  const siteName = plain(items[0]!.site, NAME_MAX);
  const n = items.length;

  if (n === 1) {
    const it = items[0]!;
    const key = plain(it.threadKey, 24);
    return {
      to,
      subject: `${key} was assigned to you on ${siteName}`,
      text: [
        `${plain(it.actorName, NAME_MAX)} assigned ${key} to you on ${siteName}.`,
        "",
        ...(it.excerpt ? [`“${plain(it.excerpt, EXCERPT_MAX + 1)}”`, ""] : []),
        `Open it: ${threadUrl(baseUrl, it.siteUid, it.threadKey, it.round)}`,
        "",
        "— Snagset",
        "Sent an hour after the assignment, unless it moved on or you had already answered it.",
      ].join("\n"),
    };
  }

  const subject =
    sites.length === 1 ? `${n} snags assigned to you on ${siteName}` : `${n} snags assigned to you across ${sites.length} sites`;
  const lines: string[] = [`${n} snags were assigned to you.`, ""];
  for (const uid of sites) {
    const mine = items.filter((i) => i.siteUid === uid);
    lines.push(`${plain(mine[0]!.site, NAME_MAX)} (${mine.length})`);
    for (const it of mine) {
      lines.push(
        `  ${plain(it.threadKey, 24)} · from ${plain(it.actorName, NAME_MAX)}${it.excerpt ? `: ${plain(it.excerpt, EXCERPT_MAX + 1)}` : ""}`,
        `    ${threadUrl(baseUrl, it.siteUid, it.threadKey, it.round)}`,
      );
    }
    lines.push("");
  }
  lines.push(
    "— Snagset",
    "Assignments are gathered for an hour and sent together, leaving out any that moved on or that you had already answered.",
  );
  return { to, subject, text: lines.join("\n") };
}

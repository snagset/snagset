import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sanitise, sanitiseWithRedactor } from "@snagset/adapters";
import { redactText } from "@snagset/widget/redact";
import type { Job, JobContext, JobOutcome } from "../jobs/index.ts";
import { isConfigured, type MailerStatus } from "./mailer.ts";
import { dashboardUrl, threadUrl } from "./links.ts";

/**
 * The daily digest, on the maintainer's "we don't need to send the email every
 * time there is a comment, maybe once in a while".
 *
 * `SNAGSET_MAIL_NOTIFY=digest` (the default) changes ONE thing: how the
 * project OWNER hears about `comment.created`. Reviewer mail — a reply on a
 * thread they took part in, a snag marked resolved — stays per event, because
 * a reviewer hears about one conversation they are waiting on, not about a
 * whole studio's day.
 *
 * ── NO NEW SCHEDULER, NO NEW TABLE ──
 *
 * The owner's row is queued exactly as before, in the comment's transaction,
 * with the same dedupe key (`notify.ts`). In digest mode the delivery job
 * simply does not claim it. This job FOLDS those rows: once a day it takes
 * every pending owner row queued before midnight UTC, writes ONE outbox row
 * of topic `comment.digest` that lists them, and marks them `done` — in one
 * transaction, the job engine's. The digest row is then an ordinary outbox
 * row, delivered by the ordinary delivery job, with its claim-before-send,
 * its backoff and its per-address rate limit. Nothing about sending is
 * written twice.
 *
 * ── HOW "AT MOST ONE A DAY" IS ACTUALLY ACHIEVED ──
 *
 *   1. **The day is in the dedupe key.** `comment.digest:<orgId>:<YYYY-MM-DD>`
 *      under the outbox's `UNIQUE (provider, dedupe_key)`. A second build on
 *      the same UTC day — the bin's next hourly tick, an operator forcing the
 *      cron route, two instances at once — cannot create a second row, and an
 *      org that already has today's row is not even considered.
 *   2. **The window is fixed, not "since the last run".** Only rows queued
 *      BEFORE today's midnight (UTC) are folded. A comment at 09:15 is not
 *      picked up by a 10:00 tick that finds today's digest unbuilt — it waits
 *      for tomorrow's, with everything else from today. Without this, a quiet
 *      night would make the first comment of the morning its own digest and
 *      push the rest of the day to the next one: the time the mail arrives
 *      would follow the traffic rather than the clock.
 *   3. **Fold and record are one transaction.** The digest row's INSERT and
 *      the `done` on the rows it lists commit together or not at all, so a
 *      crash cannot fold rows into a digest that does not exist, nor build a
 *      digest whose rows stay pending to be folded again tomorrow.
 *
 * Last-sent is therefore not a separate value anywhere: it IS the newest
 * `comment.digest` row, and its status says whether it went — the outbox
 * already holds what "when did we last send, and did it work" needs. The one
 * schema change is 0008: a digest is the STUDIO's mail, not a site's, so its
 * row carries no `project_id`, and deleting a site cannot cascade away a
 * digest that also lists the others.
 *
 * Whatever runs the sweep runs this: the platform's daily cron (03:00 UTC in
 * the scaffold, so the digest arrives then), the bin's hourly ticker (so the
 * first tick after midnight), or `/api/jobs/run` by hand. NOT the drain a
 * write starts: a comment is never the reason to send a digest, and the
 * drain running this would only find the day's window already closed.
 */

export const DIGEST_TOPIC = "comment.digest";
/** The topic the folded rows carry — `notify.ts`'s, restated to avoid a cycle. */
const COMMENT_TOPIC = "comment.created";

/**
 * How many comments the mail LISTS. Every pending row is folded and counted;
 * past this the mail says how many more there are and links to the
 * dashboard. The outbox's `CHECK (octet_length(event::text) <= 65536)` is the
 * hard reason — a digest row over it would fail to insert and take the fold
 * with it — and a mail of fifty excerpts is also past where anybody reads.
 * At the clamps below an item is under 1 KB, so fifty fit with room.
 */
export const DIGEST_LISTED = 50;
const EXCERPT_MAX = 140;
const PAGE_MAX = 300;
const NAME_MAX = 60;

export interface DigestItem {
  readonly threadKey: string;
  readonly round: number | null;
  readonly author: string;
  /** Redacted and sanitised at fold time — see `fold()`. */
  readonly excerpt: string;
  readonly page: string;
}

export interface DigestSite {
  readonly name: string;
  readonly uid: string;
  /** Every new comment on this site, listed or not. */
  readonly count: number;
  readonly items: readonly DigestItem[];
}

export interface DigestEvent {
  readonly digest: true;
  /** The midnight (UTC) the window closed at. */
  readonly through: string;
  readonly total: number;
  readonly sites: readonly DigestSite[];
}

/** Midnight UTC at the start of `now`'s day — the close of the digest window. */
export function digestCutoff(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function digestKey(orgId: string, cutoff: Date): string {
  return `${DIGEST_TOPIC}:${orgId}:${cutoff.toISOString().slice(0, 10)}`;
}

interface PendingRow {
  id: string;
  project_id: string;
  site_name: string;
  site_uid: string;
  thread_key: string | null;
  round: number | null;
  /** The comment, thread or site was deleted after the row was queued. */
  gone: boolean;
  event: { threadKey?: string; authorName?: string; body?: string; pageUrl?: string };
}

/**
 * The job. Registered only in `digest` mode and only in the sweep
 * (`jobs/set.ts`).
 *
 * `everyMs` is fifteen minutes and not a day, on purpose: the DAY is enforced
 * by the dedupe key, not by the engine's schedule. A daily `everyMs` would
 * make a cron that fires at 03:00:02 today and 03:00:01 tomorrow "not due",
 * and skip a whole day for a second's jitter.
 */
export function buildDigests(mailer: MailerStatus): Job {
  return {
    name: "digest-email",
    everyMs: 15 * 60_000,
    async run({ sql, now }: JobContext): Promise<JobOutcome> {
      // No transport, no digest: the rows stay pending and are folded the
      // first day there is a mailer, rather than into a digest nothing sends.
      if (!isConfigured(mailer)) return { did: 0 };

      const cutoff = digestCutoff(now);
      const day = cutoff.toISOString().slice(0, 10);

      // ONE ORG PER PASS, the delivery job's bargain: `more: true` and the
      // engine drains. The NOT EXISTS is what makes an org that already has
      // today's digest drop out, so a row that arrives late for a closed
      // window cannot keep this job spinning on a conflict.
      const [next] = await sql<{ org_id: string }[]>`
        SELECT o.org_id
          FROM outbox o
         WHERE o.provider = 'email'
           AND o.topic = ${COMMENT_TOPIC}
           AND o.status = 'pending'
           AND o.event->>'toReviewer' IS NULL
           AND o.created_at < ${cutoff}
           AND NOT EXISTS (
             SELECT 1 FROM outbox d
              WHERE d.provider = 'email'
                AND d.dedupe_key = ${`${DIGEST_TOPIC}:`}::text || o.org_id::text || ${`:${day}`}::text
           )
         ORDER BY o.created_at
         LIMIT 1`;
      if (!next) return { did: 0 };
      const orgId = next.org_id;

      /**
       * The rows, LOCKED. `FOR UPDATE OF o` so that a delivery job switched
       * to `each` mid-fold (an operator changing the variable and restarting
       * one instance of several) cannot claim a row this digest is about to
       * list; `SKIP LOCKED` so that the opposite case skips rather than waits.
       */
      const rows = await sql<PendingRow[]>`
        SELECT o.id, o.project_id, o.event,
               p.name AS site_name, p.uid AS site_uid,
               t.key AS thread_key, r.number AS round,
               (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL OR c.deleted_at IS NOT NULL) AS gone
          FROM outbox o
          JOIN projects p ON p.id = o.project_id
          LEFT JOIN threads t ON t.id = o.thread_id
          LEFT JOIN rounds r ON r.id = t.round_id
          LEFT JOIN comments c ON c.id = (
            CASE WHEN o.event->>'commentId' ~ '^[0-9a-fA-F-]{36}$'
                 THEN (o.event->>'commentId')::uuid END
          )
         WHERE o.org_id = ${orgId}
           AND o.provider = 'email'
           AND o.topic = ${COMMENT_TOPIC}
           AND o.status = 'pending'
           AND o.event->>'toReviewer' IS NULL
           AND o.created_at < ${cutoff}
         ORDER BY o.created_at
         FOR UPDATE OF o SKIP LOCKED`;
      // Every row locked by somebody else: they are working on it. Stop
      // rather than ask again, or this pass would repeat until maxPasses.
      if (rows.length === 0) return { did: 0 };

      // A comment deleted before its digest is not news. Dropped, with the
      // status the design has for "nothing to send", rather than listed.
      const gone = rows.filter((r) => r.gone).map((r) => r.id);
      const live = rows.filter((r) => !r.gone);
      if (gone.length) {
        await sql`
          UPDATE outbox SET status = 'dropped', last_error = 'deleted before the digest', completed_at = ${now}
           WHERE id = ANY(${gone}::uuid[])`;
      }
      if (live.length === 0) return { did: 0, more: true };

      const event = fold(live, cutoff);
      const [made] = await sql<{ id: string }[]>`
        INSERT INTO outbox (id, org_id, project_id, thread_id, provider, topic, dedupe_key, event, next_attempt_at)
        VALUES (
          ${randomUUID()}, ${orgId},
          -- No site: a digest is the STUDIO's mail, and 0008 lets this one
          -- topic leave project_id empty. Pinning it to one of the sites it
          -- lists would let deleting that site cascade the digest away, and
          -- with it every other site's comments.
          NULL,
          NULL, 'email', ${DIGEST_TOPIC}, ${digestKey(orgId, cutoff)}, ${sql.json(event as never)},
          -- The job's clock, not the database's: the delivery job claims with
          -- next_attempt_at <= now in the same sweep, on the same clock.
          ${now}
        )
        ON CONFLICT (provider, dedupe_key) DO NOTHING
        RETURNING id`;
      // Today's digest exists after all (NOT EXISTS above is a read; this is
      // the constraint). Leave the rows pending for tomorrow's: folding them
      // into nothing would be mail that silently never happens.
      if (!made) return { did: 0 };

      /**
       * `done`, because their news now lives in the digest row, which carries
       * its own status. A digest that fails for good is `failed` and stays on
       * the list of mail that never sent; marking these rows anything that
       * the delivery job would pick up again is how one comment reaches the
       * owner twice.
       */
      await sql`
        UPDATE outbox SET status = 'done', completed_at = ${now}, last_error = NULL
         WHERE id = ANY(${live.map((r) => r.id)}::uuid[])`;
      return { did: 1, more: true, note: `digest of ${live.length} comment(s) queued for one owner` };
    },
  };
}

/**
 * Pending rows → the digest's event, grouped by site, oldest first.
 *
 * The excerpt is REDACTED HERE, before it is clamped — the order matters.
 * Clamping first can cut an address or a token in half, and half a token is
 * one the redactor no longer recognises, so the mail would carry the half.
 */
function fold(rows: readonly PendingRow[], cutoff: Date): DigestEvent {
  const bySite = new Map<string, { name: string; uid: string; count: number; items: DigestItem[] }>();
  let listed = 0;
  for (const r of rows) {
    let site = bySite.get(r.project_id);
    if (!site) {
      site = { name: clip(r.site_name, NAME_MAX), uid: r.site_uid, count: 0, items: [] };
      bySite.set(r.project_id, site);
    }
    site.count++;
    if (listed >= DIGEST_LISTED) continue;
    listed++;
    site.items.push({
      threadKey: clip(r.thread_key ?? r.event.threadKey ?? "a snag", 24),
      round: r.round,
      author: clip(r.event.authorName ?? "Someone", NAME_MAX),
      excerpt: sanitiseWithRedactor(r.event.body ?? "", "plain", redactText, { singleLine: true, max: EXCERPT_MAX }),
      page: clip(r.event.pageUrl ?? "", PAGE_MAX),
    });
  }
  return { digest: true, through: cutoff.toISOString(), total: rows.length, sites: [...bySite.values()] };
}

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

/**
 * The digest as it should be sent NOW: without the sites deleted since it was
 * folded. Null when none is left, which the delivery job drops.
 *
 * Read at send time because the gap is real — a digest folded at 00:05 can be
 * waiting on a rate limit or a retry when the owner deletes a site — and a
 * mail that lists a deleted site's comments links to a page that no longer
 * opens. A site delete is SOFT (`routes/sites.ts`), so it is `deleted_at` that
 * removes it here; a site removed outright is simply not found. Its folded
 * comment rows stay `done`: they were news about a site the owner has since
 * decided they do not want, and re-queueing them would be mail about nothing.
 */
export async function pruneDigest(
  sql: postgres.Sql | postgres.TransactionSql,
  orgId: string,
  event: DigestEvent,
): Promise<DigestEvent | null> {
  const uids = (event.sites ?? []).map((s) => s.uid);
  if (uids.length === 0) return null;
  const alive = new Set(
    (
      await sql<{ uid: string }[]>`
        SELECT uid FROM projects
         WHERE org_id = ${orgId} AND uid = ANY(${uids}::text[]) AND deleted_at IS NULL`
    ).map((r) => r.uid),
  );
  const sites = event.sites.filter((s) => alive.has(s.uid));
  if (sites.length === 0) return null;
  if (sites.length === event.sites.length) return event;
  return { ...event, sites, total: sites.reduce((n, s) => n + s.count, 0) };
}

/**
 * The digest mail. Text only, like every other mail here, and for the same
 * reason: who, where, what and a link need no `<div>`.
 *
 * Every stored string is sanitised again on the way out, as the per-comment
 * mail does. The excerpt was already redacted at fold time; sanitising it a
 * second time is cheap and means this function never has to trust its input.
 */
export function renderDigest(event: DigestEvent, to: string, baseUrl: string): {
  to: string;
  subject: string;
  text: string;
} {
  const plain = (s: string, max: number) => sanitise(s, "plain", { singleLine: true, max });
  const sites = event.sites;
  const n = event.total;
  const comments = n === 1 ? "1 new comment" : `${n} new comments`;
  const subject =
    sites.length === 1
      ? `${comments} on ${plain(sites[0]!.name, NAME_MAX)}`
      : `${comments} across ${sites.length} sites`;

  const lines: string[] = [`${comments} since the last digest.`, ""];
  let listed = 0;
  for (const site of sites) {
    lines.push(`${plain(site.name, NAME_MAX)} (${site.count})`);
    for (const item of site.items) {
      listed++;
      const key = plain(item.threadKey, 24);
      lines.push(
        `  ${key} · ${plain(item.author, NAME_MAX)}: ${plain(item.excerpt, EXCERPT_MAX + 1)}`,
        ...(item.page ? [`    On the page: ${plain(item.page, PAGE_MAX)}`] : []),
        `    ${threadUrl(baseUrl, site.uid, item.threadKey, item.round)}`,
      );
    }
    lines.push("");
  }
  if (n > listed) lines.push(`…and ${n - listed} more not listed here.`, "");
  lines.push(
    `Open the dashboard: ${dashboardUrl(baseUrl)}`,
    "",
    "— Snagset",
    "You get this at most once a day. For one email per comment instead, set SNAGSET_MAIL_NOTIFY=each.",
  );
  return { to, subject, text: lines.join("\n") };
}

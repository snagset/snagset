import type postgres from "postgres";
import { maintenance } from "../db/scope.ts";

/**
 * How much mail a studio, and the person who owns it, may cause in a day
 * (`SNAGSET_MAIL_STUDIO_DAILY`, `SNAGSET_MAIL_OWNER_DAILY`).
 *
 * WHY: a hosted server sends every studio's mail on one provider account,
 * and a provider's day is shared. Without a count, one account that invites
 * in a loop or assigns snags to a list of typed addresses spends the day for
 * everybody, and the mail that matters most (somebody's sign-in) is what is
 * lost after it. The address limit in notify.ts (twelve an hour to one
 * address) stops one inbox being flooded; it does not stop one sender
 * mailing many inboxes. This does.
 *
 * TWO COUNTS, because one is easy to step round: anybody signed in can make
 * another studio, and a count per studio alone hands each one a fresh day.
 * So a studio's mail is also counted against its first owner, and that count
 * is kept under the owner's HOME studio (`users.org_id`), which is the
 * one row every studio they own can find.
 *
 * WHAT IT DOES NOT STOP: it is a limit per ACCOUNT. Somebody with several
 * accounts has several owner days, and moving a person's home studio (a
 * removal moves `users.org_id`) starts their count again. What bounds that is
 * the provider's own day and the hosted service's sign-up door, not this.
 *
 * DURABLE, unlike the server's other counts (which are in memory): a day is
 * longer than a deploy, and a count that a restart forgets is a day that
 * restarts. It uses `rate_counters`, the table that exists for this, under
 * the maintenance claim because the owner's row belongs to another studio.
 *
 * COUNTED BEFORE THE SEND, as notify.ts's limit is: a send that times out
 * still spends its place, because the alternative is a failing send retried
 * with no limit. The two counts are bumped together and only when both have
 * room, so a studio refused by its owner's count does not also spend its own.
 * (The per-address hourly count in notify.ts runs first and is spent either
 * way; it counts one inbox's mail, and that studio cannot send.)
 *
 * In the delivery job this runs inside the job's own transaction, so the two
 * counter rows stay locked until the send returns: another send for the same
 * owner waits for it. Rare, bounded by the provider's timeout, and accepted.
 */

export interface MailCaps {
  /** Per studio per day; 0 is no limit. */
  readonly studio: number;
  /** Per owner, across every studio they own, per day; 0 is no limit. */
  readonly owner: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
const STUDIO_KEY = "mail-day:studio";
const ownerKey = (userId: string) => `mail-day:owner:${userId}`;

export const noCaps: MailCaps = { studio: 0, owner: 0 };

export function capsFrom(cfg: { int(name: string): number }): MailCaps {
  const n = (name: string) => {
    const v = cfg.int(name);
    return Number.isInteger(v) && v > 0 ? v : 0;
  };
  return { studio: n("SNAGSET_MAIL_STUDIO_DAILY"), owner: n("SNAGSET_MAIL_OWNER_DAILY") };
}

/**
 * Spend `count` sends for `orgId` now. Returns null when they may go, and
 * then they are counted; otherwise the moment the fuller of the two days
 * turns, and nothing is counted.
 */
export async function spendMail(
  sql: postgres.Sql | postgres.TransactionSql,
  orgId: string,
  caps: MailCaps,
  now: Date,
  count = 1,
): Promise<Date | null> {
  if (!caps.studio && !caps.owner) return null;
  return maintenance(sql, async (tx) => {
    // The studio's first owner, and where their count lives.
    const [owner] = await tx<{ user_id: string; home: string }[]>`
      SELECT u.id AS user_id, u.org_id AS home
        FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ${orgId} AND m.role = 'owner' AND u.deleted_at IS NULL
       ORDER BY m.created_at, u.id
       LIMIT 1`;
    const buckets: { org: string; key: string; cap: number }[] = [];
    if (caps.studio) buckets.push({ org: orgId, key: STUDIO_KEY, cap: caps.studio });
    if (caps.owner && owner) buckets.push({ org: owner.home, key: ownerKey(owner.user_id), cap: caps.owner });
    if (!buckets.length) return null;

    // Two sends for one owner at the same moment must not each see room
    // for one: the rows are locked in a fixed order before they are read.
    buckets.sort((a, b) => (a.org + a.key < b.org + b.key ? -1 : 1));
    const fresh = new Date(now.getTime() - DAY_MS);
    let turns: Date | null = null;
    for (const b of buckets) {
      await tx`
        INSERT INTO rate_counters (org_id, bucket_key, window_start, count, expires_at)
        VALUES (${b.org}, ${b.key}, ${now}, 0, ${new Date(now.getTime() + DAY_MS)})
        ON CONFLICT (org_id, bucket_key) DO NOTHING`;
      const [row] = await tx<{ count: string; window_start: Date }[]>`
        SELECT count::text, window_start FROM rate_counters
         WHERE org_id = ${b.org} AND bucket_key = ${b.key} FOR UPDATE`;
      if (!row) continue;
      const start = new Date(row.window_start);
      const used = start <= fresh ? 0 : Number(row.count);
      if (used + count > b.cap) {
        const at = new Date((start <= fresh ? now : start).getTime() + DAY_MS);
        if (!turns || at > turns) turns = at;
      }
    }
    if (turns) return turns;
    for (const b of buckets) {
      await tx`
        UPDATE rate_counters
           SET count = CASE WHEN window_start <= ${fresh} THEN ${count} ELSE count + ${count} END,
               window_start = CASE WHEN window_start <= ${fresh} THEN ${now} ELSE window_start END,
               expires_at = CASE WHEN window_start <= ${fresh} THEN ${new Date(now.getTime() + DAY_MS)} ELSE expires_at END
         WHERE org_id = ${b.org} AND bucket_key = ${b.key}`;
    }
    return null;
  });
}

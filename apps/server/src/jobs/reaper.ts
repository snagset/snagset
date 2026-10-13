import type { Bucket } from "../storage/bucket.ts";
import type { Job, JobContext, JobOutcome } from "./index.ts";

/**
 * The reaper, cut to the three jobs L1 needs.
 *
 * The design lists eighteen steps. The other fifteen land with L2, and the split is
 * not arbitrary — these three are the ones whose ABSENCE is already costing
 * something today:
 *
 *   · `write-mode-downgrade` makes the read-time downgrade in
 *     `routes/sessions.ts` real. Until now `effectiveWriteMode()` computed the
 *     right answer on every request and no row ever changed, so the dashboard
 *     showed `open` on a project that had behaved as `link-required` for days.
 *     One of those two is lying to the operator.
 *   · `expire-rows` (steps 1, 2, 4) deletes rows that are already expired by
 *     their own column. Nothing reads them — every consumer checks
 *     `expires_at` — so this is purely a table that grows without bound. A
 *     nonce table nobody sweeps is the one that eventually makes an INSERT
 *     slow at three in the morning.
 *   · `reap-pending-attachments` (step 5) is the one that costs actual money:
 *     an upload that was presigned and never bound leaves a blob in the bucket
 *     that no row will ever reference and no user will ever see.
 *
 * Every statement here is idempotent and bounded by a `WHERE` clause on time.
 * That is what makes DoD 3's "two ticks do not double-run" a belt-and-braces
 * guarantee rather than the only thing standing between us and corruption:
 * running any of these twice does exactly what running it once does.
 */

/** How many rows one pass will touch. Small enough that the transaction is
 *  short and the advisory lock is not held across a long DELETE; large enough
 *  that a normal backlog clears in one pass. `more: true` is what makes the
 *  size a batching decision rather than a cap on how much ever gets done. */
const BATCH = 500;

/**
 * The first-run auto-downgrade.
 *
 * The design gives a new project 24 hours of `open` writes so that `npx snagset`
 * reaches a first pin with no dashboard round trip. This is the other half:
 * the clock actually running out.
 *
 * `write_mode_downgrade_at = NULL` in the same statement, because the column
 * means "a downgrade is pending" and leaving a past timestamp on a project
 * that is already `link-required` makes the dashboard's countdown render a
 * negative number.
 */
export const writeModeDowngrade: Job = {
  name: "write-mode-downgrade",
  everyMs: 60_000,
  async run({ sql, now }: JobContext): Promise<JobOutcome> {
    const rows = await sql<{ id: string }[]>`
      UPDATE projects
         SET write_mode = 'link-required',
             write_mode_downgrade_at = NULL
       WHERE write_mode = 'open'
         AND write_mode_downgrade_at IS NOT NULL
         AND write_mode_downgrade_at <= ${now}
         AND deleted_at IS NULL
      RETURNING id
    `;
    return rows.length
      ? { did: rows.length, note: `${rows.length} project(s) downgraded to link-required` }
      : { did: 0 };
  },
};

/**
 * Rows whose own column says they are expired.
 *
 * One job rather than three because they share a shape, a cadence and a
 * failure mode, and three jobs would mean three advisory locks and three
 * `_jobs` rows to describe one sentence: "delete what has expired".
 *
 * The `stream_tickets` case (step 3) is deliberately absent — deleted
 * SSE outright, so there is no such table to sweep and a statement against one
 * would be dead code that reads as coverage.
 */
export const expireRows: Job = {
  name: "expire-rows",
  everyMs: 15 * 60_000,
  async run({ sql, now }: JobContext): Promise<JobOutcome> {
    // Three separate statements, counted together. A single statement with
    // UNION would need three different row shapes to line up and would tell
    // the operator nothing about WHICH table was growing.
    const idem = await sql`
      DELETE FROM idempotency_keys
       WHERE ctid IN (SELECT ctid FROM idempotency_keys WHERE expires_at < ${now} LIMIT ${BATCH})
    `;
    const nonces = await sql`
      DELETE FROM identity_nonces
       WHERE ctid IN (SELECT ctid FROM identity_nonces WHERE expires_at < ${now} LIMIT ${BATCH})
    `;
    const counters = await sql`
      DELETE FROM rate_counters
       WHERE ctid IN (SELECT ctid FROM rate_counters WHERE expires_at < ${now} LIMIT ${BATCH})
    `;

    const did = idem.count + nonces.count + counters.count;
    // Any one of them filling its batch means there is more of that one left.
    const more =
      idem.count === BATCH || nonces.count === BATCH || counters.count === BATCH;
    return did
      ? {
          did,
          more,
          note: `expired ${idem.count} idempotency · ${nonces.count} nonces · ${counters.count} counters`,
        }
      : { did: 0, more };
  },
};

/**
 * Presigned uploads that were never bound to a comment.
 *
 * The two windows are the, and the difference between them is not a
 * rounding preference. An IMAGE is captured, resized and uploaded by our own
 * code inside one composer submission, so two hours is enormous slack for a
 * slow phone on hotel wifi. A FILE is a browser PUT straight to the bucket
 * against a 5-minute presign, so anything older than 15 minutes cannot still
 * be in flight — the URL it would use has already expired.
 *
 * `DeleteObject` is attempted unconditionally and its failure is swallowed,
 * because both outcomes are fine and neither is worth a retry: the browser may
 * never have PUT anything (delete on a missing key is a no-op in S3), or the
 * bucket may be misconfigured (in which case the row still has to leave
 * `pending`, or it is re-tried on every tick forever). What must NOT happen is
 * the row being marked orphaned while the bytes stay — so the delete is
 * attempted first and the row is updated after.
 *
 * With no bucket configured the job does nothing and says so. That is the
 * annotation-mode deployment, where no blob was ever written and
 * there is nothing to reap.
 */
export function reapPendingAttachments(bucket: Bucket | null): Job {
  return {
    name: "reap-pending-attachments",
    everyMs: 5 * 60_000,
    async run({ sql, now, log }: JobContext): Promise<JobOutcome> {
      const imageCutoff = new Date(now.getTime() - 2 * 60 * 60_000);
      const fileCutoff = new Date(now.getTime() - 15 * 60_000);

      const rows = await sql<
        { id: string; project_id: string; storage_key: string; bytes: string; kind: string }[]
      >`
        SELECT id, project_id, storage_key, bytes, kind
          FROM attachments
         WHERE state = 'pending'
           AND ((kind = 'file' AND created_at < ${fileCutoff})
             OR (kind <> 'file' AND created_at < ${imageCutoff}))
         ORDER BY created_at
         LIMIT ${BATCH}
      `;
      if (!rows.length) return { did: 0 };
      if (!bucket) {
        return { did: 0, note: `${rows.length} pending attachment(s) and no bucket to reap from` };
      }

      let reaped = 0;
      for (const row of rows) {
        try {
          await bucket.del(row.storage_key);
        } catch (e) {
          // Named, not silent: a bucket that refuses every delete is a bill
          // that grows, and the only place it shows up is here.
          log(`jobs: reap-pending-attachments: delete ${row.storage_key} failed: ${String(e)}`);
        }
        await sql`UPDATE attachments SET state = 'orphaned' WHERE id = ${row.id}`;
        // The counter. Decremented per row rather than in one statement at
        // the end so a mid-batch failure cannot leave the counter describing
        // rows that were already reaped.
        await sql`
          UPDATE projects
             SET storage_bytes_used = GREATEST(0, storage_bytes_used - ${Number(row.bytes)})
           WHERE id = ${row.project_id}
        `;
        reaped++;
      }

      return {
        did: reaped,
        more: rows.length === BATCH,
        note: `${reaped} orphaned upload(s) reaped`,
      };
    },
  };
}

/** The L1 set, in the order a tick runs them: cheapest and most
 *  user-visible first, so a budget that runs out costs the least. */
export function l1Jobs(bucket: Bucket | null): Job[] {
  return [writeModeDowngrade, expireRows, reapPendingAttachments(bucket)];
}

import type postgres from "postgres";

/**
 * A deleted thread's or comment's pictures stop being counted, in the same
 * transaction as the delete.
 *
 * Two things happen to a picture when what it hangs off is deleted, and they
 * are done in two places on purpose:
 *
 *   · HERE, at once: the row gets `deleted_at` (the blob route stops serving
 *     it) and its bytes come off `projects.storage_bytes_used`. Somebody who
 *     deletes to make room sees the room, and the next upload is admitted.
 *   · IN THE REAPER, within its tick (`collect-deleted-attachments`): the blob
 *     leaves the bucket and the row becomes `orphaned`. A bucket is a network
 *     call that can fail or hang, and a delete's transaction is no place for
 *     one.
 *
 * Only a `bound` row is taken off the counter. A `pending` one that never
 * reached a thread is the pending reaper's, which takes its own bytes off when
 * it reaps it; counting it here as well would give the same bytes back twice.
 *
 * One statement, so the mark and the count cannot disagree: a row marked by a
 * concurrent delete is not in `gone`, and is not subtracted a second time.
 *
 * `released_at` (0016) says the bytes were given back, and is what the reaper
 * reads: a deleted picture WITHOUT it was deleted by a version that never
 * subtracted (before 0.1.45, or an older server still running beside this
 * one), and the reaper subtracts for it when it collects it. So each picture
 * is given back once, by whichever of the two gets to it.
 */
export async function releaseAttachments(
  tx: postgres.TransactionSql,
  of: { threads: readonly string[] } | { comment: string },
): Promise<void> {
  await tx`
    WITH gone AS (
      UPDATE attachments
         SET deleted_at = now(),
             released_at = CASE WHEN state = 'bound' THEN now() END
       WHERE deleted_at IS NULL
         AND ${
           "threads" in of
             ? tx`(thread_id = ANY(${of.threads as string[]}::uuid[])
                   OR comment_id IN (SELECT id FROM comments WHERE thread_id = ANY(${of.threads as string[]}::uuid[])))`
             : tx`comment_id = ${of.comment}::uuid`
         }
      RETURNING project_id, bytes, state
    ),
    freed AS (
      SELECT project_id, sum(bytes) AS bytes FROM gone WHERE state = 'bound' GROUP BY project_id
    )
    UPDATE projects p
       SET storage_bytes_used = GREATEST(0, p.storage_bytes_used - f.bytes)
      FROM freed f
     WHERE p.id = f.project_id
  `;
}

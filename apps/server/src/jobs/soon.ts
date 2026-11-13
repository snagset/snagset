import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";
import { runDueJobs, summarise, type Job } from "./index.ts";

/**
 * A write that queued work drains it right after its response.
 *
 * Until every notification and tracker update waited for the schedule:
 * the bin's minute tick, or a platform cron every minute. A cron that queries
 * the database every minute keeps a serverless Postgres awake around the
 * clock. Neon's free compute never sat idle for the five minutes it needs
 * before it sleeps, spent its monthly hours in seventeen days, and took
 * `cloud.snagset.com` down with it. Vercel's Hobby plan refuses such a
 * cron at deploy. So the half of the schedule that people wait on moves to the
 * moment the work appears, and what stays on the schedule is a sweep: the
 * reaper, and retries.
 *
 * ── HOW A REQUEST KNOWS IT QUEUED SOMETHING ──
 *
 * Every outbox writer calls `noteQueued()` after its INSERT. The writers run
 * inside a route's transaction, often several calls deep, so the note travels
 * by AsyncLocalStorage rather than by an argument threaded through every
 * signature: the scope opens around the request (`watchQueue`), and everything
 * the request awaits, a transaction's callback included, sees it. The routes
 * that queue today are the reply, the thread, the status change, the tracker
 * buttons and the trackers' own webhooks; the next one needs no wiring.
 *
 * ── WHEN ──
 *
 * After the handler has returned, which is after its transaction committed or
 * rolled back. A drain started any earlier could claim before the commit and
 * find nothing. One started after a rollback finds nothing either, which costs
 * a few statements and is correct.
 */

const scope = new AsyncLocalStorage<{ queued: boolean }>();

/** Called by every outbox writer after its INSERT. Outside a request (a test, a
 *  job) there is no scope and this does nothing. */
export function noteQueued(): void {
  const s = scope.getStore();
  if (s) s.queued = true;
}

/** Runs `fn` (a request's handlers) and answers whether anything it awaited queued outbox work. */
export async function watchQueue(fn: () => Promise<unknown>): Promise<boolean> {
  const s = { queued: false };
  await scope.run(s, fn);
  return s.queued;
}

/**
 * ONE DRAIN AT A TIME PER PROCESS, however many writes ask.
 *
 * A second write that queues work while a drain is running does not start
 * another, which would sit on a pooled connection waiting for the job lock the
 * first one holds. It marks the running drain to go round once more and gets
 * that drain's promise, which settles only after the extra round has claimed
 * its row. The mark is checked in the same synchronous turn the drain ends in,
 * so no write can land between "nothing more to do" and "done".
 *
 * Never rejects: a drain that fails leaves its rows pending for the sweep and
 * says so in the log. A failed send is not the request's failure; the response
 * has already gone.
 */
export function createDrainer(run: () => Promise<void>, log: (m: string) => void): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await run();
          } catch (e) {
            log(`jobs: the drain after a write failed; the sweep will pick it up: ${e instanceof Error ? e.message : String(e)}`);
          }
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/** How long one drain may keep starting work. It runs after the response, so
 *  nobody waits on it, except where the platform offers no way to keep work
 *  alive and the response holds for it (`serverless.ts`). */
export const DRAIN_BUDGET_MS = 15_000;
/** How long a drain waits for another instance's drain of the same job. */
export const DRAIN_LOCK_WAIT_MS = 5_000;

/** The drain a write starts: the two outbox jobs, due or not, waiting briefly for a lock another instance holds. */
export function outboxDrain(sql: postgres.Sql, jobs: () => Promise<Job[]>): () => Promise<void> {
  return createDrainer(
    async () => {
      const summary = await runDueJobs(sql, await jobs(), {
        budgetMs: DRAIN_BUDGET_MS,
        force: true,
        waitForLockMs: DRAIN_LOCK_WAIT_MS,
        // One row per pass: a comment fans out to everyone on its thread, and a
        // bulk status change to every tracker it touches.
        maxPasses: 200,
        log: (m) => console.log(m),
      });
      if (summary.ran.some((r) => r.did > 0) || summary.failed.length) console.log(summarise(summary));
      for (const f of summary.failed) console.error(`jobs: ${f.name} failed: ${f.error}`);
    },
    (m) => console.error(m),
  );
}

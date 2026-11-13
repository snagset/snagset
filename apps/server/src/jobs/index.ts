import type postgres from "postgres";

/**
 * The jobs engine — the scheduled work, as a BOUNDED CALL.
 *
 * `runDueJobs()` does some work and returns. It is not a loop, it does not
 * sleep, and it owns no timer. Sweep R6 is the reason and it is not a style
 * preference: puts the blessed deployment on serverless, where a
 * resident process is not merely discouraged but absent — a lambda that ticks
 * a `setInterval` is a lambda that is billed for a timer nobody will observe
 * fire. So the SCHEDULE lives outside: the bin's own interval locally, a cron
 * request at L2. Both call the same function, which is why L2 needs no second
 * implementation of anything below. Now there is a third caller, and it
 * is the one people wait on: the drain a write starts right after its response
 * (`soon.ts`), which passes `force` and `waitForLockMs`. The first two are now
 * a sweep, hourly or daily, because a query every minute kept a serverless
 * Postgres from ever sleeping.
 *
 * ── THE FOUR THINGS THE DoD ASKS FOR, AND WHERE EACH ONE IS ──
 *
 *  1. *A due job drains within one tick.* A job returns `more: true` when it
 *     stopped early on its own batch limit, and the engine calls it again
 *     inside the same tick until it says otherwise or the budget runs out.
 *     Without this a 5 000-row backlog would take 5 000 ticks at one batch
 *     each, which for a 15-minute reaper is seven weeks.
 *  2. *A job that throws does not stop the others.* Each job's work is its own
 *     transaction and its own `try`. A throw is recorded against that job and
 *     the loop continues.
 *  3. *Two concurrent ticks do not double-run one job.* One advisory lock PER
 *     JOB, taken inside the work transaction with `pg_try_advisory_xact_lock`
 *     so the database releases it on commit or rollback and a crashed process
 *     cannot leave it held. Per job rather than one lock for the whole tick,
 *     so a slow reaper on one instance does not stall a fast outbox drain on
 *     another.
 *  4. *`budgetMs` is honoured.* Checked before each job and between drain
 *     passes. It is not a deadline the running statement is interrupted at —
 *     killing a half-finished DELETE mid-flight buys nothing, since the
 *     transaction rolls back anyway — it is a promise not to START more work
 *     once the budget is gone.
 */

/** Everything a job is given. `sql` is already inside the maintenance
 *  transaction, so a job never opens one of its own. */
export interface JobContext {
  readonly sql: postgres.Sql | postgres.TransactionSql;
  /** Injected, never `new Date()` inside a job — that is what makes the
   *  reaper's boundaries testable without waiting 24 hours. */
  readonly now: Date;
  readonly log: (message: string) => void;
}

export interface JobOutcome {
  /** Rows affected — reported, and the only thing the summary counts. */
  readonly did: number;
  /** The job hit its own batch limit and has more to do. See DoD 1. */
  readonly more?: boolean;
  /** One short line for the operator; appears in the tick log. */
  readonly note?: string;
}

export interface Job {
  readonly name: string;
  /** How stale this job's last run may be before it is due again. */
  readonly everyMs: number;
  run(ctx: JobContext): Promise<JobOutcome>;
}

export type SkipReason = "not-due" | "locked" | "budget";

export interface JobsSummary {
  readonly ran: readonly { name: string; did: number; ms: number; passes: number }[];
  readonly skipped: readonly { name: string; why: SkipReason }[];
  readonly failed: readonly { name: string; error: string }[];
  readonly ms: number;
}

export interface RunOptions {
  /** Stop starting new work after this many milliseconds. */
  readonly budgetMs: number;
  /** Injected clock. Defaults to the wall clock. */
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
  /** Cap on drain passes for one job in one tick, so a job that always says
   *  `more` cannot spin until the budget is gone. */
  readonly maxPasses?: number;
  /**
   * Run every job given, due or not. The drain a write starts after its
   * response passes this: the row it queued a moment ago is the reason to run,
   * and a drain that ran ten seconds earlier for somebody else's comment must
   * not make this one wait for the sweep.
   */
  readonly force?: boolean;
  /**
   * Wait this long for a job's lock instead of giving up at once. A
   * sweep that finds a job locked can leave it: the holder is doing the work.
   * A write's drain cannot, because the holder may already have run its last,
   * empty claim before this write committed, and would finish without seeing
   * the row. Waiting for it to finish and then claiming again closes that gap.
   */
  readonly waitForLockMs?: number;
}

/**
 * The advisory lock namespace — the first half of the two-int lock id.
 *
 * 0x63644A42 is the ASCII for "cdJB", picked the same way `MIGRATION_LOCK_ID`
 * picks "cdMG": the number is meaningless, and what matters is only that every
 * instance computes the SAME one without coordinating.
 */
export const JOB_LOCK_NAMESPACE = 0x63644a42;

/**
 * Job name → the second half of the lock id, as a SIGNED 32-bit int.
 *
 * FNV-1a rather than a hash import: the requirement is that two processes
 * agree, not that the result is hard to reverse. `| 0` at the end is what
 * makes it signed — Postgres takes `int4`, and handing it 3 000 000 000 is an
 * out-of-range error rather than a silent wrap.
 */
export function jobLockKey(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * The engine's own bookkeeping table.
 *
 * Created here rather than in a migration, and the precedent is `_migrations`
 * itself: The design owns the DOMAIN schema — every table a tenant's data lives in
 * and the runners that operate on it keep their own state beside it. Both are
 * `_`-prefixed, both hold no tenant data, both have no `org_id` and therefore
 * no RLS policy to write (`rls.ts` only inspects tables that carry one).
 *
 * `last_run_at` is written whether the job SUCCEEDED OR FAILED. A job that
 * throws every time would otherwise be due on every tick forever, and a
 * failing 15-minute reaper hammering the database once a second is a worse
 * outage than the one it started with. The error is kept beside it so the
 * operator can see which, and how long it has been that way.
 */
async function ensureTable(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _jobs (
      name        text PRIMARY KEY,
      last_run_at timestamptz NOT NULL,
      last_ms     integer NOT NULL DEFAULT 0,
      last_did    integer NOT NULL DEFAULT 0,
      last_error  text
    )
  `;
}

export async function runDueJobs(
  sql: postgres.Sql,
  jobs: readonly Job[],
  opts: RunOptions,
): Promise<JobsSummary> {
  const started = Date.now();
  const clock = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const maxPasses = opts.maxPasses ?? 20;
  const spent = () => Date.now() - started;

  const ran: { name: string; did: number; ms: number; passes: number }[] = [];
  const skipped: { name: string; why: SkipReason }[] = [];
  const failed: { name: string; error: string }[] = [];

  await ensureTable(sql);

  const last = new Map(
    (await sql<{ name: string; last_run_at: Date }[]>`SELECT name, last_run_at FROM _jobs`).map(
      (r) => [r.name, r.last_run_at],
    ),
  );

  for (const job of jobs) {
    if (spent() >= opts.budgetMs) {
      skipped.push({ name: job.name, why: "budget" });
      continue;
    }

    const now = clock();
    const previous = last.get(job.name);
    // No row at all means never run, which is due. `>=` rather than `>` so a
    // job with everyMs 0 — "every tick" — actually runs every tick.
    if (!opts.force && previous && now.getTime() - previous.getTime() < job.everyMs) {
      skipped.push({ name: job.name, why: "not-due" });
      continue;
    }

    const at = Date.now();
    let did = 0;
    let passes = 0;
    let error: string | null = null;
    let lockedOut = false;

    try {
      for (;;) {
        const outcome = await runOnce(sql, job, clock(), log, opts.waitForLockMs);
        if (outcome === "locked") {
          lockedOut = true;
          break;
        }
        passes++;
        did += outcome.did;
        if (outcome.note) log(`jobs: ${job.name}: ${outcome.note}`);
        if (!outcome.more) break;
        if (passes >= maxPasses) {
          log(`jobs: ${job.name}: stopping at ${maxPasses} passes with work left`);
          break;
        }
        if (spent() >= opts.budgetMs) {
          log(`jobs: ${job.name}: out of budget with work left`);
          break;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (lockedOut) {
      // Another instance has it. Deliberately NOT recorded as a run: that
      // instance will write `last_run_at` when it finishes, and claiming the
      // run here would make this one think the work was done.
      skipped.push({ name: job.name, why: "locked" });
      continue;
    }

    const ms = Date.now() - at;
    if (error) failed.push({ name: job.name, error });
    else ran.push({ name: job.name, did, ms, passes });

    await record(sql, job.name, clock(), ms, did, error);
  }

  return { ran, skipped, failed, ms: spent() };
}

/**
 * One pass of one job: take the lock, claim maintenance, do the work — all in
 * ONE transaction, so all three end together however it ends.
 *
 * `SET LOCAL app.maintenance` is the maintenance claim and without
 * it every statement in every job matches zero rows on any deployment whose
 * role does not bypass RLS. `LOCAL` is the half that makes it an exemption
 * rather than a hole: it cannot outlive this transaction, so nothing that runs
 * after it inherits cross-tenant reach.
 *
 * With `waitMs` the lock is WAITED for, up to that long, under a
 * `lock_timeout` set with `set_config(…, true)` — the `SET LOCAL` that takes a
 * parameter — and put back to the default once the lock is held, so the job's
 * own statements wait on rows exactly as they always did. Running out of time
 * is `lock_not_available` (55P03), which aborts the transaction; it is caught
 * outside and reported as "locked", the answer the try-lock would have given.
 */
async function runOnce(
  sql: postgres.Sql,
  job: Job,
  now: Date,
  log: (m: string) => void,
  waitMs?: number,
): Promise<JobOutcome | "locked"> {
  try {
    return (await sql.begin(async (tx) => {
      if (waitMs) {
        await tx`SELECT set_config('lock_timeout', ${`${Math.max(1, Math.round(waitMs))}ms`}, true)`;
        await tx`SELECT pg_advisory_xact_lock(${JOB_LOCK_NAMESPACE}, ${jobLockKey(job.name)})`;
        await tx`SET LOCAL lock_timeout TO DEFAULT`;
      } else {
        const [lock] = await tx<{ ok: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${JOB_LOCK_NAMESPACE}, ${jobLockKey(job.name)}) AS ok
        `;
        if (!lock?.ok) return "locked" as const;
      }
      await tx`SET LOCAL app.maintenance = 'on'`;
      return job.run({ sql: tx, now, log });
    })) as JobOutcome | "locked";
  } catch (e) {
    if (waitMs && (e as { code?: string }).code === "55P03") return "locked";
    throw e;
  }
}

/** Bookkeeping, in its own transaction so a rolled-back job still records the
 *  attempt. Every job is idempotent, so the worst case if this write is lost
 *  to a crash is that the work is repeated — which is the direction to fail
 *  in. */
async function record(
  sql: postgres.Sql,
  name: string,
  at: Date,
  ms: number,
  did: number,
  error: string | null,
): Promise<void> {
  await sql`
    INSERT INTO _jobs (name, last_run_at, last_ms, last_did, last_error)
    VALUES (${name}, ${at}, ${ms}, ${did}, ${error})
    ON CONFLICT (name) DO UPDATE
      SET last_run_at = EXCLUDED.last_run_at,
          last_ms     = EXCLUDED.last_ms,
          last_did    = EXCLUDED.last_did,
          last_error  = EXCLUDED.last_error
  `;
}

/** One line an operator can read in a log without a dashboard. */
export function summarise(s: JobsSummary): string {
  const ran = s.ran.filter((r) => r.did > 0).map((r) => `${r.name}:${r.did}`);
  const parts = [`${s.ms}ms`];
  if (ran.length) parts.push(ran.join(" "));
  if (s.failed.length) parts.push(`FAILED ${s.failed.map((f) => f.name).join(" ")}`);
  const locked = s.skipped.filter((x) => x.why === "locked");
  if (locked.length) parts.push(`locked ${locked.map((l) => l.name).join(" ")}`);
  return `jobs: ${parts.join(" · ")}`;
}

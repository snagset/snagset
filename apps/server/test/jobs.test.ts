import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { runDueJobs, jobLockKey, JOB_LOCK_NAMESPACE, type Job } from "../src/jobs/index.ts";
import { writeModeDowngrade, expireRows, reapPendingAttachments } from "../src/jobs/reaper.ts";
import type { Bucket } from "../src/storage/bucket.ts";

/**
 * The jobs engine and L1's three reaper jobs.
 *
 * Needs a database, and not incidentally: every one of the DoD's four claims
 * is a claim about Postgres. "Two concurrent ticks do not double-run one job"
 * is an assertion about `pg_try_advisory_xact_lock`, and the maintenance-claim
 * test below is an assertion about how a policy evaluates for a role that
 * cannot bypass it. Neither is a thing a mock can be wrong about convincingly.
 *
 * Skipped without `SNAGSET_TEST_DATABASE_URL` for the reason every suite here
 * is: this file DROPS AND RECREATES the public schema.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the jobs tests";

let sql: postgres.Sql;
let orgId: string;
let projectId: string;

const NOW = new Date("2026-08-24T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const at = () => NOW;

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error(
      "SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.",
    );
  }
  sql = connect(URL_!, { max: 4 });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});

  orgId = randomUUID();
  projectId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Studio', 'studio')`;
    await tx`
      INSERT INTO projects (id, org_id, uid, name, ip_salt, config_etag)
      VALUES (${projectId}, ${orgId}, 'prj_jjjjjjjjjjjj', 'Jobs',
              ${Buffer.alloc(32, 7)}, 'etag')`;
  });
});

after(async () => {
  if (!skip) await sql.end();
});

/** A job that records what it was asked and answers however the test needs. */
function fake(name: string, impl: Partial<Job> & { onRun?: () => void } = {}): Job & { runs: number } {
  const j = {
    name,
    everyMs: impl.everyMs ?? 0,
    runs: 0,
    async run() {
      j.runs++;
      impl.onRun?.();
      return { did: 1 };
    },
  };
  return j as Job & { runs: number };
}

test("a job that has never run is due; one that just ran is not", { skip }, async () => {
  const j = fake("t-due", { everyMs: 60_000 });
  const first = await runDueJobs(sql, [j], { budgetMs: 5000, now: at });
  assert.equal(first.ran.length, 1, "never run before ⇒ due");
  assert.equal(j.runs, 1);

  const second = await runDueJobs(sql, [j], { budgetMs: 5000, now: at });
  assert.equal(j.runs, 1, "the clock has not moved, so it is not due again");
  assert.deepEqual(second.skipped, [{ name: "t-due", why: "not-due" }]);

  // …and it IS due once everyMs has elapsed.
  const later = new Date(NOW.getTime() + 61_000);
  await runDueJobs(sql, [j], { budgetMs: 5000, now: () => later });
  assert.equal(j.runs, 2);
});

test("DoD 1 — a job reporting `more` drains within ONE tick", { skip }, async () => {
  let left = 4;
  const j: Job = {
    name: "t-drain",
    everyMs: 0,
    async run() {
      left--;
      return { did: 1, more: left > 0 };
    },
  };
  const s = await runDueJobs(sql, [j], { budgetMs: 5000, now: at });
  assert.equal(left, 0, "one tick emptied the backlog");
  assert.equal(s.ran[0]?.passes, 4, "…in four passes, not four ticks");
  assert.equal(s.ran[0]?.did, 4, "and every pass's rows are counted");
});

test("DoD 1b — a job that always says `more` is stopped by maxPasses", { skip }, async () => {
  let passes = 0;
  const j: Job = {
    name: "t-forever",
    everyMs: 0,
    async run() {
      passes++;
      return { did: 1, more: true };
    },
  };
  await runDueJobs(sql, [j], { budgetMs: 30_000, now: at, maxPasses: 3 });
  assert.equal(passes, 3, "a job that never finishes must not spin until the budget is gone");
});

test("DoD 2 — a job that throws does not stop the others", { skip }, async () => {
  const before_ = fake("t-before");
  const boom: Job = {
    name: "t-boom",
    everyMs: 0,
    run() {
      throw new Error("deliberate");
    },
  };
  const after_ = fake("t-after");

  const s = await runDueJobs(sql, [before_, boom, after_], { budgetMs: 5000, now: at });
  assert.equal(before_.runs, 1);
  assert.equal(after_.runs, 1, "the job AFTER the thrower still ran");
  assert.deepEqual(
    s.failed.map((f) => f.name),
    ["t-boom"],
  );
  assert.match(s.failed[0]!.error, /deliberate/);

  // And the failure is recorded, so it is not due again immediately — a job
  // that throws every time must not hammer the database once per tick.
  const [row] = await sql<{ last_error: string | null }[]>`
    SELECT last_error FROM _jobs WHERE name = 't-boom'`;
  assert.match(row!.last_error ?? "", /deliberate/);
});

test("DoD 3 — a second tick cannot double-run a job the first holds", { skip }, async () => {
  // The lock is real, so the way to test it is to hold it for real: open a
  // transaction on a SECOND connection, take that job's advisory lock, and
  // assert the engine steps around it rather than waiting or double-running.
  const other = connect(URL_!, { max: 1 });
  const j = fake("t-locked", { everyMs: 0 });
  try {
    await other.begin(async (tx) => {
      const [held] = await tx<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${JOB_LOCK_NAMESPACE}, ${jobLockKey("t-locked")}) AS ok`;
      assert.equal(held?.ok, true, "the test itself must hold the lock");

      const s = await runDueJobs(sql, [j], { budgetMs: 5000, now: at });
      assert.equal(j.runs, 0, "the engine did not run a job another tick holds");
      assert.deepEqual(s.skipped, [{ name: "t-locked", why: "locked" }]);
    });
  } finally {
    await other.end();
  }

  // Lock released with the transaction: the job is still due, and now runs.
  const s = await runDueJobs(sql, [j], { budgetMs: 5000, now: at });
  assert.equal(j.runs, 1);
  assert.equal(s.ran.length, 1);
});

test("DoD 3b — being locked out is NOT recorded as a run", { skip }, async () => {
  // If it were, the instance that skipped would push the next due time
  // forward for the instance that actually did the work.
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM _jobs WHERE name = 't-never-ran'`;
  assert.equal(row!.n, 0);

  const other = connect(URL_!, { max: 1 });
  try {
    await other.begin(async (tx) => {
      await tx`SELECT pg_try_advisory_xact_lock(${JOB_LOCK_NAMESPACE}, ${jobLockKey("t-never-ran")})`;
      await runDueJobs(sql, [fake("t-never-ran")], { budgetMs: 5000, now: at });
    });
  } finally {
    await other.end();
  }

  const [after2] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM _jobs WHERE name = 't-never-ran'`;
  assert.equal(after2!.n, 0, "no bookkeeping row for a job that never ran");
});

test("`force` runs a job that is not due, which is what a write's drain needs", { skip }, async () => {
  const j = fake("t-force", { everyMs: 60 * 60_000 });
  await runDueJobs(sql, [j], { budgetMs: 5000, now: at });
  const ordinary = await runDueJobs(sql, [j], { budgetMs: 5000, now: at });
  assert.equal(j.runs, 1);
  assert.deepEqual(ordinary.skipped, [{ name: "t-force", why: "not-due" }], "an ordinary tick still skips it");
  await runDueJobs(sql, [j], { budgetMs: 5000, now: at, force: true });
  assert.equal(j.runs, 2, "forced, it runs within the hour");
});

test("With waitForLockMs a held job runs as soon as the holder commits, not never", { skip }, async () => {
  // The case it exists for: another instance's drain holds the lock and has
  // already made its last, empty claim when this write commits. Giving up
  // would leave this write's row for the sweep; waiting claims it.
  const other = connect(URL_!, { max: 1 });
  const j = fake("t-wait", { everyMs: 0 });
  try {
    let release!: () => void;
    const letGo = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const held = new Promise<void>((r) => (taken = r));
    const holder = other.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${JOB_LOCK_NAMESPACE}, ${jobLockKey("t-wait")})`;
      taken();
      await letGo;
    });
    await held;
    const waiting = runDueJobs(sql, [j], { budgetMs: 5000, now: at, waitForLockMs: 5000 });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(j.runs, 0, "nothing runs while the other tick holds it");
    release();
    await holder;
    const s = await waiting;
    assert.equal(j.runs, 1, "it ran once the holder committed");
    assert.deepEqual(s.ran.map((r) => r.name), ["t-wait"]);
  } finally {
    await other.end();
  }
});

test("A wait that runs out is 'locked', as the try-lock says, and no run is recorded", { skip }, async () => {
  const other = connect(URL_!, { max: 1 });
  const j = fake("t-wait-out", { everyMs: 0 });
  try {
    await other.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${JOB_LOCK_NAMESPACE}, ${jobLockKey("t-wait-out")})`;
      const s = await runDueJobs(sql, [j], { budgetMs: 5000, now: at, waitForLockMs: 150 });
      assert.equal(j.runs, 0);
      assert.deepEqual(s.skipped, [{ name: "t-wait-out", why: "locked" }]);
    });
  } finally {
    await other.end();
  }
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM _jobs WHERE name = 't-wait-out'`;
  assert.equal(row!.n, 0, "a timed-out wait is not a run");
  // The timeout was the transaction's own: the next ordinary tick is unaffected.
  await runDueJobs(sql, [j], { budgetMs: 5000, now: at });
  assert.equal(j.runs, 1);
});

test("DoD 4 — budgetMs stops the engine STARTING more work", { skip }, async () => {
  const slow: Job = {
    name: "t-slow",
    everyMs: 0,
    async run() {
      await new Promise((r) => setTimeout(r, 60));
      return { did: 1 };
    },
  };
  const never = fake("t-never", { everyMs: 0 });
  const s = await runDueJobs(sql, [slow, never], { budgetMs: 40, now: at });
  assert.equal(never.runs, 0, "the budget was gone before the second job started");
  assert.deepEqual(s.skipped, [{ name: "t-never", why: "budget" }]);
});

test("the write-mode downgrade actually writes the row", { skip }, async () => {
  await sql`
    UPDATE projects
       SET write_mode = 'open', write_mode_downgrade_at = ${ago(60_000)}
     WHERE id = ${projectId}`;

  await runDueJobs(sql, [writeModeDowngrade], { budgetMs: 5000, now: at });

  const [row] = await sql<{ write_mode: string; write_mode_downgrade_at: Date | null }[]>`
    SELECT write_mode, write_mode_downgrade_at FROM projects WHERE id = ${projectId}`;
  assert.equal(row!.write_mode, "link-required");
  assert.equal(
    row!.write_mode_downgrade_at,
    null,
    "the countdown column is cleared, or the dashboard renders a negative number",
  );
});

test("a project whose window has NOT closed is left alone", { skip }, async () => {
  await sql`
    UPDATE projects
       SET write_mode = 'open', write_mode_downgrade_at = ${new Date(NOW.getTime() + 3_600_000)}
     WHERE id = ${projectId}`;
  await sql`DELETE FROM _jobs WHERE name = 'write-mode-downgrade'`;

  await runDueJobs(sql, [writeModeDowngrade], { budgetMs: 5000, now: at });

  const [row] = await sql<{ write_mode: string }[]>`
    SELECT write_mode FROM projects WHERE id = ${projectId}`;
  assert.equal(row!.write_mode, "open", "the grace window is 24 hours, not until the next tick");
});

test("expired rows are deleted and live ones are not", { skip }, async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO identity_nonces (org_id, project_id, nonce, expires_at)
      VALUES (${orgId}, ${projectId}, 'stale', ${ago(60_000)}),
             (${orgId}, ${projectId}, 'fresh', ${new Date(NOW.getTime() + 60_000)})`;
  });

  await runDueJobs(sql, [expireRows], { budgetMs: 5000, now: at });

  const rows = await sql<{ nonce: string }[]>`
    SELECT nonce FROM identity_nonces ORDER BY nonce`;
  assert.deepEqual(
    rows.map((r) => r.nonce),
    ["fresh"],
    "the expired nonce is gone and the live one is untouched",
  );
});

test("pending attachments past their window are reaped, and the blob is deleted first", { skip }, async () => {
  const deleted: string[] = [];
  const bucket: Bucket = {
    put: async () => {},
    get: async () => null,
    del: async (k) => void deleted.push(k),
    probe: async () => ({ ok: true }),
  };

  const oldImage = randomUUID();
  const freshImage = randomUUID();
  const oldFile = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO attachments
        (id, org_id, project_id, kind, state, storage_key, content_type, bytes, sha256,
         original_filename, created_at)
      VALUES
        (${oldImage},   ${orgId}, ${projectId}, 'screenshot', 'pending', 'k/old-image',   'image/webp', 10, ${Buffer.alloc(32, 1)}, NULL, ${ago(3 * 3_600_000)}),
        (${freshImage}, ${orgId}, ${projectId}, 'screenshot', 'pending', 'k/fresh-image', 'image/webp', 10, ${Buffer.alloc(32, 2)}, NULL, ${ago(60_000)}),
        -- kind='file' carries a CHECK requiring the download filename.
        (${oldFile},    ${orgId}, ${projectId}, 'file',       'pending', 'k/old-file',    'application/octet-stream', 10, ${Buffer.alloc(32, 3)}, 'spec.pdf', ${ago(20 * 60_000)})`;
    await tx`UPDATE projects SET storage_bytes_used = 30 WHERE id = ${projectId}`;
  });

  await runDueJobs(sql, [reapPendingAttachments(bucket)], { budgetMs: 5000, now: at });

  assert.deepEqual(deleted.sort(), ["k/old-file", "k/old-image"], "both stale blobs deleted");

  const rows = await sql<{ id: string; state: string }[]>`
    SELECT id, state FROM attachments ORDER BY storage_key`;
  const state = new Map(rows.map((r) => [r.id, r.state]));
  assert.equal(state.get(oldImage), "orphaned");
  assert.equal(state.get(oldFile), "orphaned", "a file's presign window is 15 minutes");
  assert.equal(state.get(freshImage), "pending", "an image an hour old may still be uploading");

  const [p] = await sql<{ used: string }[]>`
    SELECT storage_bytes_used AS used FROM projects WHERE id = ${projectId}`;
  assert.equal(Number(p!.used), 10, "The counter is decremented by what was reaped");
});

/**
 * The maintenance claim, tested the only way it can be: as a role that
 * cannot bypass RLS.
 *
 * This is the test the whole decision exists for. Without the claim, every
 * statement above matches zero rows for such a role and every job reports
 * success — and because the role in a Neon connection string DOES bypass RLS,
 * that failure is invisible in development and universal in production.
 *
 * `SET LOCAL ROLE` rather than a second connection: RLS is evaluated against
 * the CURRENT role, so switching inside a transaction exercises the policy
 * exactly as a differently-credentialled deployment would, and rolls back
 * automatically.
 */
test("A non-bypassing role sees rows only under the maintenance claim", { skip }, async () => {
  const role = `jobs_test_role`;
  try {
    await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await sql.unsafe(`CREATE ROLE ${role} NOBYPASSRLS`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
  } catch (e) {
    // A managed database may not permit CREATE ROLE. The catalogue assertion
    // below still holds, and is what CI relies on there.
    assert.ok(e instanceof Error);
    return;
  }

  try {
    const withoutClaim = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM projects`;
      return r!.n;
    });
    assert.equal(
      withoutClaim,
      0,
      "this is the bug the decision fixes: without the claim the reaper sees nothing at all",
    );

    const withClaim = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SET LOCAL app.maintenance = 'on'`;
      const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM projects`;
      return r!.n;
    });
    assert.equal(withClaim, 1, "and with it, the row is visible");

    // The claim is SET LOCAL, so it cannot leak past the transaction that
    // opened it. That property is what makes it an exemption and not a hole.
    const afterCommit = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM projects`;
      return r!.n;
    });
    assert.equal(afterCommit, 0, "the claim did not survive the previous transaction");
  } finally {
    await sql.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`).catch(() => {});
    await sql.unsafe(`REVOKE USAGE ON SCHEMA public FROM ${role}`).catch(() => {});
    await sql.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
});

test("D56b — an org_id that has been set and released does not raise on ::uuid", { skip }, async () => {
  // The second bug migration 0002 fixes, and the worse of the two. After a
  // transaction that did set_config('app.org_id', ..., true) commits, the
  // setting reads back as the EMPTY STRING rather than NULL — so the next
  // statement on that pooled connection evaluates ''::uuid and RAISES. Every
  // request sets that variable and every connection is reused, so on a
  // deployment that actually evaluates the policy this is the second request
  // onwards, not an edge case.
  const role = `jobs_nullif_role`;
  try {
    await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await sql.unsafe(`CREATE ROLE ${role} NOBYPASSRLS`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
  } catch {
    return; // managed database without CREATE ROLE; the catalogue test still holds
  }

  try {
    const n = await sql.begin(async (tx) => {
      // Set it and release it, exactly as a served request does...
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      await tx`SELECT set_config('app.org_id', '', true)`;
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      // ...then read, with the policy evaluated for a role that cannot bypass.
      const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM projects`;
      return r!.n;
    });
    assert.equal(n, 0, "no tenant context filters rows out — it must not raise");
  } finally {
    await sql.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`).catch(() => {});
    await sql.unsafe(`REVOKE USAGE ON SCHEMA public FROM ${role}`).catch(() => {});
    await sql.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
});

test("every org policy carries the maintenance claim AND the NULLIF guard", { skip }, async () => {
  const rows = await sql<{ name: string }[]>`
    SELECT c.relname AS name
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND pol.polname = c.relname || '_org'
       AND (pg_get_expr(pol.polqual, pol.polrelid) NOT LIKE '%app.maintenance%'
         OR (pg_get_expr(pol.polqual, pol.polrelid) LIKE '%app.org_id%'
             AND pg_get_expr(pol.polqual, pol.polrelid) NOT LIKE '%NULLIF%'))
     ORDER BY c.relname`;
  assert.deepEqual(
    rows.map((r) => r.name),
    [],
    "a policy missing the claim is a table the reaper silently cannot touch; " +
      "one missing NULLIF raises on every reused connection",
  );
});

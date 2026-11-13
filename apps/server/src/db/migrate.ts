import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * The migrator.
 *
 * Hand-written, and deliberately not `drizzle-kit migrate`. A9 promises `npx
 * snagset` against one `DATABASE_URL` works, which means migrations run at BOOT
 * on a machine nobody is watching, on a platform that may start several
 * instances of the process at once. That is a concurrency problem before it is
 * a schema problem, and it is the half a migration runner bolted onto a CLI
 * does not solve.
 *
 * The four rules that make an unattended boot safe:
 *
 *  1. **One advisory lock, per file, inside its transaction.** Vercel starts
 *     N lambdas; a Railway deploy overlaps old and new containers. Without
 *     the lock, two processes run `CREATE TABLE` concurrently and the loser
 *     dies on a duplicate — which looks exactly like a corrupt database to
 *     whoever reads the logs. With it, the loser waits, then finds the file
 *     already in the ledger and moves on.
 *
 *     TRANSACTION-scoped (`pg_advisory_xact_lock`), not session-scoped, and
 *     the reason is the pooled `DATABASE_URL` blesses. A pooler in
 *     transaction mode (Supabase's port 6543, Neon's `-pooler`, PgBouncer)
 *     hands a client a backend for one transaction at a time; a session lock
 *     taken on one backend and released on another is a lock nobody holds
 *     and nobody can release — the fleet wedges on the next deploy. Inside a
 *     transaction every statement is on one backend, by the pooler's own
 *     rule, so the lock and the work it guards cannot come apart. The lock
 *     also dies with a crashed migrator's transaction, so nothing has to be
 *     released by hand.
 *  2. **Checksums, compared every boot.** A migration file that changed after
 *     it was applied is the single most expensive thing to discover late: every
 *     environment is now a different schema wearing the same version number.
 *     Refused loudly, exit 4, before a single statement runs.
 *  3. **Each file in ONE transaction.** Postgres does transactional DDL, so a
 *     migration either happened or did not. The `.no-txn.sql` suffix opts out
 *     for the statements that cannot run inside one (`CREATE INDEX
 *     CONCURRENTLY`); nothing needs it at 0001, and the mechanism exists so
 *     that the first thing that does is not also the first time this code is
 *     asked to handle it.
 *  4. **A short `lock_timeout`, per file.** A migration blocked behind a long
 *     read holds the advisory lock while every other instance queues behind it.
 *     Three seconds, then fail cleanly and let the platform retry — a failed
 *     deploy is recoverable, a deploy wedged for an hour is an outage.
 *
 * Exit codes, because a boot script has to be able to tell these apart:
 *   0  up to date (or applied cleanly)
 *   3  could not connect / could not take the lock
 *   4  refused: a checksum changed, or an applied migration is missing
 *   1  a migration failed to apply
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "migrations");

/**
 * The advisory lock id. A constant, because every instance has to pick the
 * SAME number without coordinating — that is the entire mechanism.
 *
 * 0x63644D47 = 1667517767, the ASCII for "cdMG". Kept rather than re-derived
 * from the new name: the number is meaningless by design, and changing it in a
 * fleet where an old instance still holds the old one is precisely the
 * split-brain the lock exists to prevent. Rename residue elsewhere is a bug;
 * here it is the point.
 */
export const MIGRATION_LOCK_ID = 0x63644d47;

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Files in lexical order — `0001_…` before `0002_…`, which is why they are numbered. */
function files(): { name: string; sql: string; checksum: string; txn: boolean }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(DIR, name), "utf8");
      return { name, sql, checksum: sha256(sql), txn: !name.endsWith(".no-txn.sql") };
    });
}

export class MigrationError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "MigrationError";
    this.exitCode = exitCode;
  }
}

export async function migrate(sql: postgres.Sql, log = console.log): Promise<MigrateResult> {
  // The ledger itself, first and outside any lock: it is `IF NOT EXISTS`, it is
  // the only DDL that can safely race, and every later step reads it.
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )
  `;

  const all = files();

  // Rule 2, and it runs over EVERY file before any of them is applied. A
  // half-migrated database whose next file is the corrupt one is worse than
  // one that refused at the door.
  /*
   * WHEN 0001 STOPS BEING REGENERABLE, and why it still is today.
   *
   * 0001_init.sql is GENERATED (gen-migration.mjs), so the design is the
   * single description of the schema and the file is its rendering. That
   * works right up to the moment a second person has applied it, and then it
   * cannot: an applied migration is history, and history that regenerates is
   * a checksum mismatch on somebody else's database.
   *
   * The switch point is, where schemaVersion freezes for publish
   * Before it there is exactly one real install -- the studio's
   * own dogfood -- and correcting plus bringing that one database along by
   * hand is both cheaper and more honest than a numbered ALTER for a schema
   * nobody else has. After it, the design describes the CURRENT schema, 0001 is
   * frozen at what publish shipped, and every change is a new numbered file.
   * The generator's check has to change shape with it: from "0001 renders "
   * to "0001 plus every later file EQUALS ", which needs a scratch database
   * to answer and is therefore a gate rather than a pure function.
   *
   * The rule below does not soften either way. It is what makes that switch
   * point real rather than aspirational.
   */
  const pending = reconcile(all, await ledger(sql));
  if (!pending.length) {
    log(`migrate: up to date (${all.length} applied)`);
    return { applied: [], alreadyApplied: all.length };
  }

  const applied: string[] = [];
  for (const f of pending) {
    const started = Date.now();

    /**
     * Rule 1, per file: the lock is TRANSACTION-scoped and the ledger is read
     * again under it. Another instance may have applied this file between
     * the reconcile above and here — the loser of that race finds the row,
     * checks the checksum still agrees, and moves on. Two instances booting
     * at once therefore apply each file exactly once between them, and
     * neither needs to know the other exists.
     *
     * Order matters inside: the advisory lock BEFORE `SET LOCAL lock_timeout`,
     * because lock_timeout applies to advisory locks too, and waiting for the
     * other instance to finish a migration is exactly the wait rule 4 must
     * not cut short.
     */
    const run = async (tx: postgres.TransactionSql): Promise<boolean> => {
      const [got] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${MIGRATION_LOCK_ID}) AS ok`;
      if (!got?.ok) {
        log("migrate: another instance holds the lock — waiting");
        await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
      }
      // Rule 4, per file and inside the transaction so it reverts with it.
      await tx`SET LOCAL lock_timeout = '3s'`;
      const [seen] = await tx<{ checksum: string }[]>`SELECT checksum FROM _migrations WHERE name = ${f.name}`;
      if (seen) {
        changed(f, seen.checksum);
        return false;
      }
      await tx.unsafe(f.sql);
      await tx`
        INSERT INTO _migrations (name, checksum, duration_ms)
        VALUES (${f.name}, ${f.checksum}, ${Date.now() - started})
      `;
      return true;
    };

    let did: boolean;
    if (f.txn) {
      log(`migrate: applying ${f.name}…`);
      did = (await sql.begin(run)) as unknown as boolean;
    } else {
      /**
       * Rule 3's exception. A `.no-txn.sql` file holds the one statement
       * Postgres refuses inside a transaction block, so there is no
       * transaction to carry a lock either: it runs on the bare connection,
       * after its own look at the ledger, and the ledger write tolerates a
       * twin. The file is held to being idempotent (`IF NOT EXISTS`) for
       * exactly this reason — two instances may both run it, and the
       * statement, not the runner, is what makes that harmless.
       */
      const [seen] = await sql<{ checksum: string }[]>`SELECT checksum FROM _migrations WHERE name = ${f.name}`;
      if (seen) {
        changed(f, seen.checksum);
        did = false;
      } else {
        log(`migrate: applying ${f.name} (outside a transaction)…`);
        await sql.unsafe(f.sql);
        const won = await sql<{ name: string }[]>`
          INSERT INTO _migrations (name, checksum, duration_ms)
          VALUES (${f.name}, ${f.checksum}, ${Date.now() - started})
          ON CONFLICT (name) DO NOTHING
          RETURNING name
        `;
        did = won.length > 0;
      }
    }

    if (did) {
      log(`migrate: applied ${f.name} in ${Date.now() - started} ms`);
      applied.push(f.name);
    } else {
      log(`migrate: ${f.name} was applied by another instance meanwhile`);
    }
  }
  return { applied, alreadyApplied: all.length - applied.length };
}

type File = ReturnType<typeof files>[number];

/**
 * The migrations this build ships that the database has not run — empty when
 * it is up to date. For the dashboard's warning, not for deciding anything.
 *
 * Found upgrading a production instance to 0.1.11 on Vercel: the bin migrates at
 * boot, but a serverless deploy has no boot, so the new code went
 * live against the old schema and nothing said so — the first symptom would
 * have been the digest job failing at 03:00. Making the build migrate is not
 * available either: Vercel refuses a build with no static output, and an
 * empty `public/` too. So the step stays the operator's, and this is how a
 * missed one gets noticed in minutes instead of by a failed job.
 *
 * Cached per instance for a minute: `/api/v1/me` asks on every dashboard load,
 * and the answer only changes when someone runs `snagset migrate`. A database
 * with no ledger at all reports every file — that is a fresh one nobody has
 * migrated, and saying so is right.
 */
let behind: { at: number; names: string[] } | null = null;
export async function pendingMigrations(sql: postgres.Sql, now = Date.now()): Promise<string[]> {
  if (behind && now - behind.at < 60_000) return behind.names;
  let done: Map<string, string>;
  try {
    done = await ledger(sql);
  } catch {
    done = new Map();
  }
  const names = files()
    .map((f) => f.name)
    .filter((n) => !done.has(n));
  if (names.length && !behind?.names.length) {
    // Once per instance, not per request: the log is where an operator who
    // never opens the dashboard would see it.
    console.warn(
      `snagset: the database is ${names.length} migration(s) behind this build (${names.join(", ")}). ` +
        "Run `snagset migrate` with this instance's DATABASE_URL.",
    );
  }
  behind = { at: now, names };
  return names;
}

/** Tests only: forget the cached answer. */
export function forgetPendingMigrations(): void {
  behind = null;
}

async function ledger(sql: postgres.Sql | postgres.TransactionSql): Promise<Map<string, string>> {
  return new Map(
    (await sql<{ name: string; checksum: string }[]>`SELECT name, checksum FROM _migrations`).map((r) => [r.name, r.checksum]),
  );
}

/** Rule 2's refusal, in one place: an applied file whose bytes moved. */
function changed(f: File, recorded: string): void {
  if (recorded === f.checksum) return;
  throw new MigrationError(
    `${f.name} has changed since it was applied (recorded ${recorded.slice(0, 12)}…, ` +
      `file is ${f.checksum.slice(0, 12)}…). An applied migration is history: ` +
      `add a new file instead of editing this one.`,
    4,
  );
}

/** The files not yet in the ledger, after rule 2 has refused anything that disagrees with it. */
function reconcile(all: File[], done: Map<string, string>): File[] {
  const pending: File[] = [];
  const left = new Map(done);
  for (const f of all) {
    const seen = left.get(f.name);
    if (seen === undefined) pending.push(f);
    else changed(f, seen);
    left.delete(f.name);
  }
  // Whatever is left was applied and no longer exists on disk — a rollback to
  // an older build against a newer database. Refused for the same reason:
  // the code is about to assume a schema that is not the one present.
  if (left.size) {
    throw new MigrationError(
      `the database has migrations this build does not ship: ${[...left.keys()].join(", ")}. ` +
        `This is an older release running against a newer database.`,
      4,
    );
  }
  return pending;
}

/**
 * `pnpm migrate` / `snagset migrate`. The library above takes a connection so a
 * test can hand it one; only this half reads the environment and exits.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import("../config.ts");
  let code = 0;
  let sql: postgres.Sql | undefined;
  try {
    const cfg = loadConfig(process.env);
    sql = (await import("./connect.ts")).connect(cfg.required("DATABASE_URL"), { max: 1 });
    await migrate(sql);
  } catch (e) {
    if (e instanceof MigrationError) {
      console.error(`✗ migrate: ${e.message}`);
      code = e.exitCode;
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      // A connection failure and a bad migration are different operator
      // problems; 3 means "the database was not reachable", 1 means "it was,
      // and it said no".
      const connectionish = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|password|SASL|SSL|does not exist/i.test(msg);
      console.error(`✗ migrate: ${msg}`);
      code = connectionish ? 3 : 1;
    }
  } finally {
    await sql?.end({ timeout: 5 });
  }
  process.exit(code);
}

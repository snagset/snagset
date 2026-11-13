import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type postgres from "postgres";
import type { Config } from "./config.ts";
import { rlsStatus, type RlsStatus } from "./db/rls.ts";
import { ID_PREFIX } from "@snagset/types/names";
import { slugify } from "./app.ts";
import { createProject, validateOrigins } from "./projects.ts";
import { hashPassword } from "./routes/owner.ts";
import { selectMailer } from "./mail/index.ts";
import { envBucketConfig } from "./storage/settings.ts";
import { createBucket } from "./storage/bucket.ts";

/**
 * First-run bootstrap — the state machine, verbatim.
 *
 *              ┌──────────────┐
 *   boot ─────▶│ UNCONFIGURED │  orgs == 0
 *              └──────┬───────┘
 *         env-bootstrap│          │ no env-bootstrap
 *                      ▼          ▼
 *              ┌──────────┐   ┌───────────┐
 *              │  READY   │◀──│ CLAIMABLE │  claim token minted + printed
 *              └──────────┘   └───────────┘
 *
 * The whole point of the claim token is .4's last paragraph: *"a
 * self-hoster who exposes the instance publicly before opening it would
 * otherwise hand ownership to whoever loads the page first."* Cost: the
 * operator reads the logs once.
 *
 * `CLAIMABLE` answers **409**, never 503, and spends a paragraph on why:
 * a 503 tells an orchestrator and every reverse proxy in the path that the
 * instance is unhealthy and should be retried, when it is healthy and waiting
 * for a human. Draft 3's 503 would have put a fresh instance into a restart
 * loop behind any proxy configured to eject 503-returning backends.
 */

export type BootState = "UNCONFIGURED" | "CLAIMABLE" | "READY";

export interface BootResult {
  state: BootState;
  /** The full `…/setup?claim=…` URL. Present only when a token was just minted. */
  claimUrl: string | null;
  rls: RlsStatus;
  /** Where secret.key / bootstrap.txt went, or null on serverless. */
  dataDir: string | null;
}

/** 32 random bytes, base64url; only sha256(token) is stored. */
const mintToken = (): string => randomBytes(32).toString("base64url");
const hash = (t: string): Buffer => createHash("sha256").update(t).digest();

/**
 * The banner. Reproduced .4 rather than paraphrased — an operator who
 * has read the spec should see the thing the spec showed them, and this is the
 * one screen of output the entire self-host install depends on being noticed.
 */
/**
 * Is this instance claimed? One question, asked where RLS cannot answer it
 * wrongly — and it is the ONLY safe way to ask, which is why it is a function
 * rather than a query anyone can copy.
 *
 * THE BUG THIS CLOSES, which had been live since 0002 and is the same sentence
 * that migration was written to fix, one table further on. `orgs` is FORCE ROW
 * LEVEL SECURITY under
 *
 *   id = NULLIF(current_setting('app.org_id', true), '')::uuid
 *     OR current_setting('app.maintenance', true) = 'on'
 *
 * and the claim check runs before any org exists to scope to — so with neither
 * setting made, `count(*) FROM orgs` returns 0 **on any deployment whose role
 * does not bypass RLS**, whatever the table actually holds. It read correctly
 * only because the role we develop against carries `rolbypassrls`, and
 * `rlsStatus` never caught it because that check inspects tables having an
 * `org_id` column and `orgs` has none — it matches on `id`.
 *
 * Left alone, a correctly-secured instance would call itself CLAIMABLE on
 * every boot and mint a fresh claim token over a live installation. Under the
 * first-visitor-wins setup screen it would be worse than untidy: an
 * already-claimed instance would offer itself to whoever asked next.
 *
 * `SET LOCAL app.maintenance` is the maintenance claim, the same
 * exemption `runOnce` takes for the jobs engine, and `LOCAL` is the half that
 * makes it an exemption rather than a hole — it cannot outlive the
 * transaction, so nothing after it inherits cross-tenant reach.
 */
/** The truth, from the database, every time. Boot and `POST /setup` use this:
 *  boot runs once per process, the claim is rare, and both need the answer
 *  for the database they are actually connected to — see `isClaimedFast` for
 *  what happened when this one remembered. */
export async function isClaimed(sql: postgres.Sql): Promise<boolean> {
  const rows = (await sql.begin(async (tx) => {
    await tx`SET LOCAL app.maintenance = 'on'`;
    return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM orgs`;
  })) as unknown as { n: number }[];
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Remembered once TRUE, for the life of the process, and never remembered
 * false — for `GET /api/v1/setup` ALONE. The decision makes claimed-ness monotonic:
 * the window closes permanently at the first claim, so a database that has
 * once said "claimed" will never say otherwise, and asking it again is a
 * transaction plus a count across the Atlantic for an answer that cannot
 * change. Measured: 1.08 s per call against Neon before, ~1 ms after, and the
 * signed-out dashboard load used to wait on it.
 *
 * WHY THIS IS NOT `isClaimed` ITSELF. For half a day it was, and the
 * bootstrap suite went six red: those tests claim an instance, then drop
 * and recreate the schema and expect boot to find it unclaimed — and a
 * process-wide memo said "claimed" to a database that no longer was. A
 * running server never sees that; a test process does, and so would any
 * operator pointing one process at a second database. So the memo lives on
 * the one hot, read-only route where a stale true is harmless, and every
 * caller that can act on the answer asks for real.
 *
 * FALSE is never cached: false is the state that changes.
 */
let claimedOnce = false;

export async function isClaimedFast(sql: postgres.Sql): Promise<boolean> {
  if (claimedOnce) return true;
  const claimed = await isClaimed(sql);
  if (claimed) claimedOnce = true;
  return claimed;
}

export function unclaimedBanner(base: string): string {
  const lines = [
    "Snagset is running and has no owner yet.",
    "",
    `Open  ${base}/  and create the first owner.`,
    "",
    "The FIRST person to do that becomes the owner, so do it",
    "before you share the address.",
  ];
  const w = Math.max(...lines.map((l) => l.length)) + 2;
  const pad = (l: string): string => `│ ${l.padEnd(w)} │`;
  return ["┌" + "─".repeat(w + 2) + "┐", ...lines.map(pad), "└" + "─".repeat(w + 2) + "┘"].join("\n");
}

/**
 * `SNAGSET_SECRET_KEY`, or one generated to `<data>/secret.key` at mode 0600.
 *
 * *"Bin only: absent ⇒ generated on first boot and written to
 * `<data>/secret.key`, mode 0600, with a WARN telling the operator to back it
 * up."* — and on serverless it is a required variable instead, because the
 * filesystem is ephemeral and a key regenerated on every cold start means
 * every session dies and every stored integration credential becomes
 * unreadable ciphertext.
 */
export function resolveSecretKey(
  cfg: Config,
  dataDir: string | null,
  log: (level: "warn" | "info", msg: string) => void,
): string {
  const file = cfg.get("SNAGSET_SECRET_KEY_FILE");
  // Where both are set, `_FILE` wins and a WARN is logged. A PEM or
  // a key in an environment variable ends up in platform config dashboards, in
  // crash dumps and in the process table.
  if (file) {
    if (cfg.get("SNAGSET_SECRET_KEY")) {
      log("warn", "both SNAGSET_SECRET_KEY and SNAGSET_SECRET_KEY_FILE are set — the _FILE form wins");
    }
    return readFileSync(file, "utf8").trim();
  }
  const inline = cfg.get("SNAGSET_SECRET_KEY");
  if (inline) return inline;

  if (!dataDir) {
    throw new Error(
      "SNAGSET_SECRET_KEY is required on serverless: the filesystem is ephemeral, so a key " +
        "generated at boot would be a different key on every cold start — every reviewer " +
        "session dead and every stored integration credential unreadable.",
    );
  }

  const path = join(dataDir, "secret.key");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();

  const key = randomBytes(32).toString("base64url");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, key + "\n", { mode: 0o600 });
  log(
    "warn",
    `generated a new signing key at ${path} (mode 0600). BACK THIS UP and treat it as a password: ` +
      `without it, integration credentials and identity secrets are unrecoverable ciphertext and ` +
      `every outstanding reviewer session is dead.`,
  );
  return key;
}

export interface BootOptions {
  /** False on serverless: no filesystem, and migrations ran at deploy. */
  readonly writable?: boolean;
  readonly log?: (level: "info" | "warn" | "error", msg: string) => void;
  /** Injected so a test can assert the banner without owning the clock. */
  readonly now?: () => Date;
}

export async function boot(sql: postgres.Sql, cfg: Config, opts: BootOptions = {}): Promise<BootResult> {
  const writable = opts.writable ?? true;
  const log = opts.log ?? ((level, msg) => console[level === "error" ? "error" : "log"](`${level}: ${msg}`));
  const now = opts.now ?? (() => new Date());
  const dataDir = writable ? cfg.required("SNAGSET_DATA_DIR") : null;

  // Reported before anything else that could be mistaken for a green light.
  // On Neon the policies are correct and the role bypasses them, and an
  // operator learning that during an incident is the outcome this prevents.
  const rls = await rlsStatus(sql);
  if (rls.warning) log("warn", rls.warning);

  resolveSecretKey(cfg, dataDir, log);

  /**
   * The mail transport, said out loud at boot.
   *
   * "Off and say so, rather than silently queueing" is a promise about the
   * OPERATOR's knowledge, and a promise nobody is told about is not kept. One
   * line is the whole of it: which transport is live, or why none is. `info`
   * rather than `warn` for the absent case — running without email is a
   * supported configuration, not a fault.
   *
   * There is no "both are set" warning any more, because with one variable
   * selected by its scheme there is no second transport to conflict with. That
   * whole class of misconfiguration was designed out rather than reported.
   */
  const mail = selectMailer(cfg);
  log(
    "info",
    mail.kind === "none"
      ? "mail: nothing in the environment — a transport connected on Studio › General is used if there is one (D89)"
      : `mail: ${mail.kind} transport, from ${mail.from} (from the environment)`,
  );

  /**
   * The bucket, and — when it comes from the environment — a real PROBE.
   *
   * This is the half of worth keeping. Its point was never that a
   * dashboard is a nicer place to type than a `.env`; it was that credentials
   * which are merely well-formed are the ones that fail on the first
   * screenshot, in front of a reviewer, an hour later. The runtime connect
   * path has always probed before saving. The decision made the environment the primary
   * path, so the probe has to run here too or the guarantee quietly became "we
   * check the ones typed in the UI".
   *
   * A failed probe is a WARNING and not a boot failure: the instance still
   * serves comments, which is a complete product (annotation mode, A9b), and
   * refusing to start over a misconfigured bucket would take the whole review
   * down for a feature that degrades cleanly. It is loud, and it names the
   * step that failed.
   */
  const envBucket = envBucketConfig(process.env);
  if (envBucket) {
    const probe = await createBucket(envBucket.config, envBucket.creds).probe();
    if (probe.ok) {
      log("info", `storage: ${envBucket.config.bucket} at ${envBucket.config.endpoint} (from the environment)`);
    } else {
      log(
        "warn",
        `storage: the bucket configured in SNAGSET_STORAGE_S3_* failed its ${probe.step} probe — ` +
          `${probe.detail} Screenshots and uploads are OFF until this is fixed; comments still work.`,
      );
    }
  }

  // Step 2. The whole state machine turns on this one question.
  if (await isClaimed(sql)) {
    return { state: "READY", claimUrl: null, rls, dataDir };
  }

  // Step 3 — the non-interactive claim, from the environment.
  //
  // This is the branch that lets a developer bring an instance up with no
  // browser in the loop at all: set four variables, deploy, and the thing is
  // claimed, has a project and knows which origins may talk to it. It was
  // registered .6 and left unbuilt through the walking skeleton
  // because a claim URL was enough for one person on one laptop. It stops
  // being enough the moment the target is a platform, which is where
  // puts v1: there is no shell to run a command in and nobody watching the
  // logs for a URL to click.
  const bootstrapped = await bootstrapFromEnv(sql, cfg, log);
  if (bootstrapped) return { state: "READY", claimUrl: null, rls, dataDir };

  // Step 4 — mint, store the HASH only, print. Reached only when step 3 had
  // nothing to act on, which is the interactive install.
  //
  // An unexpired unclaimed token is REUSED rather than replaced — step 7 says a
  // new one is minted when the old has expired, and a boot loop that minted a
  // fresh token every restart would invalidate the URL the operator is at that
  // moment copying out of the logs.
  const live = await sql<{ id: string }[]>`
    SELECT id FROM setup_tokens
    WHERE consumed_at IS NULL AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `;
  if (live.length) {
    log(
      "info",
      "an unclaimed setup token is still valid — not minting another. " +
        "Run `npx snagset bootstrap` to mint a fresh one.",
    );
    return { state: "CLAIMABLE", claimUrl: null, rls, dataDir };
  }

  /**
   * NOTHING IS MINTED HERE.
   *
   * This used to mint a token, store its hash with a 24-hour expiry, print a
   * boxed claim URL, and write the same box to `<data>/bootstrap.txt` because
   * "logs scroll". All of it guarded a door that is now deliberately open: an
   * unclaimed instance is claimable by whoever reaches it first, so a token
   * standing beside that path protects nothing and only implies it does.
   *
   * The banner was worse than redundant. "Open this URL within 24 hours" reads
   * as a requirement, so an operator who scrolled past it went hunting for
   * `snagset bootstrap` instead of opening the page — and on a serverless
   * deploy, which never minted one at all, they went hunting for a line that
   * could not exist. That is the bug the decision was decided to end.
   *
   * `<data>/bootstrap.txt` goes with it. The only thing still written under
   * the data directory is `secret.key`, which is a real secret an operator
   * must back up, not a note about a URL.
   */
  const base = cfg.required("SNAGSET_BASE_URL").replace(/\/+$/, "");
  log("info", "\n" + unclaimedBanner(base));

  return { state: "CLAIMABLE", claimUrl: null, rls, dataDir };
}

/** Constant-time compare of a presented claim token against the stored hash. */
export function tokenHash(token: string): Buffer {
  return hash(token);
}


/**
 * Claim the instance from environment variables.
 *
 * Returns `true` when it created an org, `false` when there was nothing to do.
 * Only ever runs with **zero orgs**: the caller checks, and the design says these are
 * "ignored once an org exists", which is what makes it safe to leave the
 * variables set on a running instance forever. An IaC file that redeploys does
 * not want a second owner, and a variable that only works on the very first
 * boot is one somebody will remove and be surprised by.
 *
 * ── THE PASSWORD COMES FROM A FILE, NEVER INLINE ──
 *
 * `SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE` is a path, and the design says "file,
 * never inline" for a reason worth restating where it is enforced: an
 * environment variable is visible in `/proc`, in `docker inspect`, in a
 * platform's own dashboard and in any crash report that dumps the environment.
 * A file can be a mounted secret with its own lifetime and permissions. Every
 * platform that has a secrets story can mount one; the ones that cannot still
 * have the claim URL.
 *
 * Both the email and the password file must be present. One without the other
 * is a **boot failure** rather than a fall-through to the claim URL, because
 * an operator who set one of two variables has stated an intent that is not
 * being honoured, and silently printing a claim URL instead answers nothing.
 */
/**
 * Exported so `snagset bootstrap` can run it too — see that command for why.
 * It is idempotent by construction: every path returns false once an org
 * exists, so calling it from two places cannot claim an instance twice.
 */
export async function bootstrapFromEnv(
  sql: postgres.Sql,
  cfg: Config,
  log: (level: "info" | "warn" | "error", msg: string) => void,
): Promise<boolean> {
  const email = cfg.get("SNAGSET_BOOTSTRAP_OWNER_EMAIL");
  const passwordFile = cfg.get("SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE");
  if (!email && !passwordFile) return false;

  if (!email || !passwordFile) {
    throw new Error(
      `non-interactive bootstrap is half-configured: ${email ? "SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE" : "SNAGSET_BOOTSTRAP_OWNER_EMAIL"} is missing. ` +
        "Set both, or neither and claim the instance from the URL in the logs.",
    );
  }

  let password: string;
  try {
    password = readFileSync(passwordFile, "utf8").trim();
  } catch (e) {
    throw new Error(
      `could not read SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE at ${passwordFile}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // The same floor the interactive claim enforces. A bootstrap that quietly
  // accepted a weaker password than the form would is a back door with a
  // configuration file in front of it.
  if (password.length < 12) {
    throw new Error(
      `the password in ${passwordFile} is ${password.length} characters; 12 is the minimum. ` +
        "Note the file is read and TRIMMED, so a trailing newline is not padding.",
    );
  }

  const orgId = randomUUID();
  const userId = randomUUID();
  const projectName = cfg.get("SNAGSET_BOOTSTRAP_PROJECT_NAME") || "First project";
  const origins = (cfg.get("SNAGSET_BOOTSTRAP_PROJECT_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // Validated BEFORE the transaction, so a typo in one origin does not leave a
  // half-claimed instance — and through `validateOrigins`, which is the same
  // check the create route runs, so the two cannot disagree about what an
  // origin is. Only the error is re-wrapped: here the operator set an
  // environment variable and needs to be told WHICH one, which a shared
  // validator cannot know.
  try {
    validateOrigins(origins);
  } catch (e) {
    throw new Error(
      `SNAGSET_BOOTSTRAP_PROJECT_ORIGINS: ${e instanceof Error ? e.message : String(e)} ` +
        "Scheme is mandatory and the port is part of it: " +
        "https://staging.acme.com, http://localhost:3000, https://*.acme.com",
    );
  }

  const graceHours = cfg.int("SNAGSET_WRITE_MODE_GRACE_HOURS");
  let projectUid = "";
  await sql.begin(async (tx) => {
    // Set FIRST and to the org about to be created: the policies apply to
    // INSERT through their WITH CHECK, so on a correctly-secured deployment
    // the very first insert fails without it. Identical to the claim route's
    // reasoning, and identically load-bearing.
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, ${projectName}, ${slugify(projectName)})`;
    await tx`
      INSERT INTO users (id, org_id, email, name, password_hash, email_verified)
      -- name is '' — the schema's default — not the project's. The rail shows
      -- a person's name where it has one and their email where it does not;
      -- it showed "Acme redesign" as who you are, initials "AR". A site is
      -- not a person, and bootstrap has no way to ask for one yet.
      VALUES (${userId}, ${orgId}, ${email}, '', ${hashPassword(password)}, true)
    `;
    await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    projectUid = (
      await createProject(tx, {
        orgId,
        name: projectName,
        createdBy: userId,
        origins,
        graceHours,
      })
    ).uid;
    // Any claim URL minted on an earlier boot is now a key to a door that has
    // been opened.
    await tx`DELETE FROM setup_tokens WHERE consumed_at IS NULL`;
  });

  log("info", `claimed non-interactively from the environment — owner ${email}, project ${projectUid}`);
  if (origins.length) log("info", `origins allowed: ${origins.join(", ")}`);
  else
    log(
      "warn",
      "no SNAGSET_BOOTSTRAP_PROJECT_ORIGINS set, so no site may talk to this instance yet. " +
        "Add them there, or with `snagset allow-origin ${uid} <origin>`.",
    );
  return true;
}

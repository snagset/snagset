import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import { connect } from "../src/db/connect.ts";
import { migrate } from "../src/db/migrate.ts";
import { boot } from "../src/boot.ts";
import { loadConfig } from "../src/config.ts";
import { verifyPassword } from "../src/routes/owner.ts";

/**
 * Non-interactive bootstrap from the environment.
 *
 * The branch that lets a developer bring an instance up with no browser in the
 * loop: set four variables, deploy, done. Registered in the spec since draft 4
 * and left unbuilt through the walking skeleton, because a claim URL is enough
 * for one person on one laptop and stops being enough the moment the target is
 * a platform with no shell and nobody watching the logs.
 *
 * Needs a database: every claim below is about rows that must exist together
 * or the instance is claimed and unusable — an org with no round cannot accept
 * its first comment, and that is exactly the bug the interactive path shipped
 * with once already.
 */

const URL_ = process.env.SNAGSET_TEST_DATABASE_URL;
const skip = URL_ ? false : "set SNAGSET_TEST_DATABASE_URL to run the bootstrap tests";

let sql: postgres.Sql;
let dir: string;

const PASSWORD = "correct horse battery staple";

const cfgWith = (extra: Record<string, string>) =>
  loadConfig({
    DATABASE_URL: URL_ ?? "postgres://unused",
    SNAGSET_BASE_URL: "http://localhost:8080",
    SNAGSET_DATA_DIR: dir,
    ...extra,
  });

const fresh = async (): Promise<void> => {
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql, () => {});
};

before(async () => {
  if (skip) return;
  if (process.env.DATABASE_URL && URL_ === process.env.DATABASE_URL) {
    throw new Error("SNAGSET_TEST_DATABASE_URL is the same as DATABASE_URL — this suite drops the schema.");
  }
  sql = connect(URL_!, { max: 3 });
  dir = mkdtempSync(join(tmpdir(), "snagset-bootstrap-"));
  writeFileSync(join(dir, "pw.txt"), PASSWORD + "\n", { mode: 0o600 });
});

after(async () => {
  if (!skip) await sql.end();
});

const bootWith = (extra: Record<string, string>) =>
  boot(sql, cfgWith(extra), { log: () => {}, writable: true });

test("four variables claim the instance, with no claim URL", { skip }, async () => {
  await fresh();
  const result = await bootWith({
    SNAGSET_BOOTSTRAP_OWNER_EMAIL: "dev@studio.test",
    SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE: join(dir, "pw.txt"),
    SNAGSET_BOOTSTRAP_PROJECT_NAME: "Kilnwork",
    SNAGSET_BOOTSTRAP_PROJECT_ORIGINS: "https://staging.kilnwork.test, http://localhost:3000",
  });

  assert.equal(result.state, "READY");
  assert.equal(result.claimUrl, null, "nothing to click — that is the point");

  const [row] = await sql<
    { orgs: number; users: number; projects: number; envs: number; rounds: number; origins: number; tokens: number }[]
  >`
    SELECT (SELECT count(*)::int FROM orgs) AS orgs,
           (SELECT count(*)::int FROM users) AS users,
           (SELECT count(*)::int FROM projects) AS projects,
           (SELECT count(*)::int FROM environments) AS envs,
           (SELECT count(*)::int FROM rounds) AS rounds,
           (SELECT count(*)::int FROM project_origins) AS origins,
           (SELECT count(*)::int FROM setup_tokens WHERE consumed_at IS NULL) AS tokens`;
  assert.equal(row!.orgs, 1);
  assert.equal(row!.users, 1);
  assert.equal(row!.projects, 1);
  assert.equal(row!.envs, 2, "production and preview");
  // The bug the interactive claim shipped with once: The decision makes threads.round_id
  // NOT NULL, so an instance claimed without a round cannot take its first
  // comment. This assertion is the difference between a claim that works and
  // one that appears to.
  assert.equal(row!.rounds, 1, "Round 1 exists, or the first comment fails");
  assert.equal(row!.origins, 2, "and the allow-list is seeded, whitespace trimmed");
  assert.equal(row!.tokens, 0, "no unconsumed claim token is left behind");
});

test("the owner can actually sign in with the password from the file", { skip }, async () => {
  // Written and never verified is the failure this catches: a hash produced by
  // a different function than the login path uses would pass every row-count
  // assertion above and lock the operator out.
  const [user] = await sql<{ password_hash: string; email: string }[]>`
    SELECT password_hash, email FROM users LIMIT 1`;
  assert.equal(user!.email, "dev@studio.test");
  assert.equal(await verifyPassword(PASSWORD, user!.password_hash), true);
  // …and the trailing newline in the file is not part of it.
  assert.equal(await verifyPassword(PASSWORD + "\n", user!.password_hash), false);
});

test("a project uid is minted in the wire form the widget expects", { skip }, async () => {
  const [p] = await sql<{ uid: string }[]>`SELECT uid FROM projects LIMIT 1`;
  // 12 LOWERCASE Crockford characters after the prefix. Lowercase because the
  // uid ends up in a script tag on somebody's site, and the database CHECK
  // spells the same alphabet — this test asserted the uppercase form first and
  // was wrong, which is the right way round for a test to be wrong.
  assert.match(p!.uid, /^prj_[0-9abcdefghjkmnpqrstvwxyz]{12}$/);
});

test("it is IGNORED once an org exists — a redeploy makes no second owner", { skip }, async () => {
  // "Ignored once an org exists." That is what makes it safe to leave
  // the variables set forever, which is how an IaC file is actually written.
  const before_ = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
  const result = await bootWith({
    SNAGSET_BOOTSTRAP_OWNER_EMAIL: "someone-else@studio.test",
    SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE: join(dir, "pw.txt"),
  });
  assert.equal(result.state, "READY");
  const after_ = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
  assert.equal(after_[0]!.n, before_[0]!.n, "no second owner");
});

test("half-configured is a BOOT FAILURE, not a quiet fall back to the claim URL", { skip }, async () => {
  await fresh();
  await assert.rejects(
    () => bootWith({ SNAGSET_BOOTSTRAP_OWNER_EMAIL: "dev@studio.test" }),
    (e: Error) => {
      assert.match(e.message, /SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE/);
      return true;
    },
  );
  await assert.rejects(
    () => bootWith({ SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE: join(dir, "pw.txt") }),
    /SNAGSET_BOOTSTRAP_OWNER_EMAIL/,
  );
});

test("an unreadable password file names the path", { skip }, async () => {
  await fresh();
  await assert.rejects(
    () =>
      bootWith({
        SNAGSET_BOOTSTRAP_OWNER_EMAIL: "dev@studio.test",
        SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE: join(dir, "does-not-exist.txt"),
      }),
    /does-not-exist\.txt/,
  );
});

test("a short password is refused, and the message explains the trim", { skip }, async () => {
  await fresh();
  writeFileSync(join(dir, "weak.txt"), "short\n");
  await assert.rejects(
    () =>
      bootWith({
        SNAGSET_BOOTSTRAP_OWNER_EMAIL: "dev@studio.test",
        SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE: join(dir, "weak.txt"),
      }),
    (e: Error) => {
      // The floor matters: a bootstrap that accepted a weaker password than the
      // form does is a back door with a config file in front of it.
      assert.match(e.message, /12/);
      assert.match(e.message, /TRIMMED/i, "or the operator counts the newline as a character");
      return true;
    },
  );
});

test("a malformed origin is caught BEFORE anything is written", { skip }, async () => {
  await fresh();
  await assert.rejects(
    () =>
      bootWith({
        SNAGSET_BOOTSTRAP_OWNER_EMAIL: "dev@studio.test",
        SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE: join(dir, "pw.txt"),
        SNAGSET_BOOTSTRAP_PROJECT_ORIGINS: "https://ok.test, staging.acme.com",
      }),
    (e: Error) => {
      assert.match(e.message, /staging\.acme\.com/, "the offending one is named, not 'an origin'");
      return true;
    },
  );
  // …and the instance is still unclaimed, rather than half-built.
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM orgs`;
  assert.equal(row!.n, 0, "validation runs before the transaction");
});

test("an origin with a path is refused — an origin is scheme, host, port", { skip }, async () => {
  await fresh();
  await assert.rejects(
    () =>
      bootWith({
        SNAGSET_BOOTSTRAP_OWNER_EMAIL: "dev@studio.test",
        SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE: join(dir, "pw.txt"),
        SNAGSET_BOOTSTRAP_PROJECT_ORIGINS: "https://acme.test/app",
      }),
    /has a path/,
  );
});

test("a wildcard origin is accepted and marked as one", { skip }, async () => {
  await fresh();
  await bootWith({
    SNAGSET_BOOTSTRAP_OWNER_EMAIL: "dev@studio.test",
    SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE: join(dir, "pw.txt"),
    SNAGSET_BOOTSTRAP_PROJECT_ORIGINS: "https://*.acme.test",
  });
  const [o] = await sql<{ pattern: string; is_wildcard: boolean }[]>`
    SELECT pattern, is_wildcard FROM project_origins`;
  assert.equal(o!.pattern, "https://*.acme.test");
  assert.equal(o!.is_wildcard, true, "or the origin check never matches a subdomain");
});

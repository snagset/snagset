#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { freePort, listenFailure, pinned } from "./listen.ts";
import { applyPlatformDefaults } from "./platform.ts";
import type postgres from "postgres";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errCode, explain } from "./explain.ts";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { ID_PREFIX } from "@snagset/types/names";
import { connect, type SslMode } from "./db/connect.ts";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { migrate, MigrationError } from "./db/migrate.ts";
import { boot, bootstrapFromEnv, resolveSecretKey, unclaimedBanner } from "./boot.ts";
import { REGISTRY } from "./config.generated.ts";
import { createProject } from "./projects.ts";
import { createApp } from "./app.ts";

/**
 * `npx snagset`.
 *
 * *"with `DATABASE_URL` set. The bin migrates its own schema on boot, serves
 * API + widget assets + dashboard on one port, and ticks its own jobs
 * in-process. The claim URL is printed to the logs."*
 *
 * The order below is the order the spec gives, and each step's failure has its
 * own exit code because a boot script has to tell them apart: bad config (2),
 * unreachable database (3), refused migration (4).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as {
  version: string;
  repository?: { url?: string };
};

/** The build's commit, for `GET /api/v1/meta`. AGPL-3.0 §13 needs it to point
 *  at the source that corresponds to THIS binary, so an unknown commit is
 *  reported as unknown rather than guessed. */
function describeBuild(): { commit: string; modified: boolean } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: HERE,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], {
        cwd: HERE,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length > 0;
    return { commit, modified: dirty };
  } catch {
    // Not a git checkout — an installed package. Neither is a failure.
    return { commit: "unknown", modified: false };
  }
}

/**
 * Load `.env` files before anything reads configuration.
 *
 * The server had none of this and read `process.env` only, which is correct
 * for a container and wrong for every other way people actually run it: a
 * `.env` beside the package is the near-universal convention, and an operator
 * who writes one and sees no effect concludes the variable does not work
 * rather than that the file was never read. Found exactly that way — a
 * populated `.env.local` that did nothing at all.
 *
 * `process.loadEnvFile` is Node's own (24+), so this costs no dependency in a
 * package whose pitch is `npx snagset`. Its semantics are the ones we want and
 * were checked rather than assumed: **a variable already in the real
 * environment is left alone**, so a platform's injected `DATABASE_URL` always
 * beats a stale file someone forgot to delete.
 *
 * Order is MOST-SPECIFIC FIRST, and that is the half worth stating: because
 * each pass only fills what is still missing, the first file to set a variable
 * is the one that wins. Listing `.env` before `.env.local` therefore inverts
 * the convention every other tool follows — `.env.local` is the personal
 * override and has to be read first to be an override at all. (Written the
 * wrong way round first, and caught by reading it back.)
 *
 * It also WALKS UP, which the first version did not, and that omission was
 * found the moment it mattered: in a monorepo the env file lives at the root,
 * `snagset …` gets run from inside `apps/server`, and the loader looked in the
 * package and the working directory and nowhere else — so the file the
 * operator had just written was invisible from one directory and visible from
 * another. The walk stops at the first directory holding a `.git`, so it can
 * never wander into a home directory or `/` and pick up a stranger's `.env`.
 *
 * A missing file is the normal case and is silent; an unreadable or malformed
 * one is worth a word, because that is a typo somebody is waiting on.
 */
function loadEnvFiles(): void {
  const dirs: string[] = [];
  const walkUp = (from: string): void => {
    let dir = resolve(from);
    for (let i = 0; i < 8; i++) {
      if (!dirs.includes(dir)) dirs.push(dir);
      // Inclusive: the repo root itself is searched, then the walk stops.
      if (existsSync(join(dir, ".git"))) break;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  };
  walkUp(process.cwd());
  walkUp(join(HERE, ".."));

  for (const dir of dirs) {
    for (const name of [".env.local", ".env"]) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      try {
        process.loadEnvFile(file);
      } catch (e) {
        console.error(`✗ could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

async function main(): Promise<number> {
  loadEnvFiles();

  /**
   * `env` — print the registry.
   *
   * FIRST, before `loadConfig` and before the database, and both of those
   * orderings are the point.
   *
   * Before `loadConfig`, because this is the command you reach for when the
   * config is wrong: a mistyped variable makes `loadConfig` throw, and a
   * "run `snagset env`" suggestion inside that error would be a catch-22 if
   * `env` itself had to load the config first.
   *
   * Before the database, because it answers a question about this BUILD rather
   * than about an install — `snagset env` should work on a laptop with nothing
   * provisioned, which is exactly when somebody is deciding what to provision.
   *
   * The pointer this replaces was. True, and
   * useless to the operator it was written for: the npm tarball has no
   * directory, so the error's one next step was a file they could not open.
   */
  if (process.argv[2] === "env") {
    const filter = (process.argv[3] ?? "").toUpperCase();
    let section = "";
    for (const row of REGISTRY) {
      if (filter && !row.name.includes(filter)) continue;
      if (row.section !== section) {
        section = row.section;
        console.log(`\n── ${section} ${"─".repeat(Math.max(0, 60 - section.length))}`);
      }
      const set = process.env[row.name] !== undefined && process.env[row.name] !== "";
      // A value is never printed — `secret: true` is in the registry precisely
      // so a support paste of this output does not carry an API key.
      const state = set
        ? row.secret
          // A URL hides its CREDENTIAL, not itself. `set (hidden)` on the one
          // required variable turns the diagnostic command into a coin flip —
          // the operator still cannot tell whether they pasted the pooled
          // string or the direct one, or which database it points at. So the
          // password goes and everything you would actually check stays.
          ? redactUrlish(process.env[row.name]!)
          : `set — ${process.env[row.name]}`
        : row.default !== null
          ? `default ${row.default}`
          : row.required
            ? "REQUIRED, not set"
            : "unset";
      console.log(`  ${row.name.padEnd(44)} ${state}`);
    }
    console.log("\nOnly DATABASE_URL is required. Everything else has a working default.");
    return 0;
  }

  // The platform's PORT and public address, before the validator sees
  // the environment — so "honoured" means honoured everywhere, links included.
  const platform = applyPlatformDefaults(process.env);
  let cfg = loadConfig(process.env);
  const command = process.argv[2] ?? "serve";
  if (command === "serve" && platform.baseUrl) console.log(`info: address ${platform.baseUrl.value} from ${platform.baseUrl.from}`);
  if (command === "serve" && platform.port) console.log(`info: port ${platform.port} from PORT`);
  if (platform.database) console.log(`info: DATABASE_URL from ${platform.database}`);
  if (
    ![
      "serve", "bootstrap", "migrate", "allow-origin", "origins", "projects",
      "storage", "passwd", "link", "mcp-token", "env",
    ].includes(command)
  ) {
    console.error(
      `✗ unknown command "${command}" — try: serve | bootstrap | migrate | env | projects | origins | allow-origin | storage | passwd | link | mcp-token`,
    );
    return 2;
  }
  /**
   * Nothing pinned a port or an address, so a taken 8080 means "use
   * 8081" rather than a refusal — and the address moves with it, BEFORE the
   * config is read by anything that builds a link from it. Pinned by either
   * variable, the port is the operator's and a collision stays a sentence.
   */
  if (command === "serve" && !pinned(process.env)) {
    const want = cfg.int("SNAGSET_PORT");
    const bind = cfg.get("SNAGSET_BIND_ADDRESS") || "0.0.0.0";
    const got = await freePort(want, bind);
    if (got !== null && got !== want) {
      console.warn(`warn: port ${want} is in use — using ${got} instead. Set SNAGSET_PORT to make a port yours.`);
      process.env.SNAGSET_PORT = String(got);
      process.env.SNAGSET_BASE_URL = `http://localhost:${got}`;
      cfg = loadConfig(process.env);
    }
  }
  const sql = connect(cfg.required("DATABASE_URL"), { max: cfg.int("SNAGSET_DATABASE_POOL_MAX"), ssl: cfg.get("SNAGSET_DATABASE_SSL") as SslMode });

  // Migrations first, under the advisory lock. Nothing else can
  // be trusted before the schema is the one this build expects.
  await migrate(sql);
  if (command === "migrate") {
    await sql.end({ timeout: 5 });
    return 0;
  }

  /**
   * `passwd` — set an owner's dashboard password from the machine that owns
   * the database.
   *
   * There is no password-reset email on a fresh `npx snagset`: SMTP is
   * unconfigured (makes `DATABASE_URL` the only required config), so
   * "forgot password" has no channel to arrive on. What the operator DOES have
   * is a shell on the box and the connection string — which is strictly more
   * authority than any reset link would grant — so that is the recovery path,
   * and it is the same shape as `storage connect`: the secret comes in on
   * stdin, because argv is visible in `ps` and lands in shell history.
   *
   *     printf '%s' "$NEW" | snagset passwd owner@example.com -
   *
   * Every existing session for that user is revoked, which is what a password
   * change has to mean: if the reason for changing it is that somebody else
   * had it, leaving their cookie working changes nothing.
   */
  if (command === "passwd") {
    const { hashPassword } = await import("./routes/owner.ts");
    const email = (process.argv[3] ?? "").trim().toLowerCase();
    const arg = process.argv[4] ?? "-";
    if (!email) {
      console.error("✗ usage: snagset passwd <email> [password|-]");
      console.error("  `-` (the default) reads it from stdin, keeping it out of ps and shell history:");
      console.error("    printf '%s' \"$NEW_PASSWORD\" | snagset passwd owner@example.com");
      await sql.end({ timeout: 5 });
      return 2;
    }
    const password =
      arg === "-"
        ? await new Promise<string>((resolve) => {
            let buf = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", (d) => (buf += d));
            process.stdin.on("end", () => resolve(buf.trim()));
          })
        : arg;
    // Minimum 12, no composition rules. A rule that demands a symbol
    // buys nothing a longer passphrase does not buy more of.
    if (password.length < 12) {
      console.error(`✗ that password is ${password.length} characters; the minimum is 12.`);
      console.error("  No composition rules — length is what matters. A short phrase of real words is fine.");
      await sql.end({ timeout: 5 });
      return 2;
    }
    const rows = await sql<{ id: string }[]>`
      UPDATE users SET password_hash = ${hashPassword(password)}, updated_at = now()
      WHERE email = ${email} AND deleted_at IS NULL
      RETURNING id
    `;
    if (!rows.length) {
      // Named plainly. This is a local admin command run by somebody holding
      // the database credentials; the enumeration reticence the login route
      // owes an anonymous caller would only be a puzzle here.
      console.error(`✗ no account with the email ${email}.`);
      const known = await sql<{ email: string }[]>`
        SELECT email FROM users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 10
      `;
      if (known.length) console.error(`  this instance has: ${known.map((u) => u.email).join(", ")}`);
      await sql.end({ timeout: 5 });
      return 1;
    }
    const out = await sql<{ id: string }[]>`
      UPDATE user_sessions SET revoked_at = now()
      WHERE user_id = ${rows[0]!.id} AND revoked_at IS NULL
      RETURNING id
    `;
    console.log(`✓ password set for ${email}`);
    console.log(`  ${out.length} existing session(s) signed out — a password change that leaves the old`);
    console.log("  cookie working is not a password change.");
    await sql.end({ timeout: 5 });
    return 0;
  }

  /**
   * `storage` — connect, inspect or disconnect the bucket.
   *
   * The admin storage SCREEN is (a) and lives in a dashboard that does
   * not exist yet. Sweep R4 had already deleted every `SNAGSET_STORAGE_S3_*`
   * variable on the grounds that "the bucket is connected in the admin UI",
   * so between those two facts there was no way to connect a bucket on any
   * deployment at all — the pixel tier was unreachable rather than un-built.
   * This is that gap closed with the interface a self-host already has.
   */
  /**
   * `mcp-token` — mint, list and revoke the credential an agent presents
   *
   * A CLI command and not a dashboard screen, for now, because the audience is
   * a developer wiring an MCP client on their own machine and the token has to
   * reach a config file on that machine anyway. The dashboard screen is the
   * v1.x version of the same thing.
   *
   * The token is printed ONCE. Only its hash is stored, so a lost one is
   * revoked and replaced rather than re-displayed — the same rule as the claim
   * URL, for the same reason.
   */
  if (command === "mcp-token") {
    const { mintMcpToken, DEFAULT_SCOPES, MCP_SCOPES } = await import("./routes/mcpToken.ts");
    const sub = process.argv[3] ?? "list";

    if (sub === "list") {
      const rows = await sql<
        { name: string; prefix: string; scopes: string[]; last_used_at: Date | null; revoked_at: Date | null }[]
      >`SELECT name, prefix, scopes, last_used_at, revoked_at FROM mcp_tokens ORDER BY created_at`;
      if (!rows.length) {
        console.log("no MCP tokens. Create one with:");
        console.log("  snagset mcp-token create <name> [scope,scope]");
        console.log(`  scopes: ${MCP_SCOPES.join(", ")}`);
        console.log(`  default: ${DEFAULT_SCOPES.join(", ")}`);
      }
      for (const r of rows) {
        const state = r.revoked_at ? "REVOKED" : r.last_used_at ? `last used ${r.last_used_at.toISOString().slice(0, 10)}` : "never used";
        console.log(`${r.prefix}…  ${r.name}  [${r.scopes.join(" ")}]  ${state}`);
      }
      await sql.end({ timeout: 5 });
      return 0;
    }

    if (sub === "create") {
      const name = process.argv[4];
      if (!name) {
        console.error("✗ usage: snagset mcp-token create <name> [scope,scope]");
        console.error(`  scopes: ${MCP_SCOPES.join(", ")}`);
        await sql.end({ timeout: 5 });
        return 2;
      }
      const scopes = (process.argv[5] ?? DEFAULT_SCOPES.join(",")).split(",").map((x) => x.trim()).filter(Boolean);
      const [org] = await sql<{ id: string }[]>`SELECT id FROM orgs WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`;
      if (!org) {
        console.error("✗ this instance is not claimed yet — there is no org to scope a token to.");
        await sql.end({ timeout: 5 });
        return 2;
      }
      let minted;
      try {
        minted = await mintMcpToken(sql, randomUUID(), {
          orgId: org.id,
          name,
          scopes: scopes as never,
        });
      } catch (e) {
        console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
        await sql.end({ timeout: 5 });
        return 2;
      }
      console.log(`\n  ${minted.token}\n`);
      console.log("  Shown once — only its hash is stored. Put it in your MCP client:");
      console.log(`  { "mcpServers": { "snagset": { "command": "npx", "args": ["-y", "@snagset/mcp"],`);
      console.log(`      "env": { "SNAGSET_MCP_TOKEN": "…", "SNAGSET_MCP_HOST": "${cfg.get("SNAGSET_BASE_URL") ?? "https://review.example.com"}" } } } }`);
      console.log(`\n  scopes: ${scopes.join(", ")}`);
      await sql.end({ timeout: 5 });
      return 0;
    }

    if (sub === "revoke") {
      const prefix = process.argv[4];
      if (!prefix) {
        console.error("✗ usage: snagset mcp-token revoke <prefix>");
        await sql.end({ timeout: 5 });
        return 2;
      }
      const rows = await sql`UPDATE mcp_tokens SET revoked_at = now() WHERE prefix = ${prefix} AND revoked_at IS NULL RETURNING name`;
      console.log(rows.count ? `revoked ${rows.count} token(s) with prefix ${prefix}` : `no live token with prefix ${prefix}`);
      await sql.end({ timeout: 5 });
      return 0;
    }

    console.error(`✗ unknown subcommand "${sub}" — try: list | create | revoke`);
    await sql.end({ timeout: 5 });
    return 2;
  }

  if (command === "storage") {
    const { storageStatus, connectBucket, disconnectBucket, getBucket } = await import("./storage/settings.ts");
    const { createKeyring } = await import("./keys.ts");
    const { resolveSecretKey } = await import("./boot.ts");
    const keys = createKeyring(
      resolveSecretKey(cfg, cfg.required("SNAGSET_DATA_DIR"), () => {}),
      cfg.get("SNAGSET_SECRET_KEY_PREVIOUS"),
    );
    const sub = process.argv[3] ?? "status";

    if (sub === "status") {
      const st = await storageStatus(sql, keys);
      if (!st.connected) {
        console.log("storage: NOT connected — annotation mode.");
        console.log("  Comments, anchors and page context all work; screenshots are hidden");
        console.log("  rather than offered and failing (A9b).");
        if (st.unreadable) {
          console.log("\n  ⚠ A bucket IS configured but its credentials will not decrypt.");
          console.log("    Almost always a changed SNAGSET_SECRET_KEY. Reconnect it.");
        }
        console.log("\n  Connect one with:");
        console.log("    snagset storage connect <endpoint> <bucket> <access-key> <secret-key> [region]");
      } else {
        console.log(`storage: connected to ${st.config.bucket} at ${st.config.endpoint}`);
        // The SOURCE, because "I set the variable and it still uses the old
        // bucket" is unanswerable without it. `since` only exists for a
        // stored connection; an environment one has no connect moment, and
        // printing "since undefined" was the first version of this line.
        console.log(
          st.source === "env"
            ? `  region ${st.config.region ?? "auto"} · from SNAGSET_STORAGE_S3_* in the environment`
            : `  region ${st.config.region ?? "auto"} · connected ${st.connectedAt?.toISOString().slice(0, 10)}`,
        );

        // `status` PROBES, because this is the command somebody runs when
        // screenshots are not appearing, and a "connected" that only means
        // "configured" is the answer that wastes their afternoon.
        const live = await getBucket(sql, keys);
        const probe = live ? await live.probe() : null;
        if (probe && !probe.ok) {
          console.log(`\n  ⚠ the ${probe.step} probe FAILED: ${probe.detail}`);
          console.log("    Screenshots and uploads will not work until this is fixed.");
        } else if (probe) {
          console.log("  probe ok (write → read → delete).");
          console.log("  screenshots and uploads are advertised to the widget.");
        }
      }
      await sql.end({ timeout: 5 });
      return 0;
    }

    if (sub === "disconnect") {
      const { envBucketConfig } = await import("./storage/settings.ts");
      const stillEnv = envBucketConfig(process.env);
      await disconnectBucket(sql);
      // "Back to annotation mode" is TRUE only when nothing else supplies a
      // bucket. Now the environment can, and it wins — so an operator
      // migrating their credentials out of the database (which is exactly what
      // this command is now most used for) was being told the opposite of what
      // had happened.
      if (stillEnv) {
        console.log("storage: the STORED credentials are cleared.");
        console.log(`  SNAGSET_STORAGE_S3_* still serves ${stillEnv.config.bucket} — the instance`);
        console.log("  is unchanged for reviewers, and there is now one source of truth.");
      } else {
        console.log("storage: disconnected — back to annotation mode.");
      }
      console.log("  Attachment rows keep their storage keys, so reconnecting the SAME");
      console.log("  bucket restores the pictures rather than orphaning them (LOCK L2).");
      await sql.end({ timeout: 5 });
      return 0;
    }

    if (sub === "connect") {
      const [endpoint, bucket, accessKeyId, secretArg, region] = process.argv.slice(4);
      /**
       * `-` reads the secret from STDIN.
       *
       * An argv is visible to every process on the machine via `ps`, and it
       * lands in the shell history file besides. Neither is where a bucket
       * credential should be discoverable, so the documented form is
       *
       *     echo "$SECRET" | snagset storage connect <endpoint> <bucket> <key> - <region>
       *
       * and the argv form stays for the case where someone is scripting it
       * against a secret manager that already hands them the value.
       */
      const secretAccessKey =
        secretArg === "-"
          ? await new Promise<string>((resolve) => {
              let buf = "";
              process.stdin.setEncoding("utf8");
              process.stdin.on("data", (d) => (buf += d));
              process.stdin.on("end", () => resolve(buf.trim()));
            })
          : secretArg;
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        console.error("✗ usage: snagset storage connect <endpoint> <bucket> <access-key> <secret|-> [region]");
        console.error("  `-` reads the secret from stdin, which keeps it out of ps and shell history:");
        console.error("    echo \"$SECRET\" | snagset storage connect https://ams3.digitaloceanspaces.com snagset KEY - ams3");
        console.error("  e.g. snagset storage connect https://<acct>.r2.cloudflarestorage.com snagset KEY SECRET auto");
        await sql.end({ timeout: 5 });
        return 2;
      }
      if (!/^https?:\/\//.test(endpoint)) {
        console.error("✗ the endpoint needs a scheme, e.g. https://…");
        await sql.end({ timeout: 5 });
        return 2;
      }
      console.log("probing the bucket (write → read → delete)…");
      const r = await connectBucket(
        sql,
        keys,
        { endpoint, bucket, region: region ?? "auto" },
        { accessKeyId, secretAccessKey },
      );
      if (!r.ok) {
        // Named step, because "it did not work" is three different fixes.
        console.error(`✗ the ${r.step} probe failed: ${r.detail}`);
        console.error("  Nothing was stored. Check the endpoint, the bucket name, and that");
        console.error("  the key can write, read AND delete — delete is what erasure needs.");
        await sql.end({ timeout: 5 });
        return 1;
      }
      console.log(`✓ connected. Screenshots are now advertised to the widget.`);
      await sql.end({ timeout: 5 });
      return 0;
    }

    console.error(`✗ unknown: snagset storage ${sub} — try: status | connect | disconnect`);
    await sql.end({ timeout: 5 });
    return 2;
  }

  /**
   * `projects` — what this instance holds.
   *
   * Small, and the reason it exists is not convenience: the project uid is
   * minted at claim time and is the one value every script tag, every doc and
   * every allow-list entry has to agree on. Writing it into a README makes the
   * README wrong the first time anyone re-claims, which is exactly what
   * happened once already. A command that prints the truth is cheaper than a
   * document that repeats it.
   */
  if (command === "projects") {
    /**
     * `projects add <name> [origins]` — the multi-site, from a shell.
     *
     * This command LISTED and could not add, which is the same gap the
     * dashboard had: the instance could hold exactly the one project
     * `bootstrap` made. The dashboard is the primary way now; this is for the
     * scripted case — a deploy step that provisions three client sites, or an
     * operator who is already in a terminal.
     */
    if (process.argv[3] === "add") {
      const name = process.argv[4];
      if (!name) {
        console.error("✗ usage: snagset projects add <name> [origin,origin]");
        console.error('  e.g.  snagset projects add "Acme redesign" https://staging.acme.com');
        await sql.end({ timeout: 5 });
        return 2;
      }
      const origins = (process.argv[5] ?? "").split(",").map((o) => o.trim()).filter(Boolean);
      // The org and an owner to attribute Round 1 to. A round is a studio act
      // and `rounds.created_by` references `users`, so there has to be a
      // real one — which on an unclaimed instance there is not.
      const [owner] = await sql<{ org_id: string; user_id: string }[]>`
        SELECT m.org_id, m.user_id FROM memberships m
          JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
         WHERE m.role = 'owner' ORDER BY m.org_id LIMIT 1
      `;
      if (!owner) {
        console.error("✗ this instance is not claimed yet — run `snagset bootstrap` first.");
        await sql.end({ timeout: 5 });
        return 2;
      }
      let created;
      try {
        created = await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.org_id', ${owner.org_id}, true)`;
          return createProject(tx, {
            orgId: owner.org_id,
            name,
            createdBy: owner.user_id,
            origins,
            graceHours: cfg.int("SNAGSET_WRITE_MODE_GRACE_HOURS"),
          });
        });
      } catch (e) {
        console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
        await sql.end({ timeout: 5 });
        return 2;
      }
      console.log(`\n✓ ${created.name}  ${created.uid}\n`);
      console.log("  Paste this into the site, immediately before </body>:\n");
      console.log(
        `  <script src="${cfg.get("SNAGSET_BASE_URL") ?? "http://localhost:8080"}/snag.js" ` +
          `data-snag-site="${created.uid}" defer></script>\n`,
      );
      console.log(
        "  Who sees the toolbar is a dashboard setting (Sites screen), checked\n" +
          "  by the tag on load — change it any time without re-pasting.\n",
      );
      if (origins.length) console.log(`  origins allowed: ${origins.join(", ")}`);
      else
        console.log(
          "  ⚠ no origins allowed yet, so nothing can talk to it — " +
            `run \`snagset allow-origin ${created.uid} https://your-site.com\``,
        );
      await sql.end({ timeout: 5 });
      return 0;
    }

    const rows = await sql<{ uid: string; name: string; threads: number; origins: number }[]>`
      SELECT p.uid, p.name,
             (SELECT count(*)::int FROM threads t WHERE t.project_id = p.id AND t.deleted_at IS NULL) AS threads,
             (SELECT count(*)::int FROM project_origins o WHERE o.project_id = p.id) AS origins
      FROM projects p WHERE p.deleted_at IS NULL ORDER BY p.created_at
    `;
    if (!rows.length) console.log("no projects — the instance is not claimed yet (run `snagset bootstrap`)");
    for (const r of rows) {
      console.log(`${r.uid}  ${r.name}  ·  ${r.threads} snag(s)  ·  ${r.origins} allow-listed origin(s)`);
    }
    if (rows.length) console.log("\nadd another:  snagset projects add <name> [origin,origin]");
    await sql.end({ timeout: 5 });
    return 0;
  }

  /**
   * The "human click", in a build that has no dashboard to click in.
   *
   * `origins <uid>` lists what is allow-listed and what has been SUGGESTED —
   * the origins that fetched config and were refused. `allow-origin <uid>
   * <origin>` is the approval. Nothing is ever allow-listed without one of
   * these being typed, because `Origin` is attacker-controllable and an
   * auto-allow is an attacker-controlled header granting access.
   */
  if (command === "origins" || command === "allow-origin") {
    const uid = process.argv[3];
    if (!uid) {
      console.error(`✗ usage: snagset ${command} <project-uid>${command === "allow-origin" ? " <origin>" : ""}`);
      await sql.end({ timeout: 5 });
      return 2;
    }
    const [proj] = await sql<{ id: string; org_id: string; name: string }[]>`
      SELECT id, org_id, name FROM projects WHERE uid = ${uid} AND deleted_at IS NULL
    `;
    if (!proj) {
      console.error(`✗ no project with uid ${uid}`);
      await sql.end({ timeout: 5 });
      return 1;
    }

    if (command === "allow-origin") {
      const origin = process.argv[4]?.toLowerCase().replace(/\/+$/, "");
      if (!origin || !/^https?:\/\/[a-z0-9*.\-]+(:[0-9]{1,5})?$/.test(origin)) {
        console.error("✗ an origin is scheme + host + optional port, e.g. https://kilnwork.com");
        await sql.end({ timeout: 5 });
        return 2;
      }
      await sql`
        INSERT INTO project_origins (id, org_id, project_id, pattern, is_wildcard)
        VALUES (${randomUUID()}, ${proj.org_id}, ${proj.id}, ${origin}, ${origin.includes("*")})
        ON CONFLICT (project_id, pattern) DO NOTHING
      `;
      // Approved, so it is no longer a suggestion.
      await sql`DELETE FROM origin_violations WHERE project_id = ${proj.id} AND origin = ${origin}`;
      console.log(`✓ ${origin} may now write to ${proj.name} (${uid})`);
      await sql.end({ timeout: 5 });
      return 0;
    }

    const allowed = await sql<{ pattern: string }[]>`
      SELECT pattern FROM project_origins WHERE project_id = ${proj.id} ORDER BY pattern
    `;
    const seen = await sql<{ origin: string; hits: string; write_attempted: boolean }[]>`
      SELECT origin, hits, write_attempted FROM origin_violations
      WHERE project_id = ${proj.id} ORDER BY last_seen_at DESC
    `;
    console.log(`${proj.name} (${uid})`);
    console.log(`\n  allow-listed:`);
    console.log(allowed.length ? allowed.map((r) => `    ${r.pattern}`).join("\n") : "    (none yet)");
    if (seen.length) {
      console.log(`\n  seen and NOT allow-listed — approve with \`snagset allow-origin ${uid} <origin>\`:`);
      for (const r of seen) {
        console.log(`    ${r.origin}  ${r.hits} hit(s)${r.write_attempted ? "  — tried to WRITE" : ""}`);
      }
    }
    await sql.end({ timeout: 5 });
    return 0;
  }

  /**
   * `link` — mint, list and revoke review links without the dashboard.
   *
   * T4: after T2 put owner auth on the HTTP
   * review-link routes, minting one needs a cookie + CSRF dance that has no
   * `curl` recipe and no UI yet. This is the same act, run by whoever
   * holds `DATABASE_URL` — which is already more authority than any owner
   * session grants, so no additional auth check belongs here. The SQL below
   * is copied from `routes/reviewLinks.ts` on purpose: same insert, same
   * sha256-only storage of the token, same "revoke bumps session_epoch in the
   * same transaction" shape that makes revoking mean anything.
   */
  if (command === "link") {
    const sub = process.argv[3];
    if (!["mint", "list", "revoke"].includes(sub ?? "")) {
      console.error('✗ usage: snagset link mint <project-uid> "<name>" [--days N] [--round N]');
      console.error("              snagset link list <project-uid>");
      console.error("              snagset link revoke <link-id>");
      await sql.end({ timeout: 5 });
      return 2;
    }

    const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rowId = (wire: string, prefix: string): string | null => {
      const bare = wire.startsWith(prefix) ? wire.slice(prefix.length) : wire;
      return UUID.test(bare) ? bare.toLowerCase() : null;
    };
    // The default set — same three permissions `reviewLinks.ts` grants
    // when a mint request does not specify any.
    const DEFAULT_PERMISSIONS = ["thread:create", "comment:create", "thread:resolve", "thread:delete:own"];

    if (sub === "mint") {
      const uid = process.argv[4];
      const name = (process.argv[5] ?? "").trim().slice(0, 120);
      if (!uid || !name) {
        console.error('✗ usage: snagset link mint <project-uid> "<name>" [--days N] [--round N]');
        await sql.end({ timeout: 5 });
        return 2;
      }
      const rest = process.argv.slice(6);
      let daysArg: number | null = null;
      let roundArg: number | null = null;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--days") daysArg = Number(rest[++i]);
        else if (rest[i] === "--round") roundArg = Number(rest[++i]);
      }

      const [project] = await sql<{ id: string; org_id: string }[]>`
        SELECT id, org_id FROM projects WHERE uid = ${uid} AND deleted_at IS NULL
      `;
      if (!project) {
        console.error(`✗ no project with uid ${uid}`);
        await sql.end({ timeout: 5 });
        return 1;
      }

      let roundId: string | null = null;
      if (roundArg !== null) {
        if (!Number.isInteger(roundArg)) {
          console.error("✗ --round takes a round NUMBER (1, 2, …), not an id.");
          await sql.end({ timeout: 5 });
          return 2;
        }
        const [round] = await sql<{ id: string }[]>`
          SELECT id FROM rounds WHERE project_id = ${project.id} AND number = ${roundArg} AND deleted_at IS NULL
        `;
        if (!round) {
          console.error(`✗ project ${uid} has no round ${roundArg}.`);
          await sql.end({ timeout: 5 });
          return 1;
        }
        roundId = round.id;
      }

      // Same clamp as the HTTP route: one default, one ceiling, and
      // the clamp lives on the server side rather than being trusted to the
      // caller.
      const ttlDaysDefault = cfg.int("SNAGSET_REVIEW_LINK_TTL_DAYS");
      const maxTtlDays = cfg.int("SNAGSET_REVIEW_LINK_MAX_TTL_DAYS");
      if (daysArg !== null && (!Number.isFinite(daysArg) || daysArg <= 0)) {
        console.error("✗ --days must be a positive number.");
        await sql.end({ timeout: 5 });
        return 2;
      }
      const days = Math.min(daysArg ?? ttlDaysDefault, maxTtlDays);
      const DAY = 86_400_000;
      const expiresAt = new Date(Date.now() + days * DAY);

      // 32 bytes, unpadded base64url, 43 chars. Stored only
      // as sha256, so this is the token's one and only appearance, same as
      // the HTTP mint response.
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      await sql`
        INSERT INTO review_links
          (id, org_id, project_id, round_id, token_hash, name, environments, permissions,
           allow_name_override, expires_at)
        VALUES
          (${id}, ${project.org_id}, ${project.id}, ${roundId}, ${sha256(token)}, ${name},
           ${sql.array(["*"])}, ${sql.array(DEFAULT_PERMISSIONS)}, true, ${expiresAt})
      `;

      console.log(`✓ minted "${name}" for ${uid}, expires ${expiresAt.toISOString().slice(0, 10)}`);
      console.log("\nThe token below appears once — it is stored as a sha256 and this instance");
      console.log("cannot print it again. Paste it after the site's URL:");
      console.log(`\n  #snag_k=${token}\n`);
      await sql.end({ timeout: 5 });
      return 0;
    }

    if (sub === "list") {
      const uid = process.argv[4];
      if (!uid) {
        console.error("✗ usage: snagset link list <project-uid>");
        await sql.end({ timeout: 5 });
        return 2;
      }
      const [project] = await sql<{ id: string }[]>`
        SELECT id FROM projects WHERE uid = ${uid} AND deleted_at IS NULL
      `;
      if (!project) {
        console.error(`✗ no project with uid ${uid}`);
        await sql.end({ timeout: 5 });
        return 1;
      }
      const rows = await sql<
        { id: string; name: string; created_at: Date; expires_at: Date; revoked_at: Date | null; use_count: number; last_used_at: Date | null }[]
      >`
        SELECT id, name, created_at, expires_at, revoked_at, use_count, last_used_at
        FROM review_links WHERE project_id = ${project.id} ORDER BY created_at DESC
      `;
      if (!rows.length) {
        console.log(`no review links for ${uid} yet — mint one with \`snagset link mint ${uid} "<name>"\``);
        await sql.end({ timeout: 5 });
        return 0;
      }
      // The id column prints the FULL wire id — `link revoke` takes exactly
      // this string. Truncating it for column width (an earlier version of
      // this command did) produces an id that looks copyable and is not:
      // `rowId()` requires a full uuid tail and silently rejects a shortened
      // one, so revoke failed with "usage" for an id copied straight out of
      // this table. Everything else may wrap; the id must not.
      console.log(`id                                            name                 created     expires     revoked  uses  last used`);
      for (const r of rows) {
        const id = ID_PREFIX.link + r.id;
        const created = r.created_at.toISOString().slice(0, 10);
        const expires = r.expires_at.toISOString().slice(0, 10);
        const revoked = r.revoked_at ? "yes" : "no";
        const lastUsed = r.last_used_at ? r.last_used_at.toISOString().slice(0, 10) : "never";
        console.log(
          `${id.padEnd(46)}${r.name.slice(0, 20).padEnd(21)}${created.padEnd(12)}${expires.padEnd(12)}${revoked.padEnd(9)}${String(r.use_count).padEnd(6)}${lastUsed}`,
        );
      }
      await sql.end({ timeout: 5 });
      return 0;
    }

    // sub === "revoke"
    const raw = process.argv[4];
    const id = raw ? rowId(raw, ID_PREFIX.link) : null;
    if (!id) {
      console.error(`✗ usage: snagset link revoke <link-id>`);
      await sql.end({ timeout: 5 });
      return 2;
    }
    const [link] = await sql<{ id: string; project_id: string; revoked_at: Date | null }[]>`
      SELECT id, project_id, revoked_at FROM review_links WHERE id = ${id}
    `;
    if (!link) {
      console.error(`✗ no review link with id ${raw}`);
      await sql.end({ timeout: 5 });
      return 1;
    }
    if (link.revoked_at) {
      console.log(`already revoked — nothing to do.`);
      await sql.end({ timeout: 5 });
      return 0;
    }
    // BOTH in one transaction, same as the HTTP route: `revoked_at` stops
    // further exchanges, and the `session_epoch` bump is what signs out
    // everyone who already redeemed it — without it a revoked link keeps
    // working for its existing holders.
    await sql.begin(async (tx) => {
      await tx`UPDATE review_links SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`;
      await tx`UPDATE projects SET session_epoch = session_epoch + 1 WHERE id = ${link.project_id}`;
    });
    console.log(`✓ revoked. every session minted from it is out within 10 s.`);
    console.log("  (this process cannot count how many that is — the bump is what matters, not the count.)");
    await sql.end({ timeout: 5 });
    return 0;
  }

  // Step 7's escape hatch. Before boot(), because boot() would see the
  // outstanding token this replaces and decline to mint.
  /**
   * `bootstrap` — claim the instance.
   *
   * FROM THE ENVIRONMENT FIRST, and that ordering is the whole fix. This
   * command used to go straight to minting a claim URL, so an operator who had
   * set all four `SNAGSET_BOOTSTRAP_*` variables and then ran the command
   * literally named `bootstrap` got a URL to click — the one command whose name
   * promises exactly the thing it did not do. Measured on a cold install: set
   * the variables, run `bootstrap`, and it printed a claim URL for a browser
   * that was not going to be opened.
   *
   * `bootstrapFromEnv` is idempotent (it returns false the moment an org
   * exists), so this cannot double-claim, and running it here means both the
   * scripted path and the interactive one reach the same place.
   */
  if (command === "bootstrap") {
    const claimed = await bootstrapFromEnv(sql, cfg, (level, msg) => console.log(`${level}: ${msg}`));
    if (claimed) {
      console.log("\n✓ claimed from the environment — no URL to open. Start it with `snagset serve`.");
      await sql.end({ timeout: 5 });
      return 0;
    }
    // NOTHING TO MINT. There is no claim URL to hand back, because an
    // unclaimed instance no longer needs one: open it and create the owner.
    // This command still earns its place for the branch above, which is the
    // headless path and the only one a deploy script can take.
    console.log("\n" + unclaimedBanner(cfg.required("SNAGSET_BASE_URL").replace(/\/+$/, "")));
    // Named here rather than left to the docs: an operator running `bootstrap`
    // by hand is, by definition, at a shell — which is where the scripted path
    // is available and a browser may not be.
    console.log(
      "\nPrefer no browser? Set SNAGSET_BOOTSTRAP_OWNER_EMAIL, " +
        "SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE, SNAGSET_BOOTSTRAP_PROJECT_NAME and " +
        "SNAGSET_BOOTSTRAP_PROJECT_ORIGINS, then run this again — `snagset env` lists them.",
    );
    await sql.end({ timeout: 5 });
    return 0;
  }

  const result = await boot(sql, cfg, {
    log: (level, msg) => console[level === "error" ? "error" : "log"](`${level}: ${msg}`),
  });

  const build = describeBuild();
  const app = createApp({
    sql,
    cfg,
    // Already generated or read by boot(); resolving again is a no-op that
    // returns the same key from the same file.
    secretKey: resolveSecretKey(cfg, result.dataDir, () => {}),
    state: result.state,
    version: pkg.version,
    commit: build.commit,
    sourceUrl: pkg.repository?.url ?? "https://github.com/snagset/snagset",
    modified: build.modified,
    // This process outlives every response, so a write's drain simply
    // runs on it; nothing is handed back for the response to wait on.
    afterResponse: (drain) => {
      void drain;
    },
  });

  const port = cfg.int("SNAGSET_PORT");
  const hostname = cfg.get("SNAGSET_BIND_ADDRESS") || "0.0.0.0";
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`snagset ${pkg.version} listening on http://${hostname}:${info.port} — state ${result.state}`);
  });
  // A port that is taken is the commonest way a second instance fails, and
  // without this it was Node's unhandled 'error' event and a stack trace —
  // which reads as a crash in our code. One sentence, the variable to change,
  // and an exit the job ticker below cannot keep alive.
  server.on("error", (err) => {
    const said = listenFailure(err, port, hostname);
    if (!said) throw err;
    console.error(said);
    process.exit(1);
  });

  startJobTicker(sql, cfg, result.dataDir);
  return 0;
}

/**
 * The "ticks its own jobs in-process" — the LOCAL half of the schedule.
 *
 * The engine itself is a bounded call that owns no timer (see `jobs/index.ts`);
 * this is the one place a timer exists, and it exists only because a long-lived
 * `npx snagset` has nothing else to wake it. On the serverless path L2 calls the
 * same `runDueJobs` from a cron request and none of this runs.
 *
 * HOURLY, and it used to be every minute. A write now drains the
 * mail and tracker updates it queued as soon as its response is ready
 * (`jobs/soon.ts`), so what is left here is the SWEEP: the reaper, and the
 * retries of a send that failed. A minute's tick queried the database every
 * minute for that, which against a serverless Postgres such as Neon's free
 * plan means a compute that never sleeps and runs out of its monthly hours
 * An hour lets it sleep for fifty-five minutes of every sixty; a local
 * Postgres notices no difference either way. What an hour costs: a retry on a
 * quiet instance waits for the next write or the next sweep, and the write-mode
 * downgrade's row catches up late, which nothing reads, because every reader
 * computes the downgrade itself (`effectiveWriteMode`).
 *
 * Four things it does deliberately:
 *
 *   · `unref()`, so a tick pending at shutdown does not hold the process open.
 *     Every job is idempotent and bounded, so being cut off mid-tick costs a
 *     repeat, not a corruption.
 *   · One tick at a time, guarded in-process. The advisory lock already stops
 *     two INSTANCES colliding; this stops one instance stacking ticks when a
 *     job runs longer than the interval — which the lock would handle
 *     correctly but wastefully, by opening a transaction to be told no.
 *   · The bucket is resolved PER TICK rather than captured once. An operator
 *     who runs `snagset storage connect` while the server is up should not
 *     have to restart it for uploads to start being reaped.
 *   · Failures are logged and swallowed. A reaper that cannot run is not a
 *     reason to take the API down with it.
 */
function startJobTicker(sql: postgres.Sql, cfg: Config, dataDir: string | null): void {
  const EVERY_MS = 60 * 60_000;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const { runDueJobs, summarise } = await import("./jobs/index.ts");
      const { jobSet } = await import("./jobs/set.ts");
      const { createKeyring } = await import("./keys.ts");
      const keys = createKeyring(
        resolveSecretKey(cfg, dataDir, () => {}),
        cfg.get("SNAGSET_SECRET_KEY_PREVIOUS"),
      );
      // The same list the cron route sweeps. Built per tick: the bucket
      // and the mail transport are settings an operator can change while the
      // server is up, and should not need a restart to count.
      const jobs = await jobSet({ sql, cfg, keys }).all();
      const summary = await runDueJobs(sql, jobs, {
        // Well under the interval, so a tick can never overrun into the next
        // one even when every job has work.
        budgetMs: 20_000,
        log: (m) => console.log(m),
      });
      // Silent when there was nothing to do: a line a minute saying "0" is a
      // log nobody reads, and the first thing an operator turns off.
      if (summary.ran.some((r) => r.did > 0) || summary.failed.length) {
        console.log(summarise(summary));
      }
      for (const f of summary.failed) console.error(`jobs: ${f.name} failed: ${f.error}`);
    } catch (e) {
      console.error(`jobs: tick failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };

  // First tick shortly after boot rather than immediately: a project whose
  // grace window closed while the server was down should be downgraded on
  // startup, but not while migrations and the boot report are still printing.
  setTimeout(() => void tick(), 5_000).unref();
  setInterval(() => void tick(), EVERY_MS).unref();
}


main()
  .then((code) => {
    // `serve` keeps the process alive on its own; the one-shot commands do not.
    if (code !== 0 || (process.argv[2] ?? "serve") !== "serve") process.exit(code);
  })
  .catch((e: unknown) => {
    if (e instanceof ConfigError) {
      console.error(`✗ ${e.message}`);
      console.error(`  ${e.fix}`);
      process.exit(2);
    }
    if (e instanceof MigrationError) {
      console.error(`✗ migrate: ${e.message}`);
      process.exit(e.exitCode);
    }
    console.error(explain(e));
    const msg = `${e instanceof Error ? e.message : String(e)} ${errCode(e) ?? ""}`;
    process.exit(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|password|SASL|SSL/i.test(msg) ? 3 : 1);
  });

/**
 * `set (hidden)`, unless the value is a URL — then show it with the password
 * replaced.: a secret in a `.env` reaches every backup and CI log,
 * and that is as true of `DATABASE_URL` as of an API key. But hiding the whole
 * string helps nobody diagnose "is my connection string the pooled one", which
 * is the question this command exists to answer.
 */
function redactUrlish(value: string): string {
  try {
    const u = new URL(value);
    if (!u.password) return `set — ${value}`;
    u.password = "***";
    return `set — ${u.toString()}`;
  } catch {
    return "set (hidden)";
  }
}

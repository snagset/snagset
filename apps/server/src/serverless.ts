import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { connect, type SslMode } from "./db/connect.ts";
import { loadConfig } from "./config.ts";
import { applyPlatformDefaults } from "./platform.ts";
import { createApp, type Env } from "./app.ts";
import { resolveSecretKey } from "./boot.ts";
import type { PlanResolver } from "./plan.ts";

/**
 * This package's own version, read the way the bin reads it. Until 0.1.10 the
 * serverless entry took it only from a caller or SNAGSET_VERSION, which a
 * scaffolded deploy sets neither of, so every Vercel instance reported 0.0.0 —
 * and Studio's "check for updates" compared the newest release against that.
 */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version: string }
).version;

/**
 * The serverless entry point, .3.
 *
 * The SECOND entry on the same `createApp(deps)`. The bin owns a process and
 * can boot, tick and hold a pool; a function instance owns none of that, and
 * the design names the four differences. All four are implemented here and nowhere
 * else, which is the point of there being one app factory.
 *
 *  1. **Jobs are a cron, not an interval.** `/api/jobs/run` invokes
 *     `runDueJobs`, driven by `vercel.json`'s schedule. Nothing may depend on
 *     a long-lived process — no LISTEN/NOTIFY, no resident state. Now
 *     the cron is only the sweep: a write drains what it queued through the
 *     platform's `waitUntil` (`afterResponse` below).
 *  2. **Migrations run at deploy**, as a release step. A function instance has
 *     no boot to hook, and migrating on cold start would take the advisory
 *     lock on a request's critical path — every instance queueing behind one
 *     that is applying DDL, on somebody's first page load.
 *  3. **`DATABASE_URL` must be POOLED.** The marketplace resources hand one
 *     out. Interactive transactions work in transaction-pooling mode, so L6's
 *     same-transaction outbox guarantee holds.
 *  4. **`SNAGSET_SECRET_KEY` is required**, because the generate-a-key-to-
 *     disk is bin-only: the filesystem here is ephemeral, so a generated key
 *     would differ per instance and every session and encrypted credential
 *     would decrypt on one and fail on the next. Checked below, with the
 *     reason, rather than left to fail as corrupted ciphertext.
 */

/**
 * The app, built ONCE per instance and reused across invocations.
 *
 * Module scope is the only warm thing a function has. Rebuilding per request
 * would re-read config, re-derive the keyring and open a new pool on every
 * call — which on a pooled Postgres is how an instance exhausts the very
 * connection limit the pooler exists to protect.
 */
/**
 * What a private caller hands in, the seam. The cloud's
 * own entry is one file: `createServerlessHandler({ planResolver })`, and
 * everything else — the config registry, the claim, the jobs route, the
 * failure page — is this file's, unchanged.
 */
export interface ServerlessOptions {
  /** The plan seam: the org's limits from its plan. Absent means unlimited. */
  planResolver?: PlanResolver;
  /** Where THIS build's source lives (AGPL §13). The engine's own repository unless the caller modified it. */
  sourceUrl?: string;
  version?: string;
  /**
   * The platform's way to keep work alive after the response. Found on
   * its own on Vercel; a caller on another platform passes its own.
   */
  waitUntil?: (task: Promise<unknown>) => void;
}

/**
 * Vercel's `waitUntil`, from the request context its runtime installs on
 * `globalThis` for each invocation: the same lookup `@vercel/functions`'
 * `waitUntil()` performs, read here so the engine takes no dependency for
 * three lines. Null anywhere else, and null if Vercel ever moves it, in which
 * case the response waits for the drain instead (`afterResponse` below), so a
 * change on their side costs latency, never a lost notification.
 */
export function platformWaitUntil(): ((task: Promise<unknown>) => void) | null {
  type RequestContext = { waitUntil?: (task: Promise<unknown>) => void };
  const store = (globalThis as Record<symbol, { get?: () => RequestContext | undefined } | undefined>)[
    Symbol.for("@vercel/request-context")
  ];
  // Read per request: the store answers for the invocation it is asked from.
  const context = store?.get?.();
  // Called as a METHOD on the context, as `@vercel/functions` calls it.
  return typeof context?.waitUntil === "function" ? (task) => context.waitUntil!(task) : null;
}

export interface ServerlessHandler {
  fetch(request: Request): Response | Promise<Response>;
  closeForTests(): Promise<void>;
}

export function createServerlessHandler(options: ServerlessOptions = {}): ServerlessHandler {
let cached: { app: Hono<Env>; sql: ReturnType<typeof connect> } | null = null;

function boot(): { app: Hono<Env>; sql: ReturnType<typeof connect> } {
  if (cached) return cached;

  applyPlatformDefaults(process.env); // Vercel names its own deployment
  const cfg = loadConfig(process.env);

  if (!cfg.get("SNAGSET_SECRET_KEY") && !cfg.get("SNAGSET_SECRET_KEY_FILE")) {
    throw new Error(
      "SNAGSET_SECRET_KEY is required on serverless. The filesystem here is ephemeral, so " +
        "the bin's generate-a-key-on-first-boot path cannot work: each instance would invent " +
        "a different key, and a session or an encrypted credential written by one would fail " +
        "to decrypt on the next. Generate 32 random bytes, base64url them, and set it in the " +
        "deploy's environment.",
    );
  }

  const sql = connect(cfg.required("DATABASE_URL"), { max: cfg.int("SNAGSET_DATABASE_POOL_MAX"), ssl: cfg.get("SNAGSET_DATABASE_SSL") as SslMode });

  const app = createApp({
    sql,
    cfg,
    secretKey: resolveSecretKey(cfg, null, () => {}),
    // A function instance cannot run the boot state machine — that reads and
    // writes the claim token and would race across instances. The state is
    // derived per request from the database instead, which is what `createApp`
    // does when it is told nothing.
    state: "READY",
    version: options.version ?? process.env["SNAGSET_VERSION"] ?? PACKAGE_VERSION,
    commit: process.env["VERCEL_GIT_COMMIT_SHA"] ?? "unknown",
    sourceUrl: options.sourceUrl ?? "https://github.com/snagset/snagset",
    modified: false,
    ...(options.planResolver ? { planResolver: options.planResolver } : {}),
    // A write's drain outlives its response through the platform. With
    // no way to keep work alive, the response waits for it: an instance frozen
    // the moment it answers would otherwise lose the mail it was sending.
    afterResponse: (drain) => {
      const waitUntil = options.waitUntil ?? platformWaitUntil();
      if (!waitUntil) return drain;
      waitUntil(drain);
    },
  });

  cached = { app, sql };
  return cached;
}

/**
 * The Web-standard handler every serverless target accepts.
 *
 * A `fetch(Request) => Response` rather than a Vercel-shaped adapter, because
 * that is the same signature Cloudflare Workers, Deno and Bun take — the decision makes
 * Workers the next hosting milestone on this same app factory, and an entry
 * point written to one vendor's helper is one that has to be rewritten for it.
 */
/**
 * A CONFIGURATION FAILURE SHOULD SAY SO, not crash.
 *
 * `boot()` throws when a required variable is missing, and until 2026-09-01
 * that throw reached the platform — which renders "This Serverless Function
 * has crashed. FUNCTION_INVOCATION_FAILED" and puts the real message in
 * function logs the operator may not know exist. On the deploy we bless, on
 * the very first request, for the most ordinary mistake there is.
 *
 * The bin has had `explain()` for this since it shipped: an unreachable
 * database prints "✗ no Postgres answered at host:port. Start one, or point
 * DATABASE_URL at a database that is running." Serverless had nothing, so the
 * same operator got a sentence on the bin and a shrug on Vercel.
 *
 * NAMES ONLY, never values — this response is public, and the whole point of
 * the variable being missing is that somebody is about to paste a secret into
 * a dashboard. `503` rather than `500`: the instance is not broken, it is not
 * configured, and a proxy should feel free to retry once it is.
 */
function configFailure(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  return new Response(
    `Snagset is deployed but not configured.\n\n${message}\n\n` +
      `Set it in your platform's environment settings and redeploy.\n` +
      `\`snagset env\` lists every variable this build accepts.\n`,
    { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } },
  );
}

function serve(request: Request): Response | Promise<Response> {
  let app;
  try {
    app = boot().app;
  } catch (e) {
    // Nothing is cached on this path, so the NEXT request boots again — set
    // the variable and the instance recovers without a redeploy.
    return configFailure(e);
  }
  return app.fetch(request);
}

async function closeForTests(): Promise<void> {
  const held = cached;
  cached = null;
  if (held) await held.sql.end({ timeout: 5 });
}

return { fetch: serve, closeForTests };
}

/** The blessed deploy: the engine as it is, no resolver, unlimited — every self-host's serverless entry. */
const standard = createServerlessHandler();

export default { fetch: standard.fetch };

export const handler = standard.fetch;

export const closeForTests = standard.closeForTests;

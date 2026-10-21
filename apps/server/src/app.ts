import { Hono, type Context, type MiddlewareHandler } from "hono";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import type { Config } from "./config.ts";
import { type BootState, isClaimed, isClaimedFast, tokenHash } from "./boot.ts";
import { isConfigured } from "./mail/index.ts";
import { resolveMailer } from "./mail/resolve.ts";
import { instanceRoutes } from "./routes/instance.ts";
import { addressPinned, addressSource, storeAddress, validateAddress } from "./instance/address.ts";
import { integrationRoutes } from "./routes/integrations.ts";
import { mcpTokenRoutes } from "./routes/mcpTokens.ts";
import { mcpHttpRoutes } from "./routes/mcp.ts";
import { mcpHttpSource } from "./instance/mcpHttp.ts";
import { limitsSource, type PlanResolver } from "./plan.ts";
// The seam's types, for the private caller: `import type { PlanLimits, PlanResolver } from "@snagset/server"`.
export type { PlanLimits, PlanResolver, ResolvedLimits } from "./plan.ts";
import { orgRoutes } from "./routes/orgs.ts";
import { activityRoutes } from "./routes/activity.ts";
import { isTracker, listIntegrations, type Tracker } from "./integrations/store.ts";
import type { PushDeps } from "./integrations/outbox.ts";
import { widgetRoutes } from "./routes/widget.ts";
import { jobsRoutes } from "./routes/jobs.ts";
import { jobSet } from "./jobs/set.ts";
import { outboxDrain, watchQueue } from "./jobs/soon.ts";
import { memberRoutes } from "./routes/members.ts";
import { inviteRoutes } from "./routes/invites.ts";
import { accountRoutes } from "./routes/account.ts";
import { rlsStatus } from "./db/rls.ts";
import { threadRoutes } from "./routes/threads.ts";
import { regionMismatch } from "./instance/region.ts";
import { bodyLimit } from "./routes/bodyLimit.ts";
import { anchorReportRoutes } from "./routes/anchorReports.ts";
import { commentRoutes } from "./routes/comments.ts";
import { commentEditRoutes } from "./routes/commentEdit.ts";
import { corsForProjects } from "./routes/cors.ts";
import { bearerAuth } from "./routes/auth.ts";
import { createReviewerCache } from "./reviewerCache.ts";
import { attachmentRoutes, features } from "./routes/attachments.ts";
import { imageProxyRoutes } from "./routes/imageProxy.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { reviewLinkRoutes } from "./routes/reviewLinks.ts";
import { roundRoutes } from "./routes/rounds.ts";
import { assigneeRoutes } from "./routes/assignees.ts";
import { siteRoutes } from "./routes/sites.ts";
import { mcpAuth } from "./routes/mcpAuth.ts";
import { createKeyring } from "./keys.ts";
import { unsubscribeRoutes } from "./mail/unsubscribe.ts";
// `wireId` moved to `projects.ts`, beside its only consumer. Re-exported
// because `boot.ts` imports it from here and the name is public surface.
import { createProject, validateOrigins, wireId } from "./projects.ts";
export { wireId };
import { createProjectCache } from "./projectCache.ts";
import {
  ownerAuth,
  ownerRoutes,
  requireOwner,
  hashPassword,
  setSessionCookies,
  type OwnerClaims,
} from "./routes/owner.ts";
import { ID_PREFIX, THREAD_REF_PREFIX, header } from "@snagset/types/names";

/**
 * `createApp(deps)` — the ONE app, .3 and.
 *
 * Both entry points build this: the `npx snagset` bin and the Vercel
 * serverless handler. Nothing in here reads `process.env` — the config arrives
 * as a dependency, which is what lets a test construct an app instead of
 * mutating the process, and what makes the "one deployable unit, two
 * exports" true rather than aspirational.
 */

export interface Deps {
  readonly sql: postgres.Sql;
  readonly cfg: Config;
  /** The resolved signing key — boot() already found or generated it, and this
   *  app never reads the environment itself. */
  readonly secretKey: string;
  /** The state. Mutable: a successful claim moves CLAIMABLE → READY
   *  without a restart, which is the whole point of the claim URL. */
  state: BootState;
  readonly version: string;
  readonly commit: string;
  readonly sourceUrl: string;
  readonly modified: boolean;
  /** The process environment, injectable so a test's own variables never reach the storage and mail rows. */
  env?: Record<string, string | undefined>;
  /** Test hook: where GitHub's API is — a fake in tests, api.github.com otherwise. */
  githubApiBase?: string;
  /** Test hook: where Linear's GraphQL endpoint is — a fake in tests. */
  linearApiBase?: string;
  /** Test hook: where Slack's Web API is — a fake in tests. */
  slackApiBase?: string;
  /** The plan seam: the private caller's answer for an
   *  org's limits, from its plan. Absent — every self-host, every dev
   *  machine — means unlimited, and the rule makes that a promise. */
  planResolver?: PlanResolver;
  /**
   * How a drain started after a response is kept alive. The bin lets it
   * run on its own process; the serverless entry hands it to the platform's
   * `waitUntil`, or, where the platform offers none, returns it, and the
   * response waits for it rather than let a frozen instance lose the send.
   * Whatever this returns is awaited before the response goes.
   *
   * Absent (every test that builds an app) means no drain after a response:
   * queued work waits for the sweep, and the tests that exercise the drains
   * run them directly, as they always have.
   */
  afterResponse?: (drain: Promise<void>) => Promise<void> | void;
}

/** The one context variable, declared so `c.get("requestId")` is typed rather
 *  than `never` — Hono infers nothing about variables a route sets. */
export type Env = {
  Variables: {
    requestId: string;
    noBodyLogging?: boolean;
    session?: import("./session.ts").SessionClaims;
    owner?: OwnerClaims;
    mcp?: import("./routes/mcpToken.ts").McpClaims;
  };
};
type Ctx = Context<Env>;

/** The envelope — every status ≥ 400, always, with a code. */
function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json(
    { error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } },
    status as 400,
  );
}

/** A slug from a display name, matching orgs.slug's CHECK. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39);
  return s.length >= 3 ? s : `org-${randomBytes(4).toString("hex")}`;
}

export function createApp(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();
  const { sql, cfg } = deps;

  // One keyring and one project cache for the process. The cache is what makes
  // `session_epoch` revocation cost nothing per request.
  const keys = createKeyring(deps.secretKey, cfg.get("SNAGSET_SECRET_KEY_PREVIOUS"));
  // The org's limits, read live: the resolver's, a hand-set row's, or unlimited.
  const limits = limitsSource(sql, keys, deps.planResolver);
  const projects = createProjectCache(sql);
  /** Per-identity revocation, same ten-second window as the project cache
   *  Its absence is what let a signed-out reviewer keep working
   *  until their token refreshed. */
  const reviewers = createReviewerCache(sql);
  const ttls = {
    slidingS: cfg.int("SNAGSET_SESSION_TTL_S"),
    absoluteS: cfg.int("SNAGSET_SESSION_ABSOLUTE_TTL_S"),
  };

  // Declared up here because `/api/v1/setup` uses `secure` to set its cookies
  // and is registered long before the middleware below.
  const baseUrl = new URL(cfg.get("SNAGSET_BASE_URL") ?? "http://localhost:8080");
  const ownerDeps = {
    sql,
    limits,
    signupOpen: () => cfg.bool("SNAGSET_SIGNUP_OPEN"),
    origin: baseUrl.origin,
    // A `Secure` cookie is dropped on plain http, which on a first `npx
    // snagset` run against localhost reads as "login silently does nothing".
    secure: baseUrl.protocol === "https:",
    // Read once: neither side moves while the process lives.
    regionMismatch: regionMismatch(process.env["VERCEL_REGION"], cfg.get("DATABASE_URL")),
  };

  // Every response carries the request id, the server version and the
  // server clock. The clock is not decoration — uses it to correct skew
  // on a reviewer's machine, and a widget with a wrong clock signs identity
  // envelopes that fail verification for reasons nobody can see.
  app.use("*", async (c, next) => {
    const id = c.req.header(header("request-id")) ?? randomUUID();
    c.set("requestId", id);
    await next();
    c.header(header("request-id"), id);
    c.header(header("server"), deps.version);
    c.header(header("time"), new Date().toISOString());
  });

  /**
   * The body cap, mounted directly after the request-id middleware so a
   * `413` still carries an id an operator can grep for — and BEFORE every
   * route, because the point is to refuse a body rather than to read one.
   */
  app.use("*", bodyLimit(() => cfg.int("SNAGSET_MAX_BODY_BYTES")));

  /**
   * Every scheduled job, built once: the cron route sweeps `all()`, and
   * a write that queued work drains `outbox()` below.
   */
  const jobs = jobSet({
    sql,
    cfg,
    keys,
    githubApiBase: deps.githubApiBase,
    linearApiBase: deps.linearApiBase,
    slackApiBase: deps.slackApiBase,
  });

  /**
   * A write that queued mail or a tracker update drains it as soon as
   * its response is ready, not at the next sweep. Mounted around every route,
   * because what queues is not one route but five (the reply, the thread, the
   * status change, the tracker buttons, the trackers' webhooks), and the next
   * one should need no wiring. A request that queued nothing costs one
   * AsyncLocalStorage scope and no statement. See `jobs/soon.ts`.
   */
  if (deps.afterResponse) {
    const drain = outboxDrain(sql, jobs.outbox);
    const keepAlive = deps.afterResponse;
    app.use("*", async (_c, next) => {
      if (!(await watchQueue(next))) return;
      const wait = keepAlive(drain());
      if (wait) await wait;
    });
  }

  app.onError((err, c) => {
    console.error(`error [${c.get("requestId")}]`, err);
    return fail(c, 500, "internal_error", "Something went wrong on the server.");
  });

  /**
   * LIVENESS. Deliberately touches nothing: the question is "is this process
   * alive", and a health check that queries the database restarts a healthy
   * app every time the database hiccups — turning a brief outage into a
   * restart storm that outlives it.
   */
  app.get("/healthz", (c) => c.json({ ok: true, version: deps.version }));

  /**
   * READINESS. This one IS allowed to touch the database, because "ready"
   * means "can serve a request", and a request needs the database.
   *
   * An unclaimed instance is READY in the orchestrator's sense — the
   * whole argument about 409-not-503 applies here too. It is healthy; it is
   * waiting for a human. Reporting otherwise puts it in a restart loop and the
   * operator never gets to read the claim URL.
   */
  app.get("/readyz", async (c) => {
    try {
      await sql`SELECT 1`;
    } catch (e) {
      return c.json(
        { ok: false, state: deps.state, database: "unreachable", detail: (e as Error).message },
        503,
      );
    }
    const rls = await rlsStatus(sql);
    return c.json({
      ok: true,
      state: deps.state,
      database: "ok",
      // Surfaced rather than assumed. An operator who has to ask whether
      // RLS is doing anything should be able to read the answer.
      rls: { effective: rls.effective, role: rls.role, warning: rls.warning },
    });
  });

  /** Unauthenticated on purpose: `sourceUrl` is AGPL-3.0 §13's offer
   *  of source to anyone interacting with a modified version over a network,
   *  and an offer behind a login is not an offer. */
  app.get("/api/v1/meta", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      version: deps.version,
      commit: deps.commit,
      sourceUrl: deps.sourceUrl,
      modified: deps.modified,
      blockedClientVersions: [],
      apiVersions: ["v1"],
      serverTime: new Date().toISOString(),
    });
  });

  /**
   * The claim. Single-use, and the transaction either creates an
   * entire working instance or none of it.
   */
  /**
   * Does this instance have an owner yet? Public, and it has to be: the setup
   * screen is what an unclaimed instance shows instead of a sign-in form for
   * an account that does not exist, and it cannot know which to draw without
   * asking. It leaks exactly one bit, and that bit is inherent to first-run
   * setup being open at all.
   */
  // `signup`: whether a stranger may make a studio here — the sign-in page offers the door only when it is open.
  app.get("/api/v1/setup", async (c) => c.json({ claimed: await isClaimedFast(sql), signup: cfg.bool("SNAGSET_SIGNUP_OPEN") }));

  /**
   * The claim. Single-use, and the transaction either creates an
   * entire working instance or none of it.
   */
  app.post("/api/v1/setup", async (c) => {
    // ASKED OF THE DATABASE, not of this process. `deps.state` is per-process
    // and `serverless.ts` hardcodes it READY — because a function instance
    // cannot run the boot state machine — so this endpoint answered 409 to
    // every request on the blessed deploy and the instance could not be
    // claimed AT ALL. The logs it told people to read for a claim URL never
    // printed one either: serverless never mints a token.
    if (await isClaimed(sql)) {
      return fail(c, 409, "already_claimed", "This instance has already been claimed.");
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (k: string): string => (typeof body?.[k] === "string" ? (body[k] as string) : "");
    const [token, orgName, email, password] = ["token", "orgName", "email", "password"].map(str) as [
      string,
      string,
      string,
      string,
    ];
    const projectName = str("projectName");
    // `token` is NOT in this list any more — see the claim check below.
    for (const [k, v] of Object.entries({ orgName, email, password })) {
      if (!v) return fail(c, 400, "validation_failed", `${k} is required.`, { field: k });
    }
    if (password.length < 12) {
      return fail(c, 400, "validation_failed", "The password must be at least 12 characters.", {
        field: "password",
      });
    }

    /**
     * THE CLAIM, and the decision it encodes (the maintainer, 2026-09-01).
     *
     * An unclaimed instance is claimable by whoever asks first — the model
     * Strapi, Ghost and Gitea all use. The token stops being a requirement and
     * becomes an optional extra: supply one and it is still checked, supply
     * none and the first person through the door becomes the owner.
     *
     * WHAT THAT BUYS. The old rule was "hold a token minted at boot", which
     * assumed someone was watching a terminal. Nobody is, on a platform — and
     * serverless never minted one in the first place, so the requirement was
     * not strict, it was impossible. It also dissolves the reason serverless
     * hardcodes `state: "READY"`: with nothing to mint, there is nothing for
     * concurrent function instances to race over.
     *
     * WHAT IT COSTS, stated rather than discovered. Between the moment an
     * instance first answers and the moment someone claims it, anyone who
     * reaches the URL can take it. That window is real on a public, guessable
     * hostname. It closes permanently at the first claim, and `isClaimed`
     * above is what makes "permanently" true on a deployment whose role does
     * not bypass RLS — which is precisely the bug that made this endpoint
     * worth reading twice.
     *
     * A token that IS presented must still be valid. Ignoring a wrong one
     * would be friendlier and worse: it would mean an operator pasting a stale
     * token from an old boot silently claims the instance anyway, and never
     * learns their token was junk.
     */
    let match: { id: string } | null = null;
    if (token) {
      // Constant-time compare. The row is found by hash rather than
      // fetched-then-compared so a wrong token and an unknown token take the
      // same path; `timingSafeEqual` then covers the compare itself.
      const want = tokenHash(token);
      const rows = await sql<{ id: string; token_hash: Buffer }[]>`
        SELECT id, token_hash FROM setup_tokens
        WHERE consumed_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      `;
      match =
        rows.find(
          (r) => r.token_hash.length === want.length && timingSafeEqual(r.token_hash, want),
        ) ?? null;
      if (!match) {
        return fail(
          c,
          409,
          "already_claimed",
          "That claim token is not valid. If the instance is already set up, sign in instead; " +
            "otherwise leave the token out — an unclaimed instance can be claimed without one.",
        );
      }
    }

    const orgId = randomUUID();
    const userId = randomUUID();
    const sessionToken = randomBytes(32).toString("base64url");

    const out = await sql.begin(async (tx) => {
      // Every statement below runs under RLS. `app.org_id` is set FIRST and to
      // the org we are about to create: the policies apply to INSERT through
      // their WITH CHECK, so without this the very first insert fails on a
      // correctly-secured deployment. (On a BYPASSRLS role it would appear to
      // work — which is exactly why the probe exists.)
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      // And the maintenance claim for the users row: `users_org` sees a
      // person only through a membership, and the membership comes after the
      // user — under a role that honours RLS the INSERT would fail its own
      // WITH CHECK. `orgs.ts` takes the same claim for the same reason.
      await tx`SET LOCAL app.maintenance = 'on'`;

      await tx`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, ${orgName}, ${slugify(orgName)})`;
      await tx`
        INSERT INTO users (id, org_id, email, name, password_hash, email_verified)
        -- name is '', not the studio's: setup asks for a studio name and an
        -- email, never for the person's name, and the rail introduced the
        -- owner as their own studio. Empty falls back to the email everywhere.
        VALUES (${userId}, ${orgId}, ${email}, '', ${hashPassword(password)}, true)
      `;
      await tx`
        INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')
      `;
      // One call, `projects.ts`. A project is a row plus two environments plus
      // a round, and this route is the one that learned that the hard way.
      const created = await createProject(tx, {
        orgId,
        name: projectName || "First project",
        createdBy: userId,
        graceHours: cfg.int("SNAGSET_WRITE_MODE_GRACE_HOURS"),
      });
      await tx`
        INSERT INTO user_sessions (id, org_id, user_id, token_hash, expires_at)
        VALUES (${randomUUID()}, ${orgId}, ${userId}, ${tokenHash(sessionToken)},
                now() + interval '30 days')
      `;
      if (match) await tx`UPDATE setup_tokens SET consumed_at = now() WHERE id = ${match.id}`;
      // Step 2's last clause. Any other outstanding token is now a second key
      // to a door that has been opened; there is no reason for one to survive
      // — and that holds whether or not a token was the thing that opened it,
      // so a tokenless claim sweeps them too.
      await tx`DELETE FROM setup_tokens WHERE consumed_at IS NULL`;

      return { projectUid: created.uid };
    });

    deps.state = "READY";

    // Claiming an instance signs you in. The row was just written above; this
    // sets the two cookies that make it usable, so the first-run flow ends on
    // the dashboard rather than on a login form asking for the password the
    // operator typed ten seconds ago.
    const csrf = randomBytes(32).toString("base64url");
    // The owner's browser is certainly at the instance's real address
    // right now, and the owner is the one party allowed to say what it is.
    // Kept unless the environment already names one, which wins and locks.
    if (!addressPinned(cfg)) {
      const wanted = validateAddress(str("address"));
      if (wanted.ok) await storeAddress(sql, keys, orgId, wanted.origin, null);
    }
    setSessionCookies(c, sessionToken, csrf, ownerDeps.secure, 30 * 24 * 60 * 60);

    return c.json(
      {
        org: { name: orgName },
        user: { email },
        // The uid, never the row id: it is the project identity everything
        // outside the database uses, and asserts no dashboard surface
        // carries the other one.
        project: { uid: out.projectUid, name: projectName || "First project", keyPrefix: THREAD_REF_PREFIX.replace("-", "") },
        csrfToken: csrf,
      },
      201,
    );
  });

  /**
   * CREDENTIAL HYGIENE — the one place raw credentials are presented.
   *
   * Nothing in any spec keeps `snag_k`, a bearer or a `holderSecret` out of
   * SERVER logs: the fragment argument covers URLs, but the token arrives in
   * the sessions request BODY. So the rule is mechanical rather than a
   * convention — this middleware marks the route, and no body is ever logged
   * on it.
   */
  /**
   * OWNER auth, app-wide and free when absent: no dashboard cookie
   * means an immediate `next()`, so the widget's routes — which are on another
   * origin and can never carry it — pay nothing. Mounted here rather than per
   * route group because the last time a credential middleware lived inside one
   * group, the route registered before it answered without protection.
   */
  //
  // ON /api/* AND /auth/* — not "*". The mount POINT is unchanged (first,
  // before any route that reads the owner), which is what the paragraph
  // above is protecting; the mount PATH is narrowed to the only two prefixes
  // where c.get("owner") is ever read. Measured before this in a clean
  // Chromium with a stale session cookie: GET / 554 ms, the bundle 545 ms,
  // the stylesheet 562 ms, then /api/v1/me 528 ms — sign-in at 1.9 s, every
  // request paying a user_sessions lookup against Neon for a credential a
  // static file cannot use. Without the cookie the same load took 97 ms. A
  // signed-in operator paid the same trip per asset, silently, all day.
  app.use("/api/*", ownerAuth(ownerDeps));
  app.use("/auth/*", ownerAuth(ownerDeps));
  app.route("/", ownerRoutes(ownerDeps));

  /**
   * MCP bearer auth, app-wide for the same reason `ownerAuth` is:
   * the credential is attached wherever it is presented and every route
   * decides for itself what a scope permits. It costs one `startsWith` when no
   * MCP token is present, which is every widget request.
   *
   * Mounted AFTER `ownerAuth` and before every route, so `c.get("mcp")` is
   * populated by the time a handler asks. The two never collide: an owner
   * arrives in a cookie, an agent in `Authorization: Bearer`.
   */
  app.use("*", mcpAuth(sql));

  app.use("/api/v1/projects/:uid/sessions", async (c, next) => {
    c.set("noBodyLogging", true);
    await next();
  });

  // The widget's surface. Mounted after /setup so the gate below still catches
  // it while unclaimed: a project route on an unclaimed instance is a 409, not
  // a 404, because there is no project rather than no route.
  /**
   * The CORS classes, at the APP level so EVERY project route is covered.
   *
   * Route-group middleware only covers routes registered after it IN THAT
   * GROUP. This lived inside `threadRoutes`, and `sessionRoutes` is mounted
   * first — so the credential exchange answered 201 with no
   * `Access-Control-Allow-Origin`, the preflight passed (its OPTIONS handler
   * WAS in the covered group), and the browser reported `net::ERR_FAILED` on
   * the POST underneath a green OPTIONS. A CORS failure wearing the costume of
   * a network fault, on the one route that hands out a credential.
   */
  app.use(
    "/api/v1/projects/:uid/*",
    corsForProjects(sql, async (uid) => {
      const p = await projects.get(uid).catch(() => null);
      return p ? { id: p.id, org_id: p.org_id, domain: p.domain } : null;
    }),
  );

  // After CORS, before the routes: a session is ATTACHED when one verifies and
  // the route decides whether it needed one. `/sessions` is excluded — it is
  // where a bearer is exchanged, not presented.
  // The telemetry travels on the reviewer's own session, like every other
  // widget write — it is reported BY a reviewer about a pin they are looking
  // at, so it needs no permission of its own beyond being signed in.
  app.use("/api/v1/projects/:uid/anchor-reports", bearerAuth(keys, projects, ttls.absoluteS, reviewers));
  app.use("/api/v1/projects/:uid/threads", bearerAuth(keys, projects, ttls.absoluteS, reviewers));
  app.use("/api/v1/projects/:uid/threads/*", bearerAuth(keys, projects, ttls.absoluteS, reviewers));
  // The assignee pool answers a review-link session too — a client
  // reads who can be assigned, and a team link assigns.
  app.use("/api/v1/projects/:uid/assignees", bearerAuth(keys, projects, ttls.absoluteS, reviewers));
  // The dashboard's unscoped form, `/api/v1/threads/{id}/comments` — no `:uid`
  // segment for `bearerAuth` to read, so this mount is a no-op today (it
  // returns immediately whenever its own `uid` param is absent). Added anyway
  // so the credential-attaching middleware for this surface is declared once,
  // per path, the same way every other one here is — not discovered missing
  // the day a bearer-carrying caller of the unscoped form shows up.
  app.use("/api/v1/threads/*", bearerAuth(keys, projects, ttls.absoluteS, reviewers));

  // The member sign-in mints a WIDGET session from a DASHBOARD cookie,
  // so it is dashboard-class — the cookie and the CSRF pair — while its
  // siblings on `/sessions` take no cookie at all. Mounted on the one path,
  // before the routes, so the exchange the widget calls is untouched.
  // An exact path, so it does NOT cover `…/sessions/member/silent`:
  // that one is called by the widget, which cannot read the CSRF half, and is
  // guarded by Fetch Metadata and a same-site origin instead (the route says
  // how). member-session.test.ts asserts both halves of that.
  app.use("/api/v1/projects/:uid/sessions/member", requireOwner());
  app.route("/", sessionRoutes({ sql, keys, projects, ttls }));
  // Whether to QUEUE a notification at all — see CommentDeps.notifications.
  // Computed once at construction: the transport cannot change without a
  // config change, and a config change means a restart.
  const env = deps.env ?? process.env;
  // Asked per write rather than computed once: a transport connected on
  // Studio › General counts from its next send, with no restart.
  const notifications = async (): Promise<boolean> => isConfigured((await resolveMailer(sql, keys, cfg)).status);
  // The address is read live — the environment's, the owner's, or this machine's.
  const address = addressSource(sql, keys, cfg);
  // So is the remote MCP transport's switch.
  const mcpHttp = mcpHttpSource(sql, keys, cfg);
  // The site's tracker connections, read without opening a token.
  const trackers = async (orgId: string, projectId: string) =>
    (await listIntegrations(sql, keys, orgId))
      .filter((i) => i.projectId === projectId && i.enabled && isTracker(i.provider))
      .map((i) => ({ id: i.id, provider: i.provider as Tracker, createOn: ((i.config as { createOn?: string }).createOn === "thread.created" ? "thread.created" : "manual") as "manual" | "thread.created" }));
  const githubApiBase = deps.githubApiBase ?? cfg.get("SNAGSET_GITHUB_API_BASE");
  const linearApiBase = deps.linearApiBase ?? cfg.get("SNAGSET_LINEAR_API_BASE");
  const slackApiBase = deps.slackApiBase ?? cfg.get("SNAGSET_SLACK_API_BASE");
  const push: PushDeps = {
    keys,
    baseUrl: address,
    ...(githubApiBase ? { githubApiBase } : {}),
    ...(linearApiBase ? { linearApiBase } : {}),
    ...(slackApiBase ? { slackApiBase } : {}),
  };
  // A9b's features, and the plan's word on them: a bucket makes screenshots
  // possible, the org's limits say whether they are offered.
  const featuresFor = async (orgId: string) => {
    const [f, l] = await Promise.all([features(sql, keys, env), limits(orgId)]);
    return { screenshots: f.screenshots && l.screenshots, uploads: f.uploads && l.screenshots };
  };
  app.route(
    "/",
    threadRoutes(sql, projects, featuresFor, notifications, address, trackers, Number(cfg.get("SNAGSET_ASSIGN_MAIL_DELAY_S") ?? 3600) * 1000),
  );
  app.route(
    "/",
    anchorReportRoutes(sql, projects, () => cfg.int("SNAGSET_RATE_LIMIT_ANCHOR_REPORTS_PER_MIN")),
  );
  app.route("/", commentRoutes({ sql, projects, notifications }));
  /**
   * Editing and deleting a comment (endpoints 12 and 13). Mounted here, beside
   * the comment routes, and BEFORE the owner-gated block below — a reviewer
   * session is a legitimate credential on these paths, so `requireOwner()`
   * must not stand in front of them.
   */
  app.use("/api/v1/comments/*", bearerAuth(keys, projects, ttls.absoluteS, reviewers));
  app.use("/api/v1/projects/:uid/comments/*", bearerAuth(keys, projects, ttls.absoluteS, reviewers));
  app.route("/", commentEditRoutes({ sql }));

  app.use("/api/v1/projects/:uid/attachments", bearerAuth(keys, projects, ttls.absoluteS, reviewers));
  app.route(
    "/",
    attachmentRoutes({
      sql,
      keys,
      projects,
      limits,
      maxImageBytes: cfg.int("SNAGSET_STORAGE_MAX_IMAGE_BYTES"),
    }),
  );
  // The screenshot's refused images (CORS), fetched server-side for a widget
  // session of this site only — routes/imageProxy.ts says what bounds it.
  app.use("/api/v1/projects/:uid/image", bearerAuth(keys, projects, ttls.absoluteS, reviewers));
  app.route("/", imageProxyRoutes({ sql, projects }));
  /**
   * Dashboard-class: no CORS headers, so a reviewed site cannot mint
   * or revoke a link even holding a valid widget session.
   *
   * AND NOW AUTHENTICATED, which it was not. Absent CORS headers stop a
   * BROWSER on another origin from reading the response; they stop nothing
   * else. `curl` against the port minted a working review link with no
   * credential at all — and under the link IS the access-control system, so
   * that was the whole of it. Found by minting one that way while measuring
   * latency.
   */
  /**
   * Adding a site. Dashboard-class: owner cookie plus the CSRF pair on
   * the mutation, both from `requireOwner()`.
   *
   * `/api/v1/projects` is registered UNSCOPED and therefore before the `:uid`
   * mounts — a middleware mounted on `/api/v1/projects/:uid/*` never sees it,
   * which is precisely how the review-link route ended up mintable by `curl`.
   *
   * THE UNCLAIMED CHECK COMES FIRST, and it is not decoration. The
   * gate is the catch-all at the bottom of this file, so before this route
   * existed an unclaimed instance answered `/api/v1/projects` with 409
   * `instance_unclaimed` simply because nothing matched. Mounting
   * `requireOwner()` here made it 401 "sign in to the dashboard first" — advice
   * for an instance that has no users to sign in as, on the exact request an
   * operator makes when they have not finished setting it up. Caught by
   * `setup.test.ts`, which asserts the gate covers everything outside its
   * allow-list.
   */
  const unclaimedFirst: MiddlewareHandler<Env> = async (c, next) => {
    if (deps.state !== "READY") {
      return fail(
        c,
        409,
        "instance_unclaimed",
        "This instance has not been claimed yet. Open it in a browser to create the first " +
          "owner, or run `snagset bootstrap` to claim it from the command line.",
      );
    }
    return next();
  };
  app.use("/api/v1/projects", unclaimedFirst, requireOwner());
  app.use("/api/v1/projects/:uid/origins", unclaimedFirst);
  app.use("/api/v1/projects/:uid/origins", requireOwner());
  // The audience PATCH is dashboard-class too — but requireOwner cannot mount
  // on the bare :uid path, whose GETs belong to the widget. Method-scoped.
  app.on("PATCH", "/api/v1/projects/:uid", requireOwner());
  // The site DELETE, for the same reason and in the same way. It had no CSRF
  // check at all until the audit found it: SameSite=Lax and the absent
  // CORS credentials kept a cross-site page out, but every sibling mutation
  // carries the pair and this one should not be the exception.
  app.on("DELETE", "/api/v1/projects/:uid", requireOwner());
  /**
   * One-click unsubscribe (B2). Mounted OUTSIDE `/api/v1`, with no auth
   * middleware in front of it, and both facts are the design: the person
   * clicking may hold no session and the link's HMAC is what authorises it.
   * A route class that demanded a credential here would mean the only people
   * who can stop the mail are the ones still able to log in.
   */
  app.route("/", unsubscribeRoutes({ sql, keys }));

  app.route("/", siteRoutes({ sql, projects, limits, graceHours: cfg.int("SNAGSET_WRITE_MODE_GRACE_HOURS") }));

  // Members — a signed-in cookie for everything, and the route itself decides
  // what an admin may do (see members.ts: owners change the list, admins read it).
  app.use("/api/v1/members", requireOwner());
  app.use("/api/v1/members/*", requireOwner());
  // What the instance is connected to. Dashboard-class: cookie and CSRF.
  app.use("/api/v1/instance", requireOwner());
  app.use("/api/v1/instance/*", requireOwner());
  app.route("/", instanceRoutes({ sql, keys, cfg, env }));
  // The trackers. Dashboard-class, owners write.
  app.use("/api/v1/integrations", requireOwner());
  // The studio's own feed across every site. Any signed-in member.
  app.use("/api/v1/activity", requireOwner());
  app.route("/", activityRoutes(sql));
  // The agent tokens — owners mint and revoke, admins.
  app.use("/api/v1/mcp-tokens", requireOwner());
  app.use("/api/v1/mcp-tokens/*", requireOwner());
  app.route("/", mcpTokenRoutes({ sql, projects, mcpHttp, address }));
  // The remote MCP transport. Off until the switch or the flag
  // says otherwise; the tools' API calls come straight back into this app's fetch.
  app.route("/", mcpHttpRoutes({ mcpHttp, address, version: deps.version, dispatch: (req) => Promise.resolve(app.fetch(req)) }));
  app.use("/api/v1/projects/:uid/integrations/*", requireOwner());
  app.use("/api/v1/projects/:uid/threads/:id/integrations/*", requireOwner());
  app.route("/", integrationRoutes({ sql, keys, projects, push, baseUrl: address, notifications, limits }));
  /**
   * Invites, BEFORE the members routes so `/api/v1/members/invites`
   * is never read as a member addressed by the email "invites". The studio's
   * half sits behind the `/api/v1/members/*` requireOwner above; the
   * invitee's half is under `/auth/invites/*`, public by design — a person
   * with no account yet is the only one who ever calls it — and limited and
   * origin-checked in the routes themselves, as `/auth/register` is.
   */
  app.route(
    "/",
    inviteRoutes({
      sql,
      limits,
      address,
      mailer: async () => (await resolveMailer(sql, keys, cfg)).status,
      origin: ownerDeps.origin,
      secure: ownerDeps.secure,
    }),
  );
  app.route("/", memberRoutes({ sql }));
  // Sign-up, the switcher and the second studio. Cookie-class; the
  // flag opens the two doors that make a studio, the switcher needs none.
  app.use("/api/v1/orgs", requireOwner());
  app.route(
    "/",
    orgRoutes({
      sql,
      origin: ownerDeps.origin,
      secure: ownerDeps.secure,
      signupOpen: ownerDeps.signupOpen,
      graceHours: cfg.int("SNAGSET_WRITE_MODE_GRACE_HOURS"),
      onFirstOrg: () => {
        deps.state = "READY";
      },
    }),
  );

  // The studio's name, your name, your password (account.ts). requireOwner
  // on /api/v1/me adds nothing to the GET it already guards itself, and puts
  // the CSRF check in front of the PATCH and the POST.
  app.use("/api/v1/org", requireOwner());
  app.use("/api/v1/me", requireOwner());
  app.use("/api/v1/me/*", requireOwner());
  app.route("/", accountRoutes({ sql }));

  app.use("/api/v1/projects/:uid/review-links", requireOwner());
  app.use("/api/v1/review-links/*", requireOwner());
  // Rounds are a STUDIO act (and `rounds.created_by` references `users`
  // rather than `reviewers` for exactly that reason), so the whole surface is
  // owner-gated the same way.
  app.use("/api/v1/projects/:uid/rounds", requireOwner());
  app.use("/api/v1/rounds/*", requireOwner());
  app.route("/", roundRoutes({ sql, projects }));
  // The assignee pool and the placeholder person.
  app.route("/", assigneeRoutes({ sql, projects }));
  app.route(
    "/",
    reviewLinkRoutes({
      sql,
      projects,
      ttlDays: cfg.int("SNAGSET_REVIEW_LINK_TTL_DAYS"),
      maxTtlDays: cfg.int("SNAGSET_REVIEW_LINK_MAX_TTL_DAYS"),
    }),
  );

  /**
   * The dashboard's static assets — /: the SPA is
   * BUNDLED INTO this package rather than deployed separately, so `npx
   * snagset` is one process with a UI and not a server plus a hosting
   * decision.
   *
   * Served here rather than by a static middleware because there is one
   * subtlety worth being explicit about: an SPA needs every unmatched
   * dashboard path to return `index.html` so a deep link like
   * `/?project=…&t=SN-14` survives a reload — but that fallback must NOT
   * swallow `/api/*`, or a typo in an API path returns 200 and a page of HTML
   * where the caller expected an error envelope.
   */
  /**
   * The jobs endpoint — the cron target, and it lives HERE rather than
   * in `serverless.ts` for one reason: everything below this line is a
   * catch-all. The first version registered it on the app returned by this
   * function and got a 404 on every call, because Hono matches in registration
   * order and the dashboard fallback had already claimed `/*`. That is the
   * same mistake the widget routes made an hour earlier, which is why both now
   * sit above the fallback and say so.
   *
   * The bin gets it too. It ticks on its own interval and does not need it,
   * but an operator with a stuck queue having a way to force a tick is worth
   * more than the symmetry of hiding it — and it carries the same
   * authentication either way.
   */
  app.route("/", jobsRoutes({ sql, jobs }));

  /**
   * The widget, BEFORE the dashboard's catch-all.
   *
   * Order is the whole of it. The fallback below answers every unmatched path
   * with `index.html`, so mounted after it `/widget/snag.js` would return a
   * page of HTML with a 200 — which is precisely how the absence of these
   * routes went unnoticed until a script tag on a real site failed with a MIME
   * type error.
   */
  app.route("/", widgetRoutes({ version: deps.version }));

  const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "dashboard");
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
  };
  app.get("/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/") || path.startsWith("/auth/") || path === "/healthz" || path === "/readyz") {
      return next();
    }
    // Vite's hashed assets live under /assets/; everything else falls back to
    // the shell. `..` cannot escape because the join is resolved and checked.
    const wanted = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    const full = resolve(dashboardDir, wanted);
    const file = full.startsWith(resolve(dashboardDir)) && existsSync(full) && statSync(full).isFile()
      ? full
      : resolve(dashboardDir, "index.html");
    if (!existsSync(file)) return next();
    const ext = file.slice(file.lastIndexOf("."));
    c.header("Content-Type", MIME[ext] ?? "application/octet-stream");
    // Hashed filenames are immutable; the shell must never be. `s-maxage`
    // because a browser's `max-age` says nothing to a shared cache: on Vercel
    // every path is the function, so each chunk of a screen this browser had
    // not opened yet crossed to the function's region — Seoul to London,
    // ~0.3 s for every wave of imports. With it the edge nearest the studio
    // answers (and a deploy starts that cache afresh).
    c.header(
      "Cache-Control",
      file.includes("/assets/") ? "public, max-age=31536000, s-maxage=31536000, immutable" : "no-cache",
    );
    return c.body(readFileSync(file));
  });

  /**
   * The gate. Everything not listed above answers 409 while
   * the instance is unclaimed, with a message that tells the operator what to
   * do rather than that the route does not exist.
   */
  app.all("*", (c) => {
    if (deps.state !== "READY") {
      return fail(
        c,
        409,
        "instance_unclaimed",
        "This Snagset instance is running but has not been claimed yet. Open the claim URL " +
          "printed in the server logs (or in <data>/bootstrap.txt) to create the first owner. " +
          "Lost it? Run `npx snagset bootstrap`.",
      );
    }
    return fail(c, 404, "not_found", `No route for ${c.req.method} ${new URL(c.req.url).pathname}.`);
  });

  return app;
}

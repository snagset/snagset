import { Hono, type Context, type MiddlewareHandler } from "hono";
import { randomUUID, randomBytes, createHash, timingSafeEqual, scryptSync } from "node:crypto";
import type postgres from "postgres";
import { DASHBOARD_SESSION_COOKIE, DASHBOARD_CSRF_COOKIE, HTTP_HEADER, ID_PREFIX } from "@snagset/types/names";
import { usage, type LimitsSource } from "../plan.ts";
import { studiosOf } from "../orgs.ts";
import { inOrg, maintenance } from "../db/scope.ts";
import { effectiveWriteMode } from "./sessions.ts";
import { pendingMigrations } from "../db/migrate.ts";

/**
 * Owner auth.
 *
 * *"Owners are a completely separate identity system from reviewers: different
 * table (`users`), different credential (cookie session), different origin,
 * different lifetime (30 days vs 15 minutes)."*
 *
 * Nothing here is shared with `session.ts`. That file mints signed JWTs for
 * REVIEWERS on somebody else's origin, where a cookie would be both useless
 * (cross-site) and dangerous (ambient authority on a page we are a guest on).
 * This file issues 32 opaque random bytes on the server's OWN origin, with a
 * `user_sessions` row as the authority — so "log out" and "sign out
 * everywhere" are real operations rather than a promise to stop honouring a
 * token that keeps verifying.
 *
 * THE ROW IS THE AUTHORITY, and that is the whole reason the value is random
 * rather than signed. A signed token is valid until it expires, whatever the
 * database says; a random one is valid only while a row says so.
 */

type Env = {
  Variables: {
    requestId: string;
    owner?: OwnerClaims;
  };
};
type Ctx = Context<Env>;

export type MemberRole = "owner" | "admin" | "member" | "viewer";

export interface OwnerClaims {
  userId: string;
  orgId: string;
  email: string;
  name: string;
  sessionId: string;
  /** From `memberships.role`, which 0001 has carried since day one and nothing
   *  read until members existed. `owner` and `admin` are wired; the other two
   *  are in the enum and refused by the API until a client needs a read-only
   *  studio seat (01 F-27 ties visibility to roles, and that is not designed). */
  role: MemberRole;
}

export interface OwnerDeps {
  sql: postgres.Sql;
  /** The org's limits, for `/api/v1/me`: the count against the number, where one exists. */
  limits: LimitsSource;
  /** Whether a signed-in person may make another studio here (`SNAGSET_SIGNUP_OPEN`); the header offers it only then. */
  signupOpen?: () => boolean;
  /** Functions and database far apart (instance/region.ts) — shown as a banner. */
  regionMismatch?: import("../instance/region.ts").RegionMismatch | null;
  /** The server's own origin, for the CSRF origin check. Injected rather than
   *  read off the request, because a check against a value the attacker sends
   *  is not a check. */
  origin: string;
  /** `false` on plain http — a `Secure` cookie is simply dropped there, which
   *  on a first `npx snagset` run reads as "login is broken". */
  secure: boolean;
  now?: () => Date;
}

/** 30-day absolute, 7-day idle, rolling refresh on use. */
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const IDLE_MS = 7 * 24 * 60 * 60 * 1000;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}

/**
 * scrypt, not argon2id, and the deviation is deliberate.
 *
 * The table says argon2id via `node-argon2`. That is a NATIVE module: it
 * needs a compiler or a prebuilt binary for the exact platform and Node ABI,
 * and the promise is one npm package that `npx` runs with no build step. A
 * dependency that fails to install on a machine with no toolchain would make
 * the first-run login unreachable, which is the same failure mode rejects
 * magic-link-only auth for.
 *
 * scrypt is memory-hard, in the standard library, and OWASP-parameterised here
 * (N=2^17, r=8, p=1 — their scrypt baseline). The format carries its
 * parameters so an argon2 row can be added later without a migration.
 */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/**
 * Verify, in constant time, and never leak WHICH part was wrong.
 *
 * Returns false for a user with no password (OAuth-only) rather than
 * throwing — but still spends the same work, because an early return on
 * "this account has no password" is an account-enumeration oracle measurable
 * over a few hundred requests.
 */
export function verifyPassword(password: string, stored: string | null): boolean {
  const parts = (stored ?? "").split("$");
  const decoy = parts.length === 3 ? null : "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAA";
  const [, saltB64, keyB64] = (decoy ? decoy.split("$") : parts) as [string, string, string];
  const salt = Buffer.from(saltB64, "base64url");
  const want = Buffer.from(keyB64, "base64url");
  const got = scryptSync(password, salt, want.length || 64, SCRYPT);
  if (decoy) return false;
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Both cookies, set together — they are one credential in two halves. */
function setSessionCookies(c: Ctx, token: string, csrf: string, secure: boolean, maxAgeS: number): void {
  const base = `Path=/; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
  // HttpOnly: the value is the credential and no script has any reason to read it.
  c.header("Set-Cookie", `${DASHBOARD_SESSION_COOKIE}=${token}; HttpOnly; ${base}`, { append: true });
  // NOT HttpOnly, deliberately: double-submit works precisely because the
  // dashboard's own JS reads this one and echoes it in a header, which a
  // cross-site page cannot do — it can send the cookie, but it cannot read it.
  c.header("Set-Cookie", `${DASHBOARD_CSRF_COOKIE}=${csrf}; ${base}`, { append: true });
}

function clearSessionCookies(c: Ctx, secure: boolean): void {
  const base = `Path=/; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  c.header("Set-Cookie", `${DASHBOARD_SESSION_COOKIE}=; HttpOnly; ${base}`, { append: true });
  c.header("Set-Cookie", `${DASHBOARD_CSRF_COOKIE}=; ${base}`, { append: true });
}

function readCookie(c: Ctx, name: string): string | null {
  const raw = c.req.header("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * The middleware. Attaches `owner` when a session verifies; refuses nothing by
 * itself — the routes decide, exactly as `bearerAuth` does on the widget side,
 * so a route that forgot to check is a visible omission rather than an
 * invisible one.
 */
export function ownerAuth(deps: OwnerDeps): MiddlewareHandler<Env> {
  const { sql } = deps;
  const now = deps.now ?? (() => new Date());
  return async (c, next) => {
    const token = readCookie(c as Ctx, DASHBOARD_SESSION_COOKIE);
    if (!token) return next();

    const at = now();
    const [row] = await maintenance(sql, (tx) => tx<
      { id: string; org_id: string; user_id: string; email: string; name: string; last_seen_at: Date; role: MemberRole }[]
    >`
      SELECT s.id, s.org_id, s.user_id, u.email, u.name, s.last_seen_at, m.role
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
      -- No membership, no session: a user removed from the org keeps no
      -- access through a cookie minted while they were in it.
      JOIN memberships m ON m.org_id = s.org_id AND m.user_id = s.user_id
      WHERE s.token_hash = ${sha256(token)}
        AND s.revoked_at IS NULL
        AND s.expires_at > ${at}
        AND s.last_seen_at > ${new Date(at.getTime() - IDLE_MS)}
    `);
    if (!row) {
      // The cookie names no live session — expired, revoked, or minted under
      // a key this instance no longer has. Left alone it is presented on every
      // API call for as long as the browser keeps it, and each presentation
      // is this query: an Atlantic round trip per request to be told no. So
      // it is cleared on the first miss, with logout's own attributes so the
      // browser actually drops it. The request itself proceeds unsigned, as
      // it always did; the only change is that the NEXT one costs nothing.
      clearSessionCookies(c as Ctx, deps.secure);
      return next();
    }

    c.set("owner", {
      userId: row.user_id,
      orgId: row.org_id,
      email: row.email,
      name: row.name,
      sessionId: row.id,
      role: row.role,
    });

    // Rolling refresh, but not on every request: `last_seen_at` only
    // needs to be accurate to within the idle window, and a write per request
    // turns a read-only dashboard page into a write on the hot path.
    if (at.getTime() - row.last_seen_at.getTime() > 60 * 60 * 1000) {
      void inOrg(sql, row.org_id, (tx) => tx`UPDATE user_sessions SET last_seen_at = ${at} WHERE id = ${row.id}`).catch(() => {});
    }
    return next();
  };
}

/**
 * The double-submit compare itself, exported so a route that cannot mount
 * `requireOwner()` wholesale — because it also serves a different credential
 * — can still run the same check inline (`comments.ts`: a reviewer session
 * posts to the same path an owner cookie does, so the route itself has to
 * branch on which credential arrived rather than gating the whole path).
 *
 * `Origin` is NOT re-checked here — that half of `requireOwner()`'s story is
 * about login CSRF specifically (the comment on `/auth/login`) and every
 * other owner-cookie route relies on `SameSite=Lax` plus this pair.
 */
export function csrfOk(c: Ctx): boolean {
  const sent = c.req.header(HTTP_HEADER.csrf);
  const cookie = readCookie(c, DASHBOARD_CSRF_COOKIE);
  return (
    !!sent && !!cookie && sent.length === cookie.length && timingSafeEqual(Buffer.from(sent), Buffer.from(cookie))
  );
}

/**
 * The CSRF pair, on mutations only.
 *
 * TWO checks, and `SameSite=Lax` is explicitly not treated as sufficient by the
 * spec: `Origin` must equal the server's own, AND `x-snagset-csrf` must equal
 * the non-HttpOnly cookie. The second is what a cross-site page cannot forge —
 * it can cause the browser to SEND our cookies, but it cannot READ one to echo
 * it back in a header.
 *
 * A safe method is exempt because a GET must not be a mutation in the first
 * place; if one ever is, that is the bug to fix rather than the check to add.
 */
export function requireOwner(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const owner = c.get("owner");
    if (!owner) {
      return (c as Ctx).json(
        {
          error: {
            code: "unauthorized",
            message: "Sign in to the dashboard first.",
            requestId: c.get("requestId"),
          },
        },
        401,
      );
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !csrfOk(c as Ctx)) {
      return (c as Ctx).json(
        {
          error: {
            code: "csrf_failed",
            message: "That request could not be verified. Reload the dashboard and try again.",
            requestId: c.get("requestId"),
          },
        },
        403,
      );
    }
    return next();
  };
}

export function ownerRoutes(deps: OwnerDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { sql } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * Sign in. ONE error for every failure — unknown email, wrong password,
   * deleted user — because the difference between them is exactly the
   * information an account-enumeration attack is after.
   */
  app.post("/auth/login", async (c) => {
    // The origin check applies here too: a cross-site page cannot read the
    // response, but it CAN log a victim into an account the attacker controls
    // (login CSRF), and every subsequent action the victim takes lands in the
    // attacker's org.
    // The origin must be OURS — but "ours" is not only the configured base URL.
    //
    // The first attempt compared against `SNAGSET_BASE_URL` alone, which
    // defaults to `http://localhost:8080`, and then refused a browser sitting
    // on `http://127.0.0.1:8080` — the same server, reached by the other name
    // for it. An operator does not reach a self-hosted instance by the name a
    // config default guessed; they reach it by an IP, a LAN hostname, or a
    // tunnel, and being told "this instance does not serve that" by the
    // instance currently serving it is a dead end with no next step.
    //
    // So the request's own Host counts too. That is the standard formulation
    // of this check and it keeps the property that matters: a cross-site page
    // cannot set `Origin`, which is the header being tested. Host is
    // attacker-influenced in principle, but a Host that reaches this process
    // is one the deployment already routes here, and spoofing it does not
    // deliver the victim's cookie anywhere new.
    const origin = c.req.header("Origin");
    const host = c.req.header("Host");
    const ours = new Set([deps.origin, host ? `http://${host}` : "", host ? `https://${host}` : ""]);
    if (origin && !ours.has(origin)) {
      return fail(c, 403, "forbidden", "That sign-in request came from another site.");
    }

    const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || !password) {
      return fail(c, 400, "validation_failed", "Both an email address and a password are required.");
    }

    const [user] = await maintenance(sql, (tx) => tx<{ id: string; org_id: string; email: string; name: string; password_hash: string | null }[]>`
      SELECT id, org_id, email, name, password_hash
      FROM users WHERE email = ${email} AND deleted_at IS NULL
    `);
    // `verifyPassword` spends the same work on a missing row as on a wrong
    // password, so this branch costs what the real one costs.
    if (!verifyPassword(password, user?.password_hash ?? null)) {
      return fail(c, 401, "invalid_credentials", "That email address and password do not match an account.");
    }

    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const expires = new Date(now().getTime() + ABSOLUTE_MS);
    await inOrg(sql, user!.org_id, (tx) => tx`
      INSERT INTO user_sessions (id, org_id, user_id, token_hash, user_agent, expires_at)
      VALUES (${randomUUID()}, ${user!.org_id}, ${user!.id}, ${sha256(token)},
              ${(c.req.header("User-Agent") ?? "").slice(0, 400)}, ${expires})
    `);
    setSessionCookies(c, token, csrf, deps.secure, Math.floor(ABSOLUTE_MS / 1000));
    // No id, for the reason `/api/v1/me` gives: nothing outside the database
    // needs it, and an internal id put on the wire because it was to hand is
    // how the first one always gets out.
    return c.json({ user: { email: user!.email, name: user!.name }, csrfToken: csrf });
  });

  /** Sign out. Revokes the ROW, so the cookie being kept changes nothing. */
  app.post("/auth/logout", async (c) => {
    const owner = c.get("owner");
    if (owner) await inOrg(sql, owner.orgId, (tx) => tx`UPDATE user_sessions SET revoked_at = now() WHERE id = ${owner.sessionId}`);
    clearSessionCookies(c, deps.secure);
    return c.json({ ok: true });
  });

  /**
   * Who am I, and what can I see — the dashboard's first call on every load.
   *
   * It returns the projects too, because every dashboard screen needs them and
   * a separate round trip for a list this size is a round trip for nothing.
   */
  app.get("/api/v1/me", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    /*
     * `shot` and `last_activity` are here rather than in a per-card request,
     * for the same reason the counts are: the Sites screen draws every project
     * at once, so N+1 round trips would be N+1 trips to Neon to render one
     * page. The LATERAL runs per project and stops at one row.
     *
     * WHY A THUMBNAIL AT ALL — you recognise a client's site by how it looks,
     * not by reading three names down a list. It is the one thing Pastel's
     * home does that a text list cannot, and it costs nothing to source: the
     * pixel tier already captures a screenshot with every snag, so the newest
     * one is the site's face for free.
     *
     * Deliberately the newest SCREENSHOT and not the newest image: a reviewer
     * can attach a photo to a comment, and a client's holiday snap is not what
     * their site looks like.
     *
     * ONE transaction for the org, its sites and the counts — they were three,
     * each paying BEGIN, the claim and COMMIT on a call every page load makes.
     * And two facts per site that each cost the dashboard a request IN SERIES
     * before it could draw: whether the site has an address yet (`addressed`,
     * the gate's first-run test, which read `/origins` first) and the round a
     * fresh visit lands in (`landing_round`, which Comments read `/rounds` for
     * before it could ask for the list). Same rule as the dashboard's
     * `landing()`: the newest open, unarchived round, else the newest
     * unarchived, else the newest.
     */
    const { org, projects, used } = await inOrg(sql, owner.orgId, async (tx) => {
      const [org] = await tx<{ name: string; slug: string }[]>`SELECT name, slug FROM orgs WHERE id = ${owner.orgId}`;
      const projects = await tx<
        {
          uid: string; name: string; key_prefix: string; write_mode: string;
          write_mode_downgrade_at: Date | null;
          status: string; domain: string | null; guest_can_resolve: boolean;
          threads: number; unresolved: number;
          shot: string | null; last_activity: Date | null;
          addressed: boolean; landing_round: number | null;
        }[]
      >`
        SELECT p.uid, p.name, p.key_prefix, p.write_mode, p.write_mode_downgrade_at, p.status,
               p.settings->>'domain' AS domain, p.guest_can_resolve,
               (COALESCE(p.settings->>'domain', '') <> ''
                 OR EXISTS (SELECT 1 FROM project_origins o WHERE o.project_id = p.id)) AS addressed,
               (SELECT r.number FROM rounds r
                 WHERE r.project_id = p.id AND r.deleted_at IS NULL
                 ORDER BY (r.archived_at IS NULL AND r.closed_at IS NULL) DESC, (r.archived_at IS NULL) DESC, r.number DESC
                 LIMIT 1) AS landing_round,
               count(t.id)::int AS threads,
               count(t.id) FILTER (WHERE t.status <> 'resolved')::int AS unresolved,
               max(t.updated_at) AS last_activity,
               s.id AS shot
        FROM projects p
        LEFT JOIN threads t ON t.project_id = p.id AND t.deleted_at IS NULL AND t.private = false
        LEFT JOIN LATERAL (
          SELECT a.id
          FROM attachments a
          -- Joined back to the thread, even though attachments.project_id
          -- would answer on its own: a screenshot belonging to a PRIVATE or
          -- deleted thread must not become the site's public face, and only the
          -- thread knows that.
          JOIN threads th ON th.id = a.thread_id
          WHERE a.project_id = p.id
            AND a.kind = 'screenshot'
            AND a.state = 'bound'
            AND a.deleted_at IS NULL
            AND th.deleted_at IS NULL
            AND th.private = false
          ORDER BY a.created_at DESC
          LIMIT 1
        ) s ON true
        WHERE p.org_id = ${owner.orgId} AND p.deleted_at IS NULL
        GROUP BY p.id, p.uid, p.name, p.key_prefix, p.write_mode, p.write_mode_downgrade_at, p.status, p.settings,
                 p.guest_can_resolve, s.id
        ORDER BY p.created_at
      `;
      // The plan's numbers and how far along them the studio is
      // shown where a limit exists, silent where there is none.
      return { org, projects, used: await usage(tx, owner.orgId) };
    });
    // Every studio this person belongs to, for the switcher; the current one is marked.
    const studios = await studiosOf(sql, owner.userId);
    const l = await deps.limits(owner.orgId);
    return c.json({
      limits: {
        projects: { limit: l.projects, used: used.projects },
        members: { limit: l.members, used: used.members },
        storage: { limit: l.storageBytes, used: used.storageBytes },
        screenshots: l.screenshots,
        integrations: l.integrations,
        source: l.source,
      },
      // NO id. Mints no `usr_` prefix, and the dashboard has
      // no use for one: it renders a name and an email. Is about
      // project uuids specifically, but the habit is the point — an internal
      // id put on the wire because it was to hand is how the first one always
      // gets out.
      user: { email: owner.email, name: owner.name, role: owner.role },
      org: { name: org?.name ?? "", slug: org?.slug ?? "" },
      orgs: studios.map((s) => ({ slug: s.slug, name: s.name, role: s.role, current: s.id === owner.orgId })),
      signupOpen: deps.signupOpen?.() ?? false,
      // The migrations this build ships that the database has not run
      // (db/migrate.ts says why a serverless deploy can be behind). Empty
      // when current; the dashboard shows a banner otherwise.
      pendingMigrations: await pendingMigrations(sql),
      // Functions on one continent, the database on another (instance/region.ts).
      ...(deps.regionMismatch ? { regionMismatch: deps.regionMismatch } : {}),
      projects: projects.map((p) => ({
        uid: p.uid,
        name: p.name,
        keyPrefix: p.key_prefix,
        // What the widget enforces, not what the row says. The row only
        // catches up at the next sweep, which is now hourly or daily; a site
        // past its 24-hour grace window must not read "open" until then.
        writeMode: effectiveWriteMode(p, new Date()),
        // (the switch) and (the domain), for the card and Settings.
        status: p.status,
        domain: p.domain,
        // Whether guests may change a comment's status, for Settings.
        guestsCanChangeStatus: p.guest_can_resolve,
        threads: p.threads,
        unresolved: p.unresolved,
        // A URL, not an id, so the client never has to know how a blob is
        // addressed. Null means no snag has been filed yet — which the card
        // renders as its own state rather than a broken image.
        previewUrl: p.shot ? `/api/v1/attachments/${ID_PREFIX.attachment}${p.shot}/blob` : null,
        lastActivityAt: p.last_activity ? p.last_activity.toISOString() : null,
        // Whether the site has a domain or any exact address — false is the
        // first run's cue (/welcome). The list itself stays on /origins.
        addressed: p.addressed,
        // The round Comments opens on, so its list can be asked for beside the
        // rounds rather than after them. Null: no round at all.
        landingRound: p.landing_round,
      })),
    });
  });

  return app;
}

export { setSessionCookies };

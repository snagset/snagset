import type postgres from "postgres";
import type { MiddlewareHandler } from "hono";
import { HTTP_HEADER } from "@snagset/types/names";
import { isLocalOrigin, originMatchesDomain } from "../domain.ts";
import { inOrg, maintenance } from "../db/scope.ts";

/**
 * The request headers a widget may send — the request rows, plus the two
 * standard ones. Built from the registry rather than typed out, so adding a
 * header to a request without listing it here is not possible.
 */
const ALLOWED_REQUEST_HEADERS = [
  "content-type",
  "authorization",
  HTTP_HEADER.client,
  HTTP_HEADER.schema,
  HTTP_HEADER.idempotencyKey,
  HTTP_HEADER.identity,
  HTTP_HEADER.attachmentKind,
  HTTP_HEADER.attachmentWidth,
  HTTP_HEADER.attachmentHeight,
].join(", ");

/**
 * The CORS classes, and the — *"origin suggestion, never origin
 * auto-allow"*.
 *
 * | Class          | Allow-Origin                                    |
 * |----------------|-------------------------------------------------|
 * | Public-read    | echo any Origin (`GET …/config`, `GET …/meta`)  |
 * | Project-scoped | echo ONLY if allow-listed; otherwise omit       |
 * | Dashboard      | no CORS headers at all (`/api/v1/setup`, `/auth`)|
 *
 * "Otherwise omit the header entirely" is the load-bearing half, and it is why
 * this returns a header rather than a 403: the browser is the enforcement
 * point. A response with no `Access-Control-Allow-Origin` is unreadable to the
 * calling page no matter what its status says, and a 403 with a body would
 * leak whether the uid exists to any origin that asks.
 *
 * The reason it is a suggestion and never an auto-allow is:
 * `Origin` is attacker-controllable. Auto-allowing would be an
 * attacker-controlled header driving a state transition that GRANTS access —
 * the mirror image of the denial-of-service case already forbids. Recording
 * it is inert data; a human clicking "Add this origin" is the transition.
 */

/** Exact origin, or a single-level wildcard host. Scheme mandatory. */
function matches(pattern: string, origin: string): boolean {
  if (pattern === origin) return true;
  if (!pattern.includes("*")) return false;
  // `https://*.acme.com` matches `https://staging.acme.com` and NOT
  // `https://a.b.acme.com` — single level, because a wildcard that crosses
  // dots allows any subdomain a subdomain-takeover can mint.
  const [scheme, host] = pattern.split("://");
  const [oScheme, oHost] = origin.split("://");
  if (scheme !== oScheme || !host || !oHost) return false;
  const suffix = host.slice(1); // ".acme.com"
  return oHost.endsWith(suffix) && !oHost.slice(0, -suffix.length).includes(".");
}

export async function allowedOrigins(sql: postgres.Sql, projectId: string): Promise<string[]> {
  const rows = await maintenance(sql, (tx) => tx<{ pattern: string }[]>`
    SELECT pattern FROM project_origins WHERE project_id = ${projectId}
  `);
  return rows.map((r) => r.pattern);
}

export function isAllowed(patterns: readonly string[], origin: string): boolean {
  return patterns.some((p) => matches(p, origin.toLowerCase()));
}

/**
 * The whole verdict — allow-list, the site's domain, or the developer's own
 * machine — as one function, because it is asked in two
 * places now: here, before a widget request is answered, and by the member
 * sign-in (`routes/sessions.ts`), which must refuse to hand a studio
 * session to any page the widget could not have been running on. "Is this
 * origin the site's" answered twice is how the two answers drift, and the
 * drift would be a session posted to a page nobody allowed.
 */
export function originPermitted(patterns: readonly string[], domain: string | null | undefined, origin: string): boolean {
  return isAllowed(patterns, origin) || originMatchesDomain(domain ?? "", origin) || isLocalOrigin(origin);
}

/**
 * The ledger. Capped at 5 distinct origins per project (05 owns the
 * number), so a page that iterates hostnames cannot grow the table.
 *
 * `write_attempted` distinguishes the two cases the dashboard phrases
 * differently: a bare `/config` fetch is *"add this origin?"*, while a write
 * from an unknown origin is *"your project uid is in use somewhere else"*.
 */
export async function recordOrigin(
  sql: postgres.Sql,
  orgId: string,
  projectId: string,
  origin: string,
  wroteAttempt: boolean,
): Promise<void> {
  try {
    await inOrg(sql, orgId, (tx) => tx`
      INSERT INTO origin_violations (org_id, project_id, origin, write_attempted)
      SELECT ${orgId}, ${projectId}, ${origin}, ${wroteAttempt}
      WHERE (SELECT count(*) FROM origin_violations WHERE project_id = ${projectId}) < 5
      ON CONFLICT (project_id, origin) DO UPDATE
        SET hits = origin_violations.hits + 1,
            last_seen_at = now(),
            write_attempted = origin_violations.write_attempted OR EXCLUDED.write_attempted
    `);
  } catch {
    // A ledger write must never fail the request it is observing. The
    // suggestion is a convenience; the CORS decision above it already happened.
  }
}


/**
 * The middleware, mounted at the APP level rather than inside a route group.
 *
 * It lived inside `threadRoutes` first, and the sessions route — registered
 * before it — answered without an `Access-Control-Allow-Origin` header. The
 * preflight still passed, because the OPTIONS handler was in the group that
 * had the middleware, so the browser reported `net::ERR_FAILED` on the POST
 * with a green OPTIONS above it: a CORS failure that looks like a network
 * fault. Route-group middleware only covers the routes registered after it in
 * that group, and a credential exchange is exactly the route you cannot afford
 * to leave outside.
 */
export function corsForProjects(
  sql: postgres.Sql,
  lookup: (uid: string) => Promise<{ id: string; org_id: string; domain?: string | null } | null>,
): MiddlewareHandler {
  /**
   * The allow-list, memoised for 10 s — the same bargain and the same number as
   * the project cache.
   *
   * This was the last uncached query on the widget's hot path: one SELECT
   * before every request, to read three rows that change when an operator runs
   * `snagset allow-origin`. Ten seconds is the lag that buys, and it errs the
   * safe way round — a NEWLY allowed origin waits up to ten seconds to work,
   * which reads as "it took a moment"; a REVOKED one is not the control that
   * matters here, since removing an origin is not how access is withdrawn
   * (that is the link revoke, and it bumps `session_epoch`).
   *
   * Scoped to this middleware instance, so an app built by a test starts cold.
   */
  const ORIGINS_TTL_MS = 10_000;
  const originCache = new Map<string, { at: number; patterns: string[] }>();
  const patternsFor = async (projectId: string): Promise<string[]> => {
    const hit = originCache.get(projectId);
    if (hit && Date.now() - hit.at < ORIGINS_TTL_MS) return hit.patterns;
    const patterns = await allowedOrigins(sql, projectId);
    originCache.set(projectId, { at: Date.now(), patterns });
    return patterns;
  };

  return async (c, next) => {
    const origin = c.req.header("Origin");
    // PUBLIC-READ: `/config` echoes any origin, because that fetch is
    // how an unknown origin becomes a suggestion in the first place — refusing
    // it means the operator never sees the origin they are about to approve.
    // The session exchange is PROJECT-SCOPED: it mints a credential.
    const isPublicRead = c.req.path.endsWith("/config");
    const credentialed = c.req.path.endsWith("/sessions/member/silent");
    const uid = c.req.param("uid");

    if (origin && uid) {
      const project = await lookup(uid).catch(() => null);
      if (project) {
        const patterns = await patternsFor(project.id);
        /**
         * Three ways in (as amended): an exact or wildcard
         * origin from the allow-list; the site's DOMAIN — its host or any
         * subdomain, any scheme, any port; and the developer's own machine
         * (rule 4), which the spec allows by default and which had never been
         * implemented. The domain rides the project cache, so a change lands
         * within the same ten seconds as everything else about a project.
         */
        const ok = originPermitted(patterns, project.domain, origin);
        /**
         * The verdict, stashed for the config route (the origin-aware
         * body). Computed HERE and not re-derived in the route because
         * "is this origin allowed" answered in two places is how the two
         * answers drift — and this one gates what the response discloses.
         */
        c.set("originAllowed", ok);
        if (ok || isPublicRead) {
          c.header("Access-Control-Allow-Origin", origin);
          c.header("Vary", "Origin");
          // "Credentials: never" on both classes. The bearer travels in
          // an Authorization header, not a cookie, which is also why no widget
          // route needs CSRF machinery.
          // EVERY header the widget sends, not just the obvious two. A
          // preflight that omits one makes the browser block the real
          // request while the OPTIONS still answers 204 — the failure looks
          // like a network fault, and it is exactly how the screenshot
          // upload failed after the session exchange had already taught the
          // same lesson one layer up. Generated from the registry so a new
          // header cannot be added to a request without appearing here.
          c.header("Access-Control-Allow-Headers", ALLOWED_REQUEST_HEADERS);
          c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
          c.header("Access-Control-Max-Age", "600");
          /**
           * The ONE credentialed route. The silent member sign-in is
           * the widget's only fetch with `credentials: "include"` — it asks
           * whether the dashboard cookie, sent because the page and the
           * server are one site, belongs to a member — and the browser
           * hands that response to the page only if it says
           * `Allow-Credentials` beside an exact (never `*`) origin, which
           * this one always is. Nowhere else: every bearer route stays
           * "Credentials: never", so a cookie riding along on any
           * other request is not readable by the page that sent it. Both
           * the preflight and the POST carry it; the widget avoids the
           * preflight (a simple request), but a browser that sends one
           * anyway must get a yes. The route itself makes the real
           * decision — same-site, Fetch Metadata, membership.
           */
          if (credentialed && ok) c.header("Access-Control-Allow-Credentials", "true");
        }
        // Inert data plus a human decision, never a transition.
        if (!ok) void recordOrigin(sql, project.org_id, project.id, origin.toLowerCase(), !isPublicRead);
      }
    }

    if (c.req.method === "OPTIONS") return c.body(null, 204);
    return next();
  };
}

import type { MiddlewareHandler } from "hono";
import type { Keyring } from "../keys.ts";
import type { ProjectCache } from "../projectCache.ts";
import type { ReviewerCache } from "../reviewerCache.ts";
import { verifySession, type SessionClaims } from "../session.ts";

/**
 * Bearer auth for the widget's project routes.
 *
 * Verify, then compare `epo` against the 10-second project cache. That
 * comparison is the entire revocation mechanism and it costs no query: the
 * cache entry was already read to resolve the project.
 *
 * OPTIONAL BY DESIGN. This attaches a session when one is presented and
 * verifies; it does not refuse when none is. Refusing here would make every
 * READ require a credential, and the `open` write mode exists precisely
 * so a fresh project works before anyone has been sent a link. The ROUTES
 * decide what they require — thread creation demands a session, listing does
 * not — which keeps "who are you" and "what may you do" as two questions with
 * two answers rather than one conflated gate.
 *
 * A presented-but-INVALID bearer is different from none at all, and is
 * reported: a reviewer whose link was revoked mid-session needs F-19, not a
 * silent downgrade to read-only that looks like the widget quietly breaking.
 */
export function bearerAuth(
  keys: Keyring,
  projects: ProjectCache,
  absoluteTtlS: number,
  /** Per-identity revocation. Optional so existing callers and
   *  tests keep working; without it the check falls back to refresh-time
   *  only, which is the behaviour this argument exists to end. */
  reviewers?: ReviewerCache,
): MiddlewareHandler {
  return async (c, next) => {
    const token = /^Bearer (.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const uid = c.req.param("uid");
    if (!token || !uid) return next();

    const project = await projects.get(uid).catch(() => null);
    if (!project) return next();

    const v = await verifySession(keys, token, {
      projectUid: uid,
      expectedEpoch: project.session_epoch,
      absoluteTtlS,
    });

    if (v.ok) {
      /**
       * PER-IDENTITY REVOCATION — the "10-second cache miss
       * path", which existed in the spec and not in the code.
       *
       * `session_epoch` above revokes a whole project's links and costs
       * nothing, because the project row was already in memory. This is the
       * other case: ONE person signed out — what a host app's logout hook
       * calls — while the round carries on for everybody else. It was checked
       * only when a token refreshed, so a signed-out reviewer kept working
       * for up to the 15-minute sliding TTL.
       *
       * Cached ten seconds per reviewer rather than read per request, because
       * this middleware makes no database call at all and that is worth
       * keeping. `iat` is seconds; the column is a timestamp.
       */
      if (reviewers) {
        const validAfter = await reviewers.validAfter(v.claims.sub).catch(() => null);
        if (validAfter && v.claims.iat * 1000 < validAfter.getTime()) {
          return c.json(
            {
              error: {
                code: "session_revoked",
                message: "This reviewer has been signed out.",
                requestId: c.get("requestId"),
              },
            },
            401,
          );
        }
      }
      c.set("session", v.claims as SessionClaims);
      return next();
    }

    // Revocation is the one failure that must not be silent. `expired` is
    // handled by the client refreshing, and a malformed or foreign token is
    // treated as no credential — but "you were signed out" has to reach the
    // reviewer, or a revoked link looks like a broken widget.
    if (v.reason === "session_revoked") {
      return c.json(
        {
          error: {
            code: "session_revoked",
            message: "This review link was turned off. Ask whoever sent it for a new one.",
            requestId: c.get("requestId"),
          },
        },
        401,
      );
    }
    return next();
  };
}

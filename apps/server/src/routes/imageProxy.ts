import { Hono, type Context } from "hono";
import type postgres from "postgres";
import type { ProjectCache } from "../projectCache.ts";
import type { SessionClaims } from "../session.ts";
import { inOrg } from "../db/scope.ts";
import { fetchPublicImage, PublicFetchError, type PublicFetchCode, type PublicFetchOptions } from "../net/publicFetch.ts";

/**
 * The image proxy — so a screenshot can include the pictures a site serves
 * without CORS headers.
 *
 * Found reviewing Acme on a production instance: the screenshot is a redraw of the
 * page inside the browser, and a browser will not let a page copy pixels from
 * another origin unless that origin says so. Acme's image host does not, so
 * its hero came out as a flat block and the capture listed six placeholders.
 * The reviewer could see every one of those images; only the copy was
 * refused. A server is not bound by that rule, so the widget asks this route
 * for exactly the images the browser refused, and draws what comes back.
 *
 * Pastel solves the same problem by proxying the WHOLE site, which is why its
 * reviewers browse a pastel.com address with no logins of their own. Snagset
 * runs on the real site, so only the refused images make the trip.
 *
 * What keeps "fetch this URL for me" from being a weapon:
 *   · a widget session for THIS site (`bearerAuth` in app.ts), so the route
 *     is not an open proxy for anyone who finds it;
 *   · public internet only, checked at connect time and on every redirect
 *     (net/publicFetch.ts) — never localhost, the private network or the
 *     cloud metadata address;
 *   · images only, standard ports only, a size cap and a time limit;
 *   · a per-session rate, counted in `rate_counters` like anchor reports.
 * A refusal costs that one image, never the screenshot: the widget keeps the
 * placeholder it would have drawn anyway.
 */

type Env = { Variables: { requestId: string; session?: SessionClaims } };
type Ctx = Context<Env>;

/** Large hero images are a few MB; anything past this is not a web picture. */
export const PROXY_MAX_BYTES = 10 * 1024 * 1024;
/** A page with a slow image host should not hold a screenshot for long. */
export const PROXY_TIMEOUT_MS = 8_000;
/** A busy page has dozens of images; this is a ceiling, not a target. */
export const PROXY_PER_MINUTE = 240;
const RATE_WINDOW_MS = 60_000;

export interface ImageProxyDeps {
  sql: postgres.Sql;
  projects: ProjectCache;
  /** Tests only. */
  fetchOptions?: Partial<PublicFetchOptions>;
}

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}

const STATUS: Record<PublicFetchCode, number> = {
  bad_url: 422,
  blocked_address: 422,
  not_an_image: 415,
  too_large: 413,
  upstream: 502,
  timeout: 504,
  too_many_redirects: 502,
};

export function imageProxyRoutes(deps: ImageProxyDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { sql, projects } = deps;

  app.get("/api/v1/projects/:uid/image", async (c) => {
    const project = await projects.get(c.req.param("uid"));
    if (!project) return fail(c, 404, "project_not_found", "No project with that uid.");
    const session = c.get("session");
    if (!session) return fail(c, 401, "unauthorized", "Open your review link, or reload the page, and try again.");

    const src = c.req.query("src");
    if (!src) return fail(c, 400, "validation_failed", "Which image? Pass it as ?src=.");

    const now = new Date();
    const windowStart = new Date(now.getTime() - RATE_WINDOW_MS);
    const [counter] = await inOrg(sql, project.org_id, (tx) => tx<{ count: string }[]>`
      INSERT INTO rate_counters (org_id, bucket_key, window_start, count, expires_at)
      VALUES (${project.org_id}, ${`img:${session.sid}`}, ${now}, 1,
              ${new Date(now.getTime() + RATE_WINDOW_MS)})
      ON CONFLICT (org_id, bucket_key) DO UPDATE
        SET count = CASE WHEN rate_counters.window_start < ${windowStart} THEN 1
                         ELSE rate_counters.count + 1 END,
            window_start = CASE WHEN rate_counters.window_start < ${windowStart} THEN ${now}
                                ELSE rate_counters.window_start END,
            expires_at = ${new Date(now.getTime() + RATE_WINDOW_MS)}
      RETURNING count::text
    `);
    if (Number(counter?.count ?? 0) > PROXY_PER_MINUTE) {
      return fail(c, 429, "rate_limited", "Too many images in a minute. The rest keep their placeholders.");
    }

    try {
      const { bytes, contentType } = await fetchPublicImage(src, {
        maxBytes: PROXY_MAX_BYTES,
        timeoutMs: PROXY_TIMEOUT_MS,
        ...deps.fetchOptions,
      });
      // Private and short: it is the same picture the reviewer's browser just
      // loaded, cached for the next capture on this page and nowhere else.
      c.header("Cache-Control", "private, max-age=300");
      c.header("Content-Type", contentType);
      // An SVG is drawn through an <img>, where scripts do not run; the
      // policy makes sure that holds if anything ever opens it directly.
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      c.header("X-Content-Type-Options", "nosniff");
      return c.body(bytes as unknown as ArrayBuffer);
    } catch (e) {
      if (e instanceof PublicFetchError) return fail(c, STATUS[e.code], e.code, e.message);
      throw e;
    }
  });

  return app;
}

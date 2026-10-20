import { Hono, type Context } from "hono";
import type postgres from "postgres";
import { ID_PREFIX } from "@snagset/types/names";
import type { OwnerClaims } from "./owner.ts";

/**
 * Activity across every site, and the last thing.
 *
 * The maintainer, 2026-09-01: *"new activity across all projects, archive etc"*. The
 * shell has had a home (Sites) and a per-site inbox since, and nothing in
 * between: a studio with six clients had to open six inboxes to find out
 * whether anything had happened this morning. Sites answers "how many are
 * open", which is a number, not the thing that changed.
 *
 * One route, deliberately not the per-site list route with the uid made
 * optional. That one carries the widget's audience, the MCP scopes, rounds,
 * environments, `since` deltas and the privacy split, and every one of those
 * is a per-site concept. This is the studio's own feed: signed in, all sites
 * in the org, newest change first.
 *
 *   GET /api/v1/activity?status=&site=&q=&cursor=&limit=
 *
 * `?status=` takes one status, the word `unresolved` (the desk: everything
 * still in play) or `all`. That pair is the answer to "archive" without
 * inventing a column for it — a resolved thread IS the archive, and the two
 * views are one query apart.
 */

type Env = { Variables: { requestId: string; owner?: OwnerClaims } };
type Ctx = Context<Env>;

const STATUSES = ["open", "progress", "review", "resolved"] as const;
type Status = (typeof STATUSES)[number];
const isStatus = (s: string): s is Status => (STATUSES as readonly string[]).includes(s);

const MAX = 100;
const DEFAULT_LIMIT = 50;

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}

interface Row {
  id: string;
  key: string;
  status: string;
  route: string | null;
  updated_at: Date;
  created_at: Date;
  comment_total: number;
  project_uid: string;
  project_name: string;
  environment_key: string;
  created_by_name: string;
  created_by_kind: string;
  assignee_name: string | null;
  latest_body: string | null;
  latest_at: Date | null;
  latest_author: string | null;
}

export function activityRoutes(sql: postgres.Sql): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/api/v1/activity", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");

    const statusRaw = c.req.query("status")?.trim();
    if (statusRaw && statusRaw !== "all" && statusRaw !== "unresolved" && !isStatus(statusRaw)) {
      return fail(c, 400, "validation_failed", `status must be one of ${STATUSES.join(", ")}, or the word unresolved or all.`);
    }
    const site = c.req.query("site")?.trim();
    /**
     * `?q=` — the same three columns the per-site list searches (key, the
     * anchor's label, the comment bodies), so a studio-wide search and a
     * site's own search can never disagree about what matches. It is what
     * makes ⌘K able to find a comment when you remember the words and not
     * the site.
     */
    const q = (c.req.query("q") ?? "").trim();
    const limit = Math.min(MAX, Math.max(1, Number(c.req.query("limit")) || DEFAULT_LIMIT));

    /**
     * The cursor is the last row's `updated_at` and id, not an offset: rows
     * arrive while the reader is paging — that is the entire point of this
     * screen — and an offset would hand them a row twice or skip one.
     */
    const cursorRaw = c.req.query("cursor");
    let cursor: { at: Date; id: string } | null = null;
    if (cursorRaw) {
      const [at, id] = cursorRaw.split("|");
      const parsed = new Date(at ?? "");
      if (Number.isNaN(parsed.getTime()) || !id) {
        return fail(c, 400, "validation_failed", "cursor must be the `nextCursor` from a previous answer.");
      }
      cursor = { at: parsed, id };
    }

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${owner.orgId}, true)`;
      return tx<Row[]>`
        SELECT t.id, t.key, t.status, t.route, t.updated_at, t.created_at,
               -- The public reply total, counted (commentTotal in threads.ts,
               -- which the per-site list uses: the two screens must agree).
               -- No private-thread CASE here because the WHERE below already
               -- leaves private threads out of this feed.
               (SELECT count(*)::int FROM comments cc
                 WHERE cc.thread_id = t.id AND cc.deleted_at IS NULL AND cc.private = false) AS comment_total,
               p.uid AS project_uid, p.name AS project_name, e.key AS environment_key,
               r.name AS created_by_name, r.kind AS created_by_kind,
               ar.name AS assignee_name,
               lc.body AS latest_body, lc.created_at AS latest_at, lcr.name AS latest_author
          FROM threads t
          JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
          JOIN environments e ON e.id = t.environment_id
          JOIN reviewers r ON r.id = t.created_by
          LEFT JOIN reviewers ar ON ar.id = t.assignee_id
          -- The newest PUBLIC comment: an activity feed says what was said,
          -- and a team-only reply is the studio talking about the client.
          -- It is still the studio reading this screen, but a feed that
          -- quotes an internal note beside a client's words is how one gets
          -- pasted into the wrong window.
          LEFT JOIN LATERAL (
            SELECT c.body, c.created_at, c.author_id
              FROM comments c
             WHERE c.thread_id = t.id AND c.deleted_at IS NULL AND c.private = false
             ORDER BY c.seq DESC
             LIMIT 1
          ) lc ON true
          LEFT JOIN reviewers lcr ON lcr.id = lc.author_id
         WHERE t.org_id = ${owner.orgId}::uuid
           AND t.deleted_at IS NULL
           AND t.private = false
           ${site ? tx`AND p.uid = ${site}` : tx``}
           ${statusRaw === "unresolved" ? tx`AND t.status <> 'resolved'` : statusRaw && statusRaw !== "all" ? tx`AND t.status = ${statusRaw}::snag_thread_status` : tx``}
           ${
             q
               ? tx`AND (t.key ILIKE ${"%" + q + "%"}
                      OR t.anchor_label ILIKE ${"%" + q + "%"}
                      OR EXISTS (SELECT 1 FROM comments cq
                                 WHERE cq.thread_id = t.id AND cq.deleted_at IS NULL AND cq.private = false
                                   AND cq.body ILIKE ${"%" + q + "%"}))`
               : tx``
           }
           ${cursor ? tx`AND (t.updated_at, t.id) < (${cursor.at}, ${cursor.id}::uuid)` : tx``}
         ORDER BY t.updated_at DESC, t.id DESC
         LIMIT ${limit + 1}
      `;
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      data: page.map((r) => ({
        id: `${ID_PREFIX.thread}${r.id}`,
        key: r.key,
        status: r.status,
        route: r.route ?? "/",
        site: { uid: r.project_uid, name: r.project_name },
        environment: r.environment_key,
        createdBy: { name: r.created_by_name, kind: r.created_by_kind },
        assignee: r.assignee_name,
        commentCount: r.comment_total,
        latest: r.latest_body === null ? null : { body: r.latest_body, at: r.latest_at?.toISOString() ?? null, author: r.latest_author },
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? `${last.updated_at.toISOString()}|${last.id}` : null,
      serverTime: new Date().toISOString(),
    });
  });

  return app;
}

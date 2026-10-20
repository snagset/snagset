import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ID_PREFIX } from "@snagset/types/names";
import type { ProjectCache } from "../projectCache.ts";
import type { SessionClaims } from "../session.ts";
import type { OwnerClaims } from "./owner.ts";

/**
 * The assignee pool — (routes 19b and 19c).
 *
 * *Studio people ∪ everyone who has commented in the project.* Pastel assigns
 * to team members only; we widen it because the decision requires that a comment can be
 * assigned to the CLIENT to answer, and a pool that cannot name the client
 * cannot express that. The load-bearing half is the second: a reviewer
 * becomes assignable by the act of commenting, with no invitation step.
 *
 * Studio people are `reviewers` rows with `user_id` set, materialised on the
 * two dashboard writes that create them (`studioReviewers.ts`) — this route is
 * a pure read, as insists.
 */

type Env = {
  Variables: {
    requestId: string;
    session?: SessionClaims;
    owner?: OwnerClaims;
  };
};
type Ctx = Context<Env>;

export interface AssigneeDeps {
  sql: postgres.Sql;
  projects: ProjectCache;
}

/**
 * WHO IS IN THE POOL — the predicate, in one place, over an alias `r`.
 * Blocked and erased reviewers leave the pool but keep their existing
 * assignments (un-assigning on block would rewrite history on threads
 * somebody is mid-conversation on); a guest who exchanged a session but never
 * wrote is not in it (the matrix's "be assigned: ✓ once they have written").
 * The thread PATCH validates a candidate against the same predicate, which is
 * why it is exported rather than inlined in the query below.
 *
 * "HAS WRITTEN" IS ASKED OF THE ROWS, NOT A COUNTER. It was
 * `reviewers.thread_count > 0 OR comment_count > 0`, two totals bumped by the
 * thread and reply routes — which had already been found unmaintained once
 * (0005_studio_reviewers.sql had to backfill them). Now it is an EXISTS on
 * `threads_author` / `comments_author`, each one index probe. The columns stay
 * in the schema, unread, for one release so this one can be rolled back.
 *
 * DELETED ROWS COUNT. Once written, always in the pool: the counters were
 * bumped on every write and never taken back on a delete, so a client whose
 * only comment was later removed stayed assignable, and that is kept. (Only
 * 0005's one-time backfill skipped deleted rows; nothing live ever did.) A
 * pool that dropped someone because their snag was deleted would also strand
 * the assignments they already hold.
 */
export function inPool(t: postgres.TransactionSql) {
  return t`r.blocked_at IS NULL AND r.erased_at IS NULL
           AND (r.user_id IS NOT NULL OR r.invited_by IS NOT NULL
                OR EXISTS (SELECT 1 FROM threads pt WHERE pt.created_by = r.id)
                OR EXISTS (SELECT 1 FROM comments pc WHERE pc.author_id = r.id))`;
}

function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json(
    { error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } },
    status as 400,
  );
}

/** The `Reviewer`, plus the two derived flags the dropdown groups by. */
export function shapeReviewer(r: Record<string, unknown>, withEmail: boolean) {
  return {
    id: ID_PREFIX.reviewer + String(r["id"]),
    name: String(r["name"] ?? ""),
    kind: String(r["kind"] ?? "guest"),
    ...(withEmail && r["email"] ? { email: String(r["email"]) } : {}),
    ...(r["avatar_url"] ? { avatarUrl: String(r["avatar_url"]) } : {}),
    // Derived on the wire, not stored twice — so the dropdown can put "the
    // studio" above "people who have commented". NOT a permission.
    isTeam: !!r["is_team"],
    isMe: !!r["is_me"],
  };
}

export function assigneeRoutes(deps: AssigneeDeps): Hono<Env> {
  const { sql, projects } = deps;
  const app = new Hono<Env>();

  const inOrg = <T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      return fn(tx as postgres.TransactionSql);
    });

  app.get("/api/v1/projects/:uid/assignees", async (c) => {
    const p = await projects.get(c.req.param("uid"));
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const owner = c.get("owner");
    const session = c.get("session");
    const asOwner = !!owner && owner.orgId === p.org_id;
    if (!asOwner && !session) {
      return fail(c, 401, "unauthorized", "Open your review link, or reload the page, and try again.");
    }
    // Emails are for the people who can route work, not for a client reading
    // names: a link session sees who is in the pool, never the studio's
    // addresses.
    const mayAssign = asOwner || !!session?.perm.includes("thread:assign");
    // A prefix match on name and email — the pool is single- to double-digit
    // for this product's audience; a convenience, not a search feature.
    const q = (c.req.query("q") ?? "").trim().slice(0, 80);
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 200);

    const rows = await inOrg(p.org_id, (tx) =>
      tx<Record<string, unknown>[]>`
        SELECT r.id, r.name, r.email, r.kind, r.avatar_url,
               (r.user_id IS NOT NULL) AS is_team,
               ${asOwner ? tx`(r.user_id = ${owner!.userId}::uuid)` : tx`(r.id = ${session!.sub}::uuid)`} AS is_me,
               count(*) OVER () AS total
        FROM reviewers r
        WHERE r.project_id = ${p.id}::uuid
          AND ${inPool(tx)}
          ${q ? tx`AND (r.name ILIKE ${q + "%"} OR r.email ILIKE ${q + "%"})` : tx``}
        -- The studio first (you assign to a colleague more often than to
        -- anyone else), then most recently active, which puts the person who
        -- just commented at the top of the list you opened because they did.
        ORDER BY is_team DESC, r.last_seen_at DESC
        LIMIT ${limit}
      `,
    );
    c.header("Cache-Control", "private, max-age=30");
    return c.json({
      data: rows.map((r) => shapeReviewer(r, mayAssign)),
      total: Number(rows[0]?.["total"] ?? 0),
    });
  });

  /**
   * Naming a person who has not written yet — DESIGN.md Q4's *+ Add person*,
   * and the case the decision needs on day one: a question assigned to a client BEFORE
   * that client has said anything.
   *
   * A PLACEHOLDER: `kind='guest'`, no secret, `invited_by` set. A name to
   * assign to and not a credential — no exchange can ever authenticate as it.
   *
   * Dashboard only in v1. Also admits a session holding `thread:assign`,
   * but `invited_by` is a `users.id` and a team-link session carries no user;
   * refusing with a sentence beats inventing an inviter.
   */
  app.post("/api/v1/projects/:uid/assignees", async (c) => {
    const p = await projects.get(c.req.param("uid"));
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const owner = c.get("owner");
    const asOwner = !!owner && owner.orgId === p.org_id;
    if (!asOwner) {
      return fail(c, 403, "forbidden", "Adding a person to assign to is done from the dashboard.");
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) return fail(c, 400, "validation_failed", "Give the person a name.", { field: "name" });
    const emailRaw = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      return fail(c, 400, "validation_failed", "That does not look like an email address.", { field: "email" });
    }
    const email = emailRaw || null;

    const [row, created] = await inOrg(p.org_id, async (tx) => {
      if (email) {
        // The same person named twice is one person: an unerased row with
        // that address — a placeholder, a link reviewer, a studio member —
        // is returned rather than duplicated.
        const [same] = await tx<Record<string, unknown>[]>`
          SELECT r.id, r.name, r.email, r.kind, r.avatar_url, (r.user_id IS NOT NULL) AS is_team,
                 (r.user_id = ${owner!.userId}::uuid) AS is_me
          FROM reviewers r
          WHERE r.project_id = ${p.id}::uuid AND lower(r.email) = ${email} AND r.erased_at IS NULL
          ORDER BY r.last_seen_at DESC
          LIMIT 1
        `;
        if (same) return [same, false] as const;
      }
      const id = randomUUID();
      const [made] = await tx<Record<string, unknown>[]>`
        INSERT INTO reviewers (id, org_id, project_id, kind, name, email, invited_by)
        VALUES (${id}::uuid, ${p.org_id}::uuid, ${p.id}::uuid, 'guest', ${name}, ${email}, ${owner!.userId}::uuid)
        RETURNING id, name, email, kind, avatar_url, false AS is_team, false AS is_me
      `;
      return [made!, true] as const;
    });
    return c.json(shapeReviewer(row, true), created ? 201 : 200);
  });

  return app;
}

import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ID_PREFIX } from "@snagset/types/names";
import type { ProjectCache } from "../projectCache.ts";
import type { SessionClaims } from "../session.ts";
import { csrfOk, type OwnerClaims } from "./owner.ts";
import { can } from "@snagset/types/roles";
import type { McpClaims } from "./mcpToken.ts";
import {
  mcpAllows,
  scopeDenied,
  checkWriteBudget,
  budgetExhausted,
  recordAgentWrite,
  agentReviewer,
} from "./mcpAuth.ts";
import { studioReviewerId } from "../studioReviewers.ts";
import { queueCommentNotice } from "../mail/notify.ts";
import { inOrg, maintenance } from "../db/scope.ts";

/**
 * Comments — endpoint 11, the slice: `POST …/threads/{id}/comments`.
 *
 * TWO PATHS, ONE HANDLER. The canonical form is project-agnostic
 * `POST /api/v1/threads/{id}/comments` — because a thread id already implies
 * its project. That is the shape the dashboard uses. But the widget's `call()`
 * builds every URL as `root + path` where `root` is `.../projects/{uid}`
 * (`storage/http.ts`) — it has never had an absolute-path escape hatch, and
 * giving it one for this one route would be a second URL-building rule for a
 * client that otherwise has exactly one. So this route is ALSO mounted at
 * `/api/v1/projects/:uid/threads/:id/comments`, matching how `PATCH
 * …/projects/:uid/threads/:id` already works — same handler, and when `:uid`
 * is present it must match the thread's own project or the request 404s,
 * exactly as a wrong uid does everywhere else in this API.
 *
 * TWO CREDENTIALS, ONE ROUTE. A reviewer session and a studio owner cookie
 * both land here, which is why `requireOwner()` — built to gate a route ONE
 * credential ever reaches — cannot be mounted on this path: it would 401 every
 * reviewer's reply before the handler saw it. So the owner half of its check
 * (the CSRF pair) is run inline, via `csrfOk()`, only on the branch that found
 * an owner cookie.
 */

type Env = {
  Variables: {
    requestId: string;
    session?: SessionClaims;
    owner?: OwnerClaims;
    mcp?: McpClaims;
  };
};
type Ctx = Context<Env>;

function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json(
    { error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } },
    status as 400,
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function rowId(wire: unknown, prefix: string): string | null {
  if (typeof wire !== "string") return null;
  const bare = wire.startsWith(prefix) ? wire.slice(prefix.length) : wire;
  return UUID.test(bare) ? bare.toLowerCase() : null;
}

export interface CommentDeps {
  sql: postgres.Sql;
  /** Unused today — kept in the signature because every other route file
   *  taking a project uid takes the cache alongside `sql`, and a project
   *  lookup added here later (rate limiting, a features() gate) should not
   *  need a second wiring pass through app.ts. */
  projects: ProjectCache;
  /**
   * Is a mail transport configured ?
   *
   * Passed in rather than read here, and it gates the ENQUEUE rather than the
   * send. With no transport, the design requires notifications to be "off and say
   * so, rather than silently queueing" — so queueing anyway and dropping it at
   * delivery would satisfy the letter and miss the point: the rows would
   * accumulate for the life of the install, and the first thing an operator who
   * later configures Resend would get is every notification since the
   * beginning of time, in one burst.
   */
  /** Asked per write: a transport connected on Studio › General counts from its next send. */
  notifications: () => Promise<boolean>;
}

export function commentRoutes(deps: CommentDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { sql } = deps;

  const handle = async (c: Ctx) => {
    const threadRow = rowId(c.req.param("id"), ID_PREFIX.thread);
    if (!threadRow) return fail(c, 404, "thread_not_found", "No such thread.");

    const [thread] = await maintenance(sql, (tx) => tx<
      {
        id: string;
        project_id: string;
        org_id: string;
        private: boolean;
        project_uid: string;
        project_status: string;
        key: string;
        page_url: string | null;
      }[]
    >`
      SELECT t.id, t.project_id, t.org_id, t.private, p.uid AS project_uid, p.status AS project_status,
             t.key,
             -- The page URL lives INSIDE the capture context, not in a column
             -- of its own. Two arrows, not one, so it arrives as
             -- text rather than as a JSON-quoted string.
             t.context->>'url' AS page_url
      FROM threads t JOIN projects p ON p.id = t.project_id
      WHERE t.id = ${threadRow}::uuid AND t.deleted_at IS NULL
    `);
    if (!thread) return fail(c, 404, "thread_not_found", "No such thread.");

    // The widget's URL always carries `:uid`; the dashboard's canonical form
    // never does. When it is present it must be THIS thread's project — a uid
    // that resolves to a different project is treated the same as a thread
    // that does not exist, not as a permission question, so a uid's validity
    // leaks nothing about a thread that belongs to somebody else's project.
    const uidParam = c.req.param("uid");
    if (uidParam && uidParam !== thread.project_uid) {
      return fail(c, 404, "thread_not_found", "No such thread in this project.");
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

    // Same refusal PATCH already gives a caller that tries to move a
    // thread's round: a comment does not choose one either. `attachmentIds` is
    // the bind-at-write path (`threads.ts`'s `bound` CTE); this route
    // does not implement it yet, and accepting-then-dropping it would leave a
    // reviewer believing their screenshot attached when it never bound to
    // anything (the `field_not_permitted` is the code for "refused, not
    // silently ignored"). `mentions` is genuinely inert for now
    // parses it from `body` at write time server-side, so a client
    // sending it costs nothing and is left for that later slice to wire up.
    for (const field of ["round", "roundId", "roundNumber", "attachmentIds"]) {
      if (body && field in body) {
        return fail(c, 422, "field_not_permitted", `"${field}" is not accepted on this route yet.`, {
          field,
        });
      }
    }

    const owner = c.get("owner");
    const session = c.get("session");
    const mcp = c.get("mcp");
    const asOwner = !!owner && owner.orgId === thread.org_id;
    const asSession = !!session && session.aud === thread.project_uid && session.perm.includes("comment:create");

    /**
     * THREE CREDENTIALS NOW. `comment_on_thread` is one half of an
     * agent's entire write surface — the other is `mark_ready` — and it lands
     * on this handler like everyone else, because the design is explicit that MCP
     * *"is not a second API"*.
     */
    const asAgent = mcpAllows(mcp, thread.org_id, "comments:write");
    if (mcp && !asAgent) return scopeDenied(c, "comments:write");

    if (!asOwner && !asSession && !asAgent) {
      if (!owner && !session && !mcp) {
        return fail(c, 401, "unauthorized", "Sign in, or open your review link, and try again.");
      }
      return fail(
        c,
        403,
        "forbidden",
        owner ? "You cannot comment on another org's project." : "This review link does not allow replies.",
      );
    }

    /**
     * An agent may not reply on a thread the studio marked private, even
     * holding `comments:write`.
     *
     * The same argument as the read side: `private` is the studio talking
     * about the client, and the agent's reply would join that conversation
     * having read none of it (this route's caller cannot see private comments
     * either). Refused rather than silently made public, because a comment
     * that lands somewhere other than where it was addressed is worse than one
     * that does not land.
     */
    if (asAgent && !asOwner && thread.private) {
      return fail(c, 403, "forbidden", "This thread is team-only. An agent cannot reply on it.");
    }

    // The widget switch. A paused site refuses the WIDGET's writes (
    // layer 6, `project_paused`); the studio's own replies from the
    // dashboard go on, because the switch is about the client's page, not
    // about the team's triage of what already arrived.
    if (asSession && !asOwner && thread.project_status !== "active") {
      return fail(c, 403, "project_paused", "This site's widget is switched off. Its owner can switch it back on.");
    }

    // The write budget, checked before the write.
    if (asAgent && !asOwner && !asSession) {
      const spent = await checkWriteBudget(sql, mcp!.tokenId);
      if (spent !== null) return budgetExhausted(c);
    }

    // The CSRF half of `requireOwner()`, run by hand — see the file header for
    // why that middleware cannot be mounted on a path a reviewer session also
    // posts to. Every branch that reaches here is a mutation (POST-only route).
    if (asOwner && !csrfOk(c)) {
      return fail(c, 403, "csrf_failed", "That request could not be verified. Reload the dashboard and try again.");
    }
    // Replying is a review act — owner, admin, member. Written down
    // rather than left to "any cookie of this org", which a viewer would hold.
    if (asOwner && !asSession && !asAgent && !can(owner!.role, "review")) {
      return fail(c, 403, "forbidden", "Your role in this studio cannot comment.");
    }

    // TEAM-ONLY REPLY. Studio-only to set, same as a
    // thread's own `private` — an owner always may; a session needs the link
    // permission that names it, exactly like `thread:assign`/`thread:private`
    // gate the thread-level fields.
    //
    // A thread that is ALREADY private forces every reply on it private too —
    // the design is explicit that the field is then ignored, not merely defaulted.
    // The first cut read `thread.private` off the row and never used it, so
    // `wantPrivate` came only from the body: a reviewer session replying on a
    // private thread with no `private` field in the body got a PUBLIC comment
    // stored on a thread the client should never have been able to see existed,
    // and the 403 below fired only when the body explicitly asked for private
    // — never when the thread's own privacy should have applied silently.
    const wantPrivate = thread.private || body?.private === true;
    // `session!` below is safe only because an agent is excluded first: an MCP
    // caller has no session at all, so the non-null assertion would have thrown
    // a 500 on `session!.perm` the first time an agent sent `private: true`.
    // It may not set the field regardless — a team-only reply is the studio's
    // register, and the design is emphatic that an agent write is never laundered
    // into a trust tier it did not earn.
    if (asAgent && !asOwner && body?.private === true) {
      return fail(c, 403, "field_not_permitted", "An agent cannot post a team-only reply.", {
        field: "private",
      });
    }
    if (!thread.private && body?.private === true && !asOwner && !session!.perm.includes("thread:private")) {
      return fail(c, 403, "field_not_permitted", "This review link does not allow team-only replies.", {
        field: "private",
      });
    }

    const commentBody = typeof body?.body === "string" ? body.body : "";
    if (!commentBody) return fail(c, 400, "validation_failed", "body is required.");
    // The budget, enforced here rather than left to the CHECK: a client
    // gets a code it can act on instead of a raw constraint-violation 500.
    if (commentBody.length > 10_000) {
      return fail(c, 400, "body_too_large", "A comment may be at most 10,000 characters.");
    }

    const commentId = body?.id === undefined ? randomUUID() : rowId(body.id, ID_PREFIX.comment);
    if (!commentId) {
      return fail(c, 400, "validation_failed", `id must be a UUIDv7, optionally prefixed "${ID_PREFIX.comment}".`);
    }

    /**
     * A RETRY IS NOT AN ERROR — the same measured bug as `POST /threads`.
     *
     * A client-minted comment id sent twice hit the primary key and came back
     * `500 internal_error`, with the reply already stored. On the reply
     * composer that is a double-tapped Send, or a connection that dropped
     * between the write and the response — and the reviewer is told their
     * reply was lost while it sits in the thread.
     *
     * Checked BEFORE the write here rather than caught after, unlike the
     * thread route, because this transaction also bumps two counters and
     * queues a notification: relying on the whole thing rolling back to keep
     * those correct is a much larger claim than relying on one INSERT to fail.
     * The cost is one indexed lookup on a route that is not the hot path.
     */
    const [alreadyThere] = await inOrg(sql, thread.org_id, (tx) => tx<{ id: string; body: string; created_at: Date }[]>`
      SELECT id, body, created_at FROM comments
       WHERE id = ${commentId}::uuid AND thread_id = ${thread.id}::uuid AND deleted_at IS NULL
    `);
    if (alreadyThere) {
      const [author] = await inOrg(sql, thread.org_id, (tx) => tx<{ id: string; name: string; kind: string }[]>`
        SELECT r.id, r.name, r.kind FROM reviewers r
          JOIN comments c ON c.author_id = r.id WHERE c.id = ${commentId}::uuid
      `);
      return c.json(
        {
          id: ID_PREFIX.comment + alreadyThere.id,
          body: alreadyThere.body,
          createdAt: alreadyThere.created_at.toISOString(),
          author: {
            id: ID_PREFIX.reviewer + author!.id,
            name: author!.name,
            kind: author!.kind,
          },
        },
        // 200, not 201: this request created nothing.
        200,
      );
    }

    const created = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${thread.org_id}, true)`;

      // The author. A session's `sub` IS a `reviewers.id` — nothing
      // to resolve. An OWNER has no reviewer row yet the first time they post
      // from the dashboard, so one is found-or-created here: `kind='verified'`
      // with `user_id` set satisfies 0001_init.sql's CHECK on that kind
      // without a `holder_secret_hash`, which only non-verified kinds need.
      let reviewerId: string;
      if (session) {
        reviewerId = session.sub;
      } else if (asAgent && !asOwner) {
        // The representation, via the one helper that knows it:
        // kind='guest', is_agent, agent_mcp_token_id. NEVER 'verified'.
        reviewerId = await agentReviewer(tx, {
          orgId: thread.org_id,
          projectId: thread.project_id,
          tokenId: mcp!.tokenId,
          tokenName: mcp!.name,
        });
      } else {
        // The owner's own reviewer row in this project — materialised on
        // project and membership create, found-or-created here for
        // anything older (studioReviewers.ts).
        const o = owner!;
        reviewerId = await studioReviewerId(tx, {
          orgId: thread.org_id,
          projectId: thread.project_id,
          userId: o.userId,
          name: o.name,
          email: o.email,
        });
      }

      // The thread row, locked: two replies landing at once serialise here
      // instead of racing to the same `seq` (verbatim). Nothing is read
      // from it any more — it used to carry the reply counters this route
      // bumped, which are now counted from `comments` where they are read
      // (commentTotal in threads.ts) — but the lock is the point, and
      // MAX(seq) below is only safe under it.
      await tx`SELECT 1 FROM threads WHERE id = ${thread.id}::uuid FOR UPDATE`;
      // `seq` follows the highest one ever used, deleted rows included — NOT
      // the live count + 1. A deleted reply keeps its row (and its seq) but
      // takes one off the count, so the count-based seq collided with it on
      // UNIQUE (thread_id, seq): every reply after a delete was a 500.
      const [top] = await tx<{ seq: number }[]>`
        SELECT COALESCE(MAX(seq), 0)::int AS seq FROM comments WHERE thread_id = ${thread.id}::uuid
      `;
      const seq = top!.seq + 1;

      const [comment] = await tx<{ id: string; body: string; created_at: Date }[]>`
        INSERT INTO comments (id, org_id, project_id, thread_id, seq, author_id, body, private)
        VALUES (${commentId}::uuid, ${thread.org_id}::uuid, ${thread.project_id}::uuid, ${thread.id}::uuid,
                ${seq}, ${reviewerId}::uuid, ${commentBody}, ${wantPrivate})
        RETURNING id, body, created_at
      `;

      await tx`
        UPDATE threads
        SET version = version + 1,
            updated_at = now()
        WHERE id = ${thread.id}::uuid
      `;
      // The author, seen now — which floats whoever just wrote to the top of
      // the assignee pool. Being IN the pool used to need this row's
      // comment_count bumped too; the pool now asks `comments` directly
      // (inPool in assignees.ts), so the reply inserted above is the
      // membership.
      await tx`
        UPDATE reviewers SET last_seen_at = now()
        WHERE id = ${reviewerId}::uuid
      `;

      const [author] = await tx<{ id: string; name: string; kind: string }[]>`
        SELECT id, name, kind FROM reviewers WHERE id = ${reviewerId}::uuid
      `;

      // In THIS transaction — so the audit row and the
      // comment it records commit together and the budget above can never see
      // fewer writes than actually happened.
      if (asAgent && !asOwner && !asSession) {
        await recordAgentWrite(tx, {
          orgId: thread.org_id,
          projectId: thread.project_id,
          type: "comment.created",
          subjectType: "comment",
          subjectId: comment!.id,
          reviewerId,
          tokenId: mcp!.tokenId,
        });
      }

      /**
       * The notification, queued in THIS transaction.
       *
       * A comment that commits without its outbox row is a notification that
       * never happens; a row that commits without its comment is mail about
       * something that does not exist. One transaction rules out both, and it
       * is the reason `queueCommentNotice` takes `tx` rather than a pool.
       *
       * PRIVATE COMMENTS ARE NOT MAILED. A private reply is visible only to
       * the owner's side of the conversation, and while the owner is exactly
       * who this mail goes to, the body would then sit in an inbox — and in
       * whatever forwards, backs up or indexes it — for a comment the product
       * promises is private. Not worth the surprise for a notification.
       */
      if (!wantPrivate && (await deps.notifications())) {
        await queueCommentNotice(
          tx,
          {
            orgId: thread.org_id,
            projectId: thread.project_id,
            threadId: thread.id,
            commentId: comment!.id,
            threadKey: thread.key,
            authorId: reviewerId,
            authorName: author?.name ?? "Someone",
            body: comment!.body,
            pageUrl: thread.page_url ?? "",
          },
          randomUUID(),
        );
      }

      return { comment: comment!, author: author! };
    });

    // The SAME shape the list route embeds per comment (`threads.ts`'s
    // `shape()`) — a client merging this response into a thread it already
    // holds must not learn a different Comment type depending on which route
    // produced it.
    return c.json(
      {
        id: ID_PREFIX.comment + created.comment.id,
        body: created.comment.body,
        createdAt: created.comment.created_at.toISOString(),
        author: {
          id: ID_PREFIX.reviewer + created.author.id,
          name: created.author.name,
          kind: created.author.kind,
        },
      },
      201,
    );
  };

  app.post("/api/v1/threads/:id/comments", handle);
  app.post("/api/v1/projects/:uid/threads/:id/comments", handle);

  return app;
}

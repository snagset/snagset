import { Hono, type Context } from "hono";
import type postgres from "postgres";
import { ID_PREFIX } from "@snagset/types/names";
import type { SessionClaims } from "../session.ts";
import { csrfOk, type OwnerClaims } from "./owner.ts";
import { can } from "@snagset/types/roles";
import { isStudioModerator } from "../studioReviewers.ts";
import { maintenance } from "../db/scope.ts";

/**
 * Editing and deleting a comment — 05 endpoints 12 and 13, the tombstone.
 *
 * ── THE BUTTONS WERE ALREADY THERE ──
 *
 * The detail panel has rendered **Edit** and **Delete**, and the
 * HTTP adapter answered both with `501 not_implemented`. So on any
 * server-backed install — which is every real one — a reviewer who made a typo
 * clicked Edit and got an error. The local adapter implements both, which is
 * why the panel was built against them and why nothing caught it: the demo
 * works and the product does not.
 *
 * ── WHO MAY ──
 *
 * *"Guests can edit and delete only their own comments, within 15 minutes
 * of creation."* An OWNER or ADMIN of the org may delete anything, a MEMBER
 * only their own, and none of them may edit anyone else's words — putting text in somebody's mouth under their name is
 * not a moderation power, it is a forgery, and the honest tool for an unwanted
 * comment is deletion.
 *
 * The window is 15 minutes because this is a correction affordance, not a
 * revision history. A comment somebody has already read and acted on should not
 * silently become a different comment.
 *
 * ── DELETE IS A TOMBSTONE, NOT A ROW REMOVAL ──
 *
 * The row is kept, `body → NULL`, `deleted_at` set, and the API returns
 * `{ id, deletedAt, author: { name }, body: null }`. The thread's shape
 * survives — a conversation with a hole in it still reads as a conversation,
 * and `seq` stays server-side so a client cannot count what it may not read.
 */

type Env = {
  Variables: {
    requestId: string;
    session?: SessionClaims;
    owner?: OwnerClaims;
  };
};
type Ctx = Context<Env>;

/** The author window. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

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

export interface CommentEditDeps {
  sql: postgres.Sql;
  now?: () => Date;
}

interface Row {
  id: string;
  org_id: string;
  project_id: string;
  thread_id: string;
  author_id: string;
  body: string | null;
  private: boolean;
  created_at: Date;
  deleted_at: Date | null;
  thread_private: boolean;
  thread_deleted_at: Date | null;
  author_name: string;
  author_kind: string;
  /** The studio member behind the author row, when there is one — see `refuse()`. */
  author_user_id: string | null;
}

export function commentEditRoutes(deps: CommentEditDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { sql } = deps;
  const now = deps.now ?? (() => new Date());

  /** The comment, its author and its thread's privacy, in one round trip. */
  async function load(wire: string | undefined): Promise<Row | null> {
    const id = rowId(wire, ID_PREFIX.comment);
    if (!id) return null;
    const [row] = await maintenance(sql, (tx) => tx<Row[]>`
      SELECT c.id, c.org_id, c.project_id, c.thread_id, c.author_id, c.body, c.private,
             c.created_at, c.deleted_at,
             t.private AS thread_private, t.deleted_at AS thread_deleted_at,
             r.name AS author_name, r.kind AS author_kind, r.user_id AS author_user_id
        FROM comments c
        JOIN threads t ON t.id = c.thread_id
        JOIN reviewers r ON r.id = c.author_id
       WHERE c.id = ${id}::uuid
    `);
    return row ?? null;
  }

  /**
   * Can this caller act on this comment, and how?
   *
   * Returns the reason it cannot, or null. Deliberately one function for both
   * routes: "who owns a comment" answered in two places is how the two answers
   * drift, and the drift is always in the permissive direction.
   */
  function refuse(c: Ctx, row: Row, action: "edit" | "delete", moderator = false): Response | null {
    const owner = c.get("owner");
    const session = c.get("session");
    const asOwner = !!owner && owner.orgId === row.org_id;
    /**
     * TWO ways to be the author, because there are two identity systems.
     *
     * A reviewer session's `sub` IS a `reviewers.id`. An owner has no `sub`:
     * a dashboard reply is written under the studio member's own reviewer row
     * (`studioReviewerId`, `user_id` set), so the owner is the author when THAT
     * row's `user_id` is theirs. This used to read only the session half, so
     * an owner could never edit their own reply — the "edit only their own"
     * rule below was "edit nothing" for every dashboard comment ever written.
     */
    const isAuthor =
      (!!session && session.sub === row.author_id) ||
      (asOwner && !!row.author_user_id && row.author_user_id === owner!.userId);

    if (!asOwner && !session) {
      return fail(c, 401, "unauthorized", "Sign in, or open your review link, and try again.");
    }

    // The owner cookie's half of `requireOwner()`, run inline — this path is
    // also reached by a reviewer session, so the middleware cannot be mounted.
    if (asOwner && !csrfOk(c)) {
      return fail(c, 403, "csrf_failed", "That request could not be verified. Reload the dashboard and try again.");
    }

    if (asOwner) {
      /**
       * An owner or an admin may DELETE anything and EDIT only their own; a
       * member edits and deletes only their own — deleting somebody
       * else's words is moderation (`moderate`), and a viewer does neither.
       *
       * Editing somebody else's words while their name stays on them is not a
       * moderation power, it is a forgery — and the honest tool for a comment
       * the studio does not want is the one next to it.
       */
      if (!can(owner!.role, "review")) return fail(c, 403, "forbidden", "Your role in this studio cannot change comments.");
      if (isAuthor) return null;
      if (action === "delete") {
        return can(owner!.role, "moderate")
          ? null
          : fail(c, 403, "forbidden", "Only an owner or an admin can delete somebody else's comment.");
      }
      return fail(
        c,
        403,
        "forbidden",
        can(owner!.role, "moderate")
          ? "You can delete this comment, but not rewrite it — it would still carry its author's name."
          : "You can only change your own comments.",
      );
    }

    // A studio owner or admin signed in from the widget has the
    // dashboard's power and the dashboard's limit: delete anything, rewrite
    // only their own.
    if (moderator && action === "delete") return null;

    if (!isAuthor) {
      // Not "you may not": a reviewer cannot be told which comments exist and
      // belong to somebody else.
      return fail(c, 403, "forbidden", "You can only change your own comments.");
    }

    // The window. A comment somebody has already read and acted on must not
    // silently become a different comment.
    const age = now().getTime() - row.created_at.getTime();
    if (age > EDIT_WINDOW_MS) {
      return fail(
        c,
        403,
        "edit_window_expired",
        `Comments can be changed for ${EDIT_WINDOW_MS / 60000} minutes after they are written. ` +
          `Add a reply instead — it keeps the conversation readable.`,
      );
    }
    return null;
  }

  /** The wire shape, for a live comment or a tombstone. */
  const shape = (row: { id: string; body: string | null; created_at?: Date; deleted_at: Date | null;
                        author_name: string; author_kind: string; author_id: string }) =>
    row.deleted_at
      ? {
          id: ID_PREFIX.comment + row.id,
          deletedAt: row.deleted_at.toISOString(),
          body: null,
          // The NAME survives, so the conversation still reads. Nothing else
          // does — and `seq` is not here, because with private replies
          // interleaved it would let a client count what it cannot read.
          author: { name: row.author_name },
        }
      : {
          id: ID_PREFIX.comment + row.id,
          body: row.body,
          ...(row.created_at ? { createdAt: row.created_at.toISOString() } : {}),
          author: {
            id: ID_PREFIX.reviewer + row.author_id,
            name: row.author_name,
            kind: row.author_kind,
          },
        };

  /** Endpoint 12 — `PATCH /api/v1/comments/{id}`. */
  const patch = async (c: Ctx) => {
    const row = await load(c.req.param("id"));
    // A comment in a DELETED thread is gone with it. Without this a stale tab
    // could edit words nobody can read any more, and the edit would bump the
    // dead thread's `updated_at` for nothing.
    if (!row || row.deleted_at || row.thread_deleted_at) return fail(c, 404, "comment_not_found", "No such comment.");

    const refused = refuse(c, row, "edit");
    if (refused) return refused;

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const next = typeof body?.["body"] === "string" ? body["body"] : "";
    if (!next.trim()) return fail(c, 400, "validation_failed", "body is required.");
    if (next.length > 10_000) {
      return fail(c, 400, "body_too_large", "A comment may be at most 10,000 characters.");
    }
    // `private` is not editable here. Changing a reply's audience after people
    // have read it is a different decision from fixing its words, and folding
    // them into one route means a typo correction can silently change who can
    // see it.
    if (body && "private" in body) {
      return fail(c, 422, "field_not_permitted", "A comment's audience is not changed by editing it.", {
        field: "private",
      });
    }

    const [updated] = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${row.org_id}, true)`;
      // `version` and `updated_at` on the THREAD, so a `?since=` poll carries
      // the edit. Without this the corrected text would reach nobody until
      // something else touched the thread.
      await tx`
        UPDATE threads SET version = version + 1, updated_at = now() WHERE id = ${row.thread_id}::uuid
      `;
      return tx<Row[]>`
        UPDATE comments SET body = ${next}, edited_at = now()
         WHERE id = ${row.id}::uuid
        RETURNING id, body, created_at, deleted_at,
                  ${row.author_id}::uuid AS author_id,
                  ${row.author_name}::text AS author_name,
                  ${row.author_kind}::text AS author_kind
      `;
    });

    return c.json({ ...shape(updated!), editedAt: new Date().toISOString() });
  };

  /** Endpoint 13 — `DELETE /api/v1/comments/{id}`. */
  const remove = async (c: Ctx) => {
    const row = await load(c.req.param("id"));
    // Same as the edit: the thread's deletion took its comments with it.
    if (!row || row.thread_deleted_at) return fail(c, 404, "comment_not_found", "No such comment.");
    // Deleting twice is the same outcome as deleting once, and a reviewer who
    // taps twice on a slow connection should not see an error for getting what
    // they asked for.
    if (row.deleted_at) return c.json(shape(row));

    const session = c.get("session");
    const moderator =
      !!session && session.sub !== row.author_id &&
      (await maintenance(sql, (tx) => isStudioModerator(tx, row.org_id, session.sub)));
    const refused = refuse(c, row, "delete", moderator);
    if (refused) return refused;

    const [tombstone] = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${row.org_id}, true)`;
      /**
       * The thread moves, in the same transaction as the tombstone, so a poll
       * picks the deletion up.
       *
       * No counters. This used to decrement `comment_count` and
       * `comment_count_public` by hand, and getting the private case wrong was
       * invisible until a thread showed "3 replies" above two of them. The
       * reply total is now counted from the live comments wherever it is read
       * (commentTotal in threads.ts), so the tombstone below IS the decrement.
       */
      await tx`
        UPDATE threads
           SET version = version + 1,
               updated_at = now()
         WHERE id = ${row.thread_id}::uuid
      `;
      return tx<Row[]>`
        UPDATE comments SET body = NULL, deleted_at = now()
         WHERE id = ${row.id}::uuid
        RETURNING id, body, created_at, deleted_at,
                  ${row.author_id}::uuid AS author_id,
                  ${row.author_name}::text AS author_name,
                  ${row.author_kind}::text AS author_kind
      `;
    });

    return c.json(shape(tombstone!));
  };

  // The canonical unscoped form, plus the project-scoped one the widget's URL
  // builder produces — the same pairing `comments.ts` documents, and for the
  // same reason: the widget builds every URL as root + path.
  app.patch("/api/v1/comments/:id", patch);
  app.patch("/api/v1/projects/:uid/comments/:id", patch);
  app.delete("/api/v1/comments/:id", remove);
  app.delete("/api/v1/projects/:uid/comments/:id", remove);

  return app;
}

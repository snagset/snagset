import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ID_PREFIX } from "@snagset/types/names";
import type { ProjectCache } from "../projectCache.ts";
import type { OwnerClaims } from "./owner.ts";
import { inOrg } from "../db/scope.ts";
import { softDeleteThreads } from "./threads.ts";

/**
 * Rounds.
 *
 * *"A round is a period of time, not a frozen artefact."* Pastel snapshots the
 * site per round because it is a proxy holding a copy; we review the live site,
 * so a round is a boundary drawn across the comments rather than a second copy
 * of the page. Cheaper, and more honest about what it is.
 *
 * The model in one paragraph: a project has rounds, the latest OPEN one is
 * where new threads land, a thread belongs to exactly one round and NEVER
 * moves, and starting round 2 leaves the page visually clean without deleting
 * anything. The rejected alternative is written down in so it is not
 * re-proposed — carrying unresolved pins forward defeats the entire point,
 * because a clean page is what the studio is buying.
 *
 * THE SAFEGUARD IS PART OF THE FEATURE, not a nicety layered on it: without a
 * standing "4 unresolved in Round 1" the model turns a clean board into a LOST
 * board, and that is its one real failure mode. It is why `unresolved` is
 * computed here, per round, on the list — never client-side from a page of
 * threads the client happens to be holding.
 *
 * ROUNDS RUN SIDE BY SIDE. "Internal QA" stays open while "Client QA"
 * runs, so starting a round no longer closes the others, and a new thread
 * lands in the round its author is looking at (threads.ts). Managing them is
 * the site's Settings: rename, close and reopen, archive and restore (put
 * away, threads untouched), and delete (the round AND its threads, softly,
 * after typing its name). Those are owner and admin acts; starting a round is
 * open to anyone signed in to the studio, as it always was. One guard holds
 * across all of them: the last open, unarchived round cannot be closed,
 * archived or deleted, because the next comment would have nowhere to go.
 */

type Env = { Variables: { requestId: string; owner?: OwnerClaims } };
type Ctx = Context<Env>;

export interface RoundDeps {
  sql: postgres.Sql;
  projects: ProjectCache;
}

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rowId = (wire: string): string | null => {
  const bare = wire.startsWith(ID_PREFIX.round) ? wire.slice(ID_PREFIX.round.length) : wire;
  return UUID.test(bare) ? bare.toLowerCase() : null;
};

interface Row {
  id: string;
  number: number;
  name: string;
  closed_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  threads: number;
  unresolved: number;
}

const shape = (r: Row) => ({
  id: ID_PREFIX.round + r.id,
  number: r.number,
  name: r.name,
  closed: !!r.closed_at,
  closedAt: r.closed_at?.toISOString(),
  // Put away. Listed here (the studio's Settings shows it, with
  // Restore); absent from the widget's config and the round menu.
  archived: !!r.archived_at,
  archivedAt: r.archived_at?.toISOString(),
  createdAt: r.created_at.toISOString(),
  threads: r.threads,
  // The safeguard, server-computed. A closed round still reports this — the
  // whole point is that closing a round must not make its unfinished work
  // disappear from view.
  unresolved: r.unresolved,
});

/**
 * Rename, close, reopen, archive, restore and delete: an owner's or an
 * admin's. A member or a viewer may start a round and switch between them,
 * never reshape the list everybody else is working in.
 */
const manages = (owner: OwnerClaims): boolean => owner.role === "owner" || owner.role === "admin";

const LAST_OPEN = "Open another round first. This is the last open round, and new comments would have nowhere to go.";

export function roundRoutes(deps: RoundDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { sql, projects } = deps;

  /** Owner-only, and owner OF THIS PROJECT. Returns the project or null. */
  const owned = async (c: Ctx) => {
    const uid = c.req.param("uid");
    if (!uid) return null;
    const p = await projects.get(uid).catch(() => null);
    if (!p) return null;
    const owner = c.get("owner");
    return owner && owner.orgId === p.org_id ? p : null;
  };

  /** Every round on the project, newest first, each with its counts. */
  app.get("/api/v1/projects/:uid/rounds", async (c) => {
    const p = await owned(c);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const rows = await inOrg(sql, p.org_id, (tx) => tx<Row[]>`
      SELECT r.id, r.number, r.name, r.closed_at, r.archived_at, r.created_at,
             count(t.id)::int AS threads,
             count(t.id) FILTER (WHERE t.status <> 'resolved')::int AS unresolved
      FROM rounds r
      LEFT JOIN threads t ON t.round_id = r.id AND t.deleted_at IS NULL
      WHERE r.project_id = ${p.id} AND r.deleted_at IS NULL
      GROUP BY r.id
      ORDER BY r.number DESC
    `);
    return c.json({ data: rows.map(shape) });
  });

  /**
   * Open a new round. The others are LEFT AS THEY ARE: until then the
   * previous open round was closed in the same transaction, because one
   * active round was the model and two open rounds had no answer to "where
   * does the next thread go". They have one now — the round its author is
   * looking at — so a studio can keep its own QA pass open beside the
   * client's.
   *
   * Numbering is max + 1 over EVERY row, deleted ones included, so a deleted
   * round's number is never handed out again (a "Round 3" quoted in an old
   * email stays unambiguous). The project row is locked first, as thread keys
   * do, so two rounds started at once queue rather than collide on
   * UNIQUE (project_id, number).
   */
  app.post("/api/v1/projects/:uid/rounds", async (c) => {
    const p = await owned(c);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
    const owner = c.get("owner")!;

    const row = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${p.org_id}, true)`;
      await tx`SELECT id FROM projects WHERE id = ${p.id}::uuid FOR UPDATE`;
      const [next] = await tx<{ n: number }[]>`
        SELECT COALESCE(max(number), 0) + 1 AS n FROM rounds WHERE project_id = ${p.id}
      `;
      const number = next!.n;
      const id = randomUUID();
      const [created] = await tx<Row[]>`
        INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
        VALUES (${id}::uuid, ${p.org_id}::uuid, ${p.id}::uuid, ${number}::int,
                ${name || `Round ${number}`}::text, ${owner.userId}::uuid)
        RETURNING id, number, name, closed_at, archived_at, created_at, 0::int AS threads, 0::int AS unresolved
      `;
      return created!;
    });
    return c.json(shape(row), 201);
  });

  /**
   * The round being changed, locked, and whether it is the project's LAST
   * open, unarchived round — the one fact every guard below asks. The project
   * row is locked first so two people closing the last two open rounds at the
   * same moment queue, and the second is refused, instead of both passing a
   * check that each one's own write was about to falsify.
   */
  async function lockRound(tx: postgres.TransactionSql, orgId: string, id: string) {
    const [r] = await tx<{ project_id: string; name: string; live: boolean }[]>`
      SELECT project_id, name, (closed_at IS NULL AND archived_at IS NULL) AS live
      FROM rounds WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid AND deleted_at IS NULL
    `;
    if (!r) return null;
    await tx`SELECT id FROM projects WHERE id = ${r.project_id}::uuid FOR UPDATE`;
    const [o] = await tx<{ others: number }[]>`
      SELECT count(*)::int AS others FROM rounds
      WHERE project_id = ${r.project_id}::uuid AND id <> ${id}::uuid
        AND deleted_at IS NULL AND closed_at IS NULL AND archived_at IS NULL
    `;
    return { ...r, last: r.live && o!.others === 0 };
  }

  const counted = (tx: postgres.TransactionSql, id: string) => tx<Row[]>`
    SELECT r.id, r.number, r.name, r.closed_at, r.archived_at, r.created_at,
           (SELECT count(*)::int FROM threads t WHERE t.round_id = r.id AND t.deleted_at IS NULL) AS threads,
           (SELECT count(*)::int FROM threads t
             WHERE t.round_id = r.id AND t.deleted_at IS NULL AND t.status <> 'resolved') AS unresolved
    FROM rounds r WHERE r.id = ${id}::uuid
  `;

  /**
   * Rename, close, reopen, archive or restore. Never renumber, and never move
   * threads: `number` is display order minted once, and a thread's round is
   * immutable. Archiving leaves `closed_at` alone and restoring clears
   * only `archived_at`, so a round comes back exactly as it was put away.
   */
  app.patch("/api/v1/rounds/:id", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    if (!manages(owner)) return fail(c, 403, "forbidden", "Only an owner or an admin can change a round.");
    const id = rowId(c.req.param("id"));
    if (!id) return fail(c, 404, "not_found", "No such round.");
    const body = (await c.req.json().catch(() => null)) as
      | { name?: unknown; closed?: unknown; archived?: unknown }
      | null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : null;
    const closed = typeof body?.closed === "boolean" ? body.closed : null;
    const archived = typeof body?.archived === "boolean" ? body.archived : null;
    if (name === null && closed === null && archived === null) {
      return fail(c, 400, "validation_failed", "Send a name, closed: true/false, or archived: true/false.");
    }
    if (name !== null && !name) return fail(c, 400, "validation_failed", "A round needs a name.");

    const out = await inOrg(sql, owner.orgId, async (tx) => {
      const r = await lockRound(tx, owner.orgId, id);
      if (!r) return null;
      if (r.last && (closed === true || archived === true)) return "last" as const;
      await tx`
        UPDATE rounds SET
          name = ${name ?? tx`name`},
          closed_at = ${closed === null ? tx`closed_at` : closed ? tx`COALESCE(closed_at, now())` : tx`NULL`},
          archived_at = ${archived === null ? tx`archived_at` : archived ? tx`COALESCE(archived_at, now())` : tx`NULL`},
          updated_at = now()
        WHERE id = ${id}::uuid
      `;
      const [row] = await counted(tx, id);
      return row ?? null;
    });
    if (!out) return fail(c, 404, "not_found", "No such round.");
    if (out === "last") return fail(c, 409, "last_open_round", LAST_OPEN);
    return c.json(shape(out));
  });

  /**
   * Delete a round AND every thread in it, the one destructive act on
   * this surface, so the body has to name the round exactly as it is called
   * now (`{ "confirm": "<name>" }`) and the server checks it again rather
   * than trusting the dialog that asked. A stale tab that still shows the old
   * name after a rename is refused, which is the point.
   *
   * SOFT, both halves: `rounds.deleted_at`, and each thread exactly as the
   * thread DELETE marks one (`softDeleteThreads` — version bumped so every
   * open widget and dashboard drops it on its next poll, screenshots marked,
   * pending mail dropped). Nothing is removed, so an operator can restore
   * from the rows; the number is never reused (POST above).
   */
  app.delete("/api/v1/rounds/:id", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    if (!manages(owner)) return fail(c, 403, "forbidden", "Only an owner or an admin can delete a round.");
    const id = rowId(c.req.param("id"));
    if (!id) return fail(c, 404, "not_found", "No such round.");
    const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
    const confirm = typeof body?.confirm === "string" ? body.confirm.trim() : "";

    const out = await inOrg(sql, owner.orgId, async (tx) => {
      const r = await lockRound(tx, owner.orgId, id);
      if (!r) return null;
      if (confirm !== r.name) return "mismatch" as const;
      if (r.last) return "last" as const;
      const threads = await softDeleteThreads(tx, r.project_id, { round: id }, "the round was deleted");
      await tx`UPDATE rounds SET deleted_at = now(), updated_at = now() WHERE id = ${id}::uuid`;
      return { threads };
    });
    if (!out) return fail(c, 404, "not_found", "No such round.");
    if (out === "mismatch") {
      return fail(c, 422, "confirm_mismatch", "Type the round's name exactly as it is shown to delete it.");
    }
    if (out === "last") return fail(c, 409, "last_open_round", LAST_OPEN);
    return c.json({ id: ID_PREFIX.round + id, deleted: true, threads: out.threads });
  });

  return app;
}

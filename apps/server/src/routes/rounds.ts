import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ID_PREFIX } from "@snagset/types/names";
import type { ProjectCache } from "../projectCache.ts";
import type { OwnerClaims } from "./owner.ts";
import { inOrg } from "../db/scope.ts";

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
  createdAt: r.created_at.toISOString(),
  threads: r.threads,
  // The safeguard, server-computed. A closed round still reports this — the
  // whole point is that closing a round must not make its unfinished work
  // disappear from view.
  unresolved: r.unresolved,
});

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
      SELECT r.id, r.number, r.name, r.closed_at, r.created_at,
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
   * Open a new round. The previous open one is CLOSED in the same transaction,
   * because "one active round at a time" is the model and two open rounds have
   * no defined answer to "where does the next thread go".
   *
   * Numbering is allocated the same way thread keys are: an UPDATE that
   * row-locks the project, not a sequence, because gapless is the property and
   * a sequence cannot promise it.
   */
  app.post("/api/v1/projects/:uid/rounds", async (c) => {
    const p = await owned(c);
    if (!p) return fail(c, 404, "project_not_found", "No project with that uid.");
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
    const owner = c.get("owner")!;

    const row = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${p.org_id}, true)`;
      const [next] = await tx<{ n: number }[]>`
        SELECT COALESCE(max(number), 0) + 1 AS n FROM rounds WHERE project_id = ${p.id}
      `;
      const number = next!.n;
      const id = randomUUID();
      const [created] = await tx<Row[]>`
        WITH closed AS (
          UPDATE rounds SET closed_at = now(), updated_at = now()
          WHERE project_id = ${p.id}::uuid AND closed_at IS NULL AND deleted_at IS NULL
          RETURNING id
        ),
        made AS (
          INSERT INTO rounds (id, org_id, project_id, number, name, created_by)
          VALUES (${id}::uuid, ${p.org_id}::uuid, ${p.id}::uuid, ${number}::int,
                  ${name || `Round ${number}`}::text, ${owner.userId}::uuid)
          RETURNING id, number, name, closed_at, created_at
        )
        SELECT made.*, 0::int AS threads, 0::int AS unresolved FROM made
      `;
      return created!;
    });
    return c.json(shape(row), 201);
  });

  /**
   * Rename, close or reopen. Never renumber, and never move threads: `number`
   * is display order minted once, and a thread's round is immutable.
   */
  app.patch("/api/v1/rounds/:id", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    const id = rowId(c.req.param("id"));
    if (!id) return fail(c, 404, "not_found", "No such round.");
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; closed?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : null;
    const closed = typeof body?.closed === "boolean" ? body.closed : null;
    if (name === null && closed === null) {
      return fail(c, 400, "validation_failed", "Send a name, or closed: true/false.");
    }
    if (name !== null && !name) return fail(c, 400, "validation_failed", "A round needs a name.");

    const [row] = await inOrg(sql, owner.orgId, (tx) => tx<Row[]>`
      WITH upd AS (
        UPDATE rounds SET
          name = ${name ?? tx`name`},
          closed_at = ${closed === null ? tx`closed_at` : closed ? tx`now()` : tx`NULL`},
          updated_at = now()
        WHERE id = ${id}::uuid AND org_id = ${owner.orgId}::uuid AND deleted_at IS NULL
        RETURNING id, number, name, closed_at, created_at
      )
      SELECT upd.*,
             (SELECT count(*)::int FROM threads t WHERE t.round_id = upd.id AND t.deleted_at IS NULL) AS threads,
             (SELECT count(*)::int FROM threads t
               WHERE t.round_id = upd.id AND t.deleted_at IS NULL AND t.status <> 'resolved') AS unresolved
      FROM upd
    `);
    if (!row) return fail(c, 404, "not_found", "No such round.");
    return c.json(shape(row));
  });

  return app;
}

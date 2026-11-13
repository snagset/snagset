import type postgres from "postgres";
import type { Context } from "hono";
import { maintenance } from "./db/scope.ts";
import type { LimitsSource } from "./plan.ts";

/**
 * Why a site takes no writes, beyond its own switch.
 *
 * `archived`: the studio put it away (finished, or to make room). `locked`:
 * the studio has more active sites than its plan allows, after a downgrade,
 * and this one is beyond the cap. The oldest sites keep working, so the one
 * a studio has had longest is never the one that stops; the newest wait
 * until a site is archived or the plan grows. Computed on each write, never
 * stored, so a plan change or an archive applies at once.
 *
 * Both are read-only, not hidden: the dashboard and the widget still show
 * every thread, and nothing is deleted.
 */
export type Hold = "archived" | "locked" | null;

export interface SiteRef {
  id: string;
  org_id: string;
  archived_at: Date | null;
  created_at: Date;
}

export type HoldOf = (p: SiteRef) => Promise<Hold>;

export function siteHolds(sql: postgres.Sql, limits: LimitsSource): HoldOf {
  return async (p) => {
    if (p.archived_at) return "archived";
    const cap = (await limits(p.org_id)).projects;
    if (cap === null || cap === undefined) return null;
    const [r] = await maintenance(sql, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM projects
      WHERE org_id = ${p.org_id}::uuid AND deleted_at IS NULL AND archived_at IS NULL
        AND (created_at, id) < (${p.created_at}, ${p.id}::uuid)
    `);
    return (r?.n ?? 0) >= cap ? "locked" : null;
  };
}

const SAID = {
  archived: { code: "site_archived", message: "This site is archived. Its threads can be read; restore it to add or change anything." },
  locked: {
    code: "site_locked",
    message: "This studio has more sites than its plan allows, so this one is read-only. Archive a site, or move to a plan with more.",
  },
} as const;

export function holdRefused(c: Context, hold: Exclude<Hold, null>) {
  const s = SAID[hold];
  return c.json({ error: { code: s.code, message: s.message, requestId: c.get("requestId") } }, 403);
}

export const holdMessage = (hold: Exclude<Hold, null>) => SAID[hold].message;

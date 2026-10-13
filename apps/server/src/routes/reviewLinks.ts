import { Hono, type Context } from "hono";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type postgres from "postgres";
import { ID_PREFIX } from "@snagset/types/names";
import type { ProjectCache } from "../projectCache.ts";
import type { OwnerClaims } from "./owner.ts";
import { inOrg } from "../db/scope.ts";

/**
 * Review links — mint, list, revoke. And.
 *
 * DASHBOARD-CLASS: no CORS headers are emitted at all, so a reviewed
 * site cannot reach these routes even with a valid session. Minting a link is a
 * studio act performed on the studio's own origin.
 *
 * THE RAW TOKEN EXISTS ONCE. It is returned by the mint response and stored
 * only as `sha256`, so there is no route, no log line and no later response
 * that can produce it again. That is the property the DoD asserts by
 * scanning serialised responses for a 43-character token, and the reason
 * "revoke and replace" is the recovery rather than "show me the link again".
 *
 * REVOKING IS THE WHOLE ACCESS-CONTROL STORY, so it does two things and
 * both matter: it sets `revoked_at`, which stops any further exchange, AND it
 * bumps `projects.session_epoch`, which invalidates every session already
 * issued — within 10 s, at zero query cost. Without the bump a
 * revoked link keeps working for whoever already redeemed it, which is the
 * opposite of what the operator just clicked.
 */

type Env = { Variables: { requestId: string; owner?: OwnerClaims } };
type Ctx = Context<Env>;

export interface ReviewLinkDeps {
  sql: postgres.Sql;
  projects: ProjectCache;
  now?: () => Date;
  /** `SNAGSET_REVIEW_LINK_TTL_DAYS` (14) and `_MAX_TTL_DAYS` (90). */
  ttlDays: number;
  maxTtlDays: number;
}

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rowId = (wire: string, prefix: string): string | null => {
  const bare = wire.startsWith(prefix) ? wire.slice(prefix.length) : wire;
  return UUID.test(bare) ? bare.toLowerCase() : null;
};

/** The six. Anything else is refused rather than stored — an unknown
 *  permission in the column would be silently dropped at exchange, which reads
 *  to the operator as "I granted it and it did nothing". */
const KNOWN = [
  "thread:create",
  "comment:create",
  "thread:resolve",
  "thread:delete:own",
  "thread:private",
  "thread:assign",
];
const DEFAULT_PERMISSIONS = ["thread:create", "comment:create", "thread:resolve", "thread:delete:own"];

interface Row {
  id: string;
  round_id: string | null;
  name: string;
  email: string | null;
  environments: string[];
  permissions: string[];
  allow_name_override: boolean;
  max_uses: number | null;
  use_count: number;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

/** Never `token`, never `tokenHash`. */
const shape = (r: Row) => ({
  id: ID_PREFIX.link + r.id,
  ...(r.round_id ? { roundId: ID_PREFIX.round + r.round_id } : {}),
  name: r.name,
  ...(r.email ? { email: r.email } : {}),
  environments: r.environments,
  permissions: r.permissions,
  allowNameOverride: r.allow_name_override,
  maxUses: r.max_uses,
  useCount: r.use_count,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  revokedAt: r.revoked_at?.toISOString() ?? null,
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
});

export function reviewLinkRoutes(deps: ReviewLinkDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { sql, projects } = deps;
  const now = deps.now ?? (() => new Date());
  const DAY = 86_400_000;

  /**
   * Owner-only, and owner OF THIS PROJECT (same pattern as `rounds.ts`).
   *
   * `requireOwner()` only proves SOME org's owner is signed in — nothing
   * here compared `owner.orgId` to the project's before this fix, so an
   * owner of org A could mint, list, or revoke org B's links by uid. 404
   * rather than 403 on a mismatch: a project uid existing at all is not
   * information another org gets to learn.
   */
  const owned = async (c: Ctx) => {
    const uid = c.req.param("uid");
    if (!uid) return null;
    const p = await projects.get(uid).catch(() => null);
    if (!p) return null;
    const owner = c.get("owner");
    return owner && owner.orgId === p.org_id ? p : null;
  };

  app.post("/api/v1/projects/:uid/review-links", async (c) => {
    const project = await owned(c);
    if (!project) return fail(c, 404, "project_not_found", "No project with that uid.");

    const body = (await c.req.json().catch(() => null)) as Record<string, any> | null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
    if (!name) {
      return fail(
        c,
        400,
        "validation_failed",
        "name is required — it labels the LINK (\"Client review — round 2\"), not a person.",
      );
    }

    const permissions: string[] = Array.isArray(body?.permissions) ? body.permissions : DEFAULT_PERMISSIONS;
    const unknown = permissions.filter((p) => !KNOWN.includes(p));
    if (unknown.length) {
      return fail(c, 422, "validation_failed", `Unknown permission(s): ${unknown.join(", ")}.`);
    }

    // Clamped ON WRITE, .1's closing note: one default (14), one
    // ceiling (90), and the clamp lives here rather than being trusted to a UI.
    const ceiling = now().getTime() + deps.maxTtlDays * DAY;
    const asked = typeof body?.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
    const expiresAt = new Date(
      Math.min(Number.isFinite(asked) ? asked : now().getTime() + deps.ttlDays * DAY, ceiling),
    );
    if (expiresAt <= now()) {
      return fail(c, 400, "validation_failed", "expiresAt must be in the future.");
    }

    let roundId: string | null = null;
    if (typeof body?.roundId === "string" && body.roundId) {
      roundId = rowId(body.roundId, ID_PREFIX.round);
      if (!roundId) return fail(c, 400, "validation_failed", "roundId is not a valid id.");
      const [round] = await inOrg(sql, project.org_id, (tx) => tx<{ id: string }[]>`
        SELECT id FROM rounds WHERE id = ${roundId} AND project_id = ${project.id} AND deleted_at IS NULL
      `);
      if (!round) return fail(c, 404, "not_found", "That round is not in this project.");
    }

    // 32 bytes, unpadded base64url, 43 chars. Stored as
    // sha256 only, which is why this response is the token's one appearance.
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();

    const [row] = await inOrg(sql, project.org_id, (tx) => tx<Row[]>`
      INSERT INTO review_links
        (id, org_id, project_id, round_id, token_hash, name, email, environments, permissions,
         allow_name_override, max_uses, expires_at)
      VALUES
        (${id}, ${project.org_id}, ${project.id}, ${roundId}, ${sha256(token)}, ${name},
         ${typeof body?.email === "string" ? body.email : null},
         ${tx.array(Array.isArray(body?.environments) && body.environments.length ? body.environments : ["*"])},
         ${tx.array(permissions)},
         ${body?.allowNameOverride === false ? false : true},
         ${Number.isInteger(body?.maxUses) && (body?.maxUses as number) > 0 ? body!.maxUses : null},
         ${expiresAt})
      RETURNING id, round_id, name, email, environments, permissions, allow_name_override,
                max_uses, use_count, created_at, expires_at, revoked_at, last_used_at
    `);

    c.header("Location", `/api/v1/review-links/${ID_PREFIX.link}${id}`);
    return c.json(
      {
        ...shape(row!),
        // The one and only time. The dashboard builds `<page>#snag_k=<token>` —
        // the server does not know which page of the reviewed site to point at.
        token,
        fragment: `#snag_k=${token}`,
      },
      201,
    );
  });

  app.get("/api/v1/projects/:uid/review-links", async (c) => {
    const project = await owned(c);
    if (!project) return fail(c, 404, "project_not_found", "No project with that uid.");
    const rows = await inOrg(sql, project.org_id, (tx) => tx<Row[]>`
      SELECT id, round_id, name, email, environments, permissions, allow_name_override,
             max_uses, use_count, created_at, expires_at, revoked_at, last_used_at
      FROM review_links WHERE project_id = ${project.id} ORDER BY created_at DESC
    `);
    return c.json({ data: rows.map(shape), nextCursor: null });
  });

  app.delete("/api/v1/review-links/:id", async (c) => {
    const id = rowId(c.req.param("id"), ID_PREFIX.link);
    if (!id) return fail(c, 404, "not_found", "No such review link.");

    // This route is not project-scoped in the URL (a link id is looked up
    // directly), so the org check has to happen here rather than via
    // `owned()` — org A's owner must not be able to revoke org B's link by
    // guessing/enumerating a `lnk_` id. `review_links.org_id` is denormalised
    // onto the row for exactly this filter.
    const owner = c.get("owner")!;
    const [link] = await inOrg(sql, owner.orgId, (tx) => tx<{ id: string; project_id: string; uid: string; revoked_at: Date | null }[]>`
      SELECT rl.id, rl.project_id, p.uid, rl.revoked_at
      FROM review_links rl JOIN projects p ON p.id = rl.project_id
      WHERE rl.id = ${id} AND rl.org_id = ${owner.orgId}
    `);
    if (!link) return fail(c, 404, "not_found", "No such review link.");

    // BOTH, in one transaction. `revoked_at` stops further exchanges; the epoch
    // bump kills the sessions already issued. Doing only the first leaves every
    // reviewer who already redeemed the link working for up to 12 hours.
    await sql.begin(async (tx) => {
      await tx`UPDATE review_links SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`;
      await tx`UPDATE projects SET session_epoch = session_epoch + 1 WHERE id = ${link.project_id}`;
    });
    // So the operator who clicked sees it on THIS node without waiting out the
    // 10 s TTL. Other nodes catch up on their own expiry, which is the bound
    // the design states.
    projects.invalidate(link.uid);

    return c.body(null, 204);
  });

  return app;
}

import { Hono, type Context } from "hono";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { ProjectCache } from "../projectCache.ts";
import type { OwnerClaims } from "./owner.ts";
import type { AddressSource } from "../instance/address.ts";
import type { McpHttpSource } from "../instance/mcpHttp.ts";
import { DEFAULT_SCOPES, MCP_SCOPES, mintMcpToken, type McpScope } from "./mcpToken.ts";
import { can } from "@snagset/types/roles";

/**
 * MCP tokens from the dashboard — 05 endpoint 32b. The M3 register's
 * "dashboard token screen", drawn as the fifth Integrations card: for
 * a studio whose fixes are made by an agent it is the integration that
 * matters most, and a credential that only a CLI on the server can mint is
 * a credential most studios never mint.
 *
 *   GET    /api/v1/mcp-tokens        every token in the studio, live and revoked — never a secret
 *   POST   /api/v1/mcp-tokens        mint one; the token comes back ONCE, in this answer
 *   DELETE /api/v1/mcp-tokens/:id    revoke; the row stays, for the audit trail
 *
 * Who sees and revokes what (`@snagset/types/roles`):
 *
 *   owner    mints; sees every token; revokes any
 *   admin    mints; sees every token; revokes their own
 *   member   mints; sees their own;   revokes their own
 *
 * A member's token is the designer's own coding agent, so a member mints
 * with every scope there is: nothing an MCP token can do is beyond a member.
 * The five scopes read threads (team-only ones included, which a member
 * reads in the dashboard), read capture context, reply, mark a fix ready and
 * map source — and an agent can neither resolve, assign, make anything
 * team-only nor delete (threads.ts, comments.ts), so no scope reaches an
 * admin's act. Removing a member revokes their tokens (members.ts).
 *
 * The org is the session's — a self-host has one — so the path carries no
 * org id. The rules hold unchanged:
 * the default is read-only plus local source mapping, `context:read` is a
 * separate tick because it is the personal-data-bearing half, and only the
 * hash is stored, so a lost token is revoked and replaced, never shown again.
 */

type Env = { Variables: { requestId: string; owner?: OwnerClaims } };
type Ctx = Context<Env>;

export interface McpTokenDeps {
  sql: postgres.Sql;
  projects: ProjectCache;
  /** Whether POST /mcp is served, read live. */
  mcpHttp: McpHttpSource;
  address: AddressSource;
}

function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  return c.json({ error: { code, message, ...(details ? { details } : {}), requestId: c.get("requestId") } }, status as 400);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  allow_remote_writes: boolean;
  project_uid: string | null;
  project_name: string | null;
  created_by_name: string | null;
  created_by: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

/** `viewer` decides `canRevoke`: an owner any token, everyone else their own. */
const shape = (r: TokenRow, viewer: OwnerClaims) => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  allowRemoteWrites: r.allow_remote_writes,
  site: r.project_uid ? { uid: r.project_uid, name: r.project_name ?? "" } : null,
  createdBy: r.created_by_name,
  canRevoke: !r.revoked_at && (revokesAny(viewer) || (can(viewer.role, "review") && r.created_by === viewer.userId)),
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  expiresAt: r.expires_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

/** Revoking somebody else's token is the owner's: it is how a token is always cut off, whoever made it. */
const revokesAny = (o: OwnerClaims): boolean => can(o.role, "people");

export function mcpTokenRoutes(deps: McpTokenDeps): Hono<Env> {
  const { sql, projects } = deps;
  const app = new Hono<Env>();

  const signedIn = (c: Ctx): OwnerClaims | Response => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    return owner;
  };
  /**
   * Everyone who reviews mints — each teammate wants one for their own
   * coding agent, designers included. Revoking: one's own, or an
   * owner anyone's, so a token can always be cut off whoever made it.
   */
  const mayMint = (c: Ctx): OwnerClaims | Response => {
    const owner = signedIn(c);
    if (owner instanceof Response) return owner;
    if (!can(owner.role, "review")) {
      return fail(c, 403, "forbidden", "Your role in this studio cannot mint an agent token.");
    }
    return owner;
  };
  /** `mine`: only the caller's own tokens — a member's list. */
  const load = (orgId: string, id?: string, mine?: string) =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      return tx<TokenRow[]>`
        SELECT t.id, t.name, t.prefix, t.scopes, t.allow_remote_writes, p.uid AS project_uid, p.name AS project_name, u.name AS created_by_name, t.created_by,
               t.created_at, t.last_used_at, t.expires_at, t.revoked_at
          FROM mcp_tokens t
          LEFT JOIN projects p ON p.id = t.project_id
          LEFT JOIN users u ON u.id = t.created_by
         WHERE t.org_id = ${orgId}::uuid ${id ? tx`AND t.id = ${id}::uuid` : tx``}
           ${mine ? tx`AND t.created_by = ${mine}::uuid` : tx``}
         ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC
      `;
    });

  app.get("/api/v1/mcp-tokens", async (c) => {
    const owner = signedIn(c);
    if (owner instanceof Response) return owner;
    // A member sees their own tokens; the studio's whole list (who has an
    // agent reading what) is an owner's and an admin's.
    const rows = await load(owner.orgId, undefined, can(owner.role, "tokens") ? undefined : owner.userId);
    // Whether POST /mcp is served, who decided, and where — the
    // card draws the switch from it and the dialog shows the remote config
    // only when it is on.
    const state = await deps.mcpHttp();
    const http = { enabled: state.enabled, source: state.source, url: `${(await deps.address()).replace(/\/+$/, "")}/mcp` };
    return c.json({ data: rows.map((r) => shape(r, owner)), scopes: MCP_SCOPES, defaults: DEFAULT_SCOPES, http });
  });

  app.post("/api/v1/mcp-tokens", async (c) => {
    const owner = mayMint(c);
    if (owner instanceof Response) return owner;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.["name"] === "string" ? (body["name"] as string).trim() : "";
    if (!name || name.length > 80) return fail(c, 422, "validation_failed", "Name the token for the agent that will hold it — “Claude Code”, “CI bot”.", { field: "name" });

    const wantScopes = body?.["scopes"];
    let scopes: McpScope[] = [...DEFAULT_SCOPES];
    if (wantScopes !== undefined) {
      if (!Array.isArray(wantScopes) || wantScopes.some((s) => typeof s !== "string")) {
        return fail(c, 422, "validation_failed", "Scopes are a list of names.", { field: "scopes" });
      }
      const unknown = (wantScopes as string[]).filter((s) => !(MCP_SCOPES as readonly string[]).includes(s));
      if (unknown.length) return fail(c, 422, "validation_failed", `No scope called ${JSON.stringify(unknown[0])}. Known: ${MCP_SCOPES.join(", ")}.`, { field: "scopes" });
      scopes = [...new Set(wantScopes as McpScope[])];
      if (scopes.length === 0) return fail(c, 422, "validation_failed", "A token with no scope can do nothing. Give it at least threads:read.", { field: "scopes" });
    }

    let projectId: string | null = null;
    const site = body?.["site"];
    if (typeof site === "string" && site) {
      const p = await projects.get(site);
      if (!p || p.org_id !== owner.orgId) return fail(c, 422, "validation_failed", "No site with that uid.", { field: "site" });
      projectId = p.id;
    }

    let expiresAt: Date | null = null;
    const days = body?.["expiresInDays"];
    if (days !== undefined && days !== null) {
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) {
        return fail(c, 422, "validation_failed", "Expiry is a number of days, 1 to 3650, or nothing.", { field: "expiresInDays" });
      }
      expiresAt = new Date(Date.now() + days * 86_400_000);
    }

    const allowRemoteWrites = body?.["allowRemoteWrites"] === true;
    const id = randomUUID();
    const minted = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${owner.orgId}, true)`;
      return mintMcpToken(tx, id, { orgId: owner.orgId, projectId, name, scopes, createdBy: owner.userId, expiresAt, allowRemoteWrites });
    });
    const [row] = await load(owner.orgId, id);
    return c.json({ token: shape(row!, owner), secret: minted.token }, 201);
  });

  app.delete("/api/v1/mcp-tokens/:id", async (c) => {
    const owner = mayMint(c);
    if (owner instanceof Response) return owner;
    const id = c.req.param("id") ?? "";
    if (!UUID.test(id)) return fail(c, 404, "not_found", "No token with that id.");
    const asOwner = revokesAny(owner);
    const done = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${owner.orgId}, true)`;
      return tx`UPDATE mcp_tokens SET revoked_at = now()
                 WHERE id = ${id}::uuid AND org_id = ${owner.orgId}::uuid AND revoked_at IS NULL
                   ${asOwner ? tx`` : tx`AND created_by = ${owner.userId}::uuid`}`;
    });
    if (done.count === 0) {
      return fail(
        c,
        404,
        "not_found",
        asOwner ? "No live token with that id — it may already be revoked." : "No live token of yours with that id.",
      );
    }
    const [row] = await load(owner.orgId, id);
    return c.json({ token: row ? shape(row, owner) : null });
  });

  return app;
}

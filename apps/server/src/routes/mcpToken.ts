import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import { CREDENTIAL_PREFIX } from "@snagset/types/names";
import { inOrg, maintenance } from "../db/scope.ts";

/**
 * MCP tokens. The credential an agent presents, and NOT the generic
 * API key.
 *
 * The spec is blunt about why they are different things: an API key is a
 * server-to-server credential for CI, with no notion of a write budget, a
 * confirmation obligation or a scope list, *"and handing one to a program that
 * reads attacker-typed text and then writes is the wrong trade."*
 *
 * ── THE SHAPE, AND WHY IT IS UGLY ON PURPOSE ──
 *
 * `snagmcp_<prefix8>_<43 chars>`. It deliberately breaks the three-letter row
 * shape (`thr_`, `att_`) because **the literal is what gets registered with
 * GitHub secret scanning** — a token pasted into a public repository is then
 * reported automatically. A credential has to be recognisable as a credential.
 *
 * The literal is DERIVED from the brand and read from the constants module.
 * 07 awards `cdmcp_`, which predates the rename; typing that here is how a
 * credential gets left behind by the next one.
 *
 * ── WHAT IS STORED ──
 *
 * Only `sha256(token)`, plus the first 8 characters in the clear so the
 * dashboard can show *which* token without holding one. A lost token cannot be
 * re-displayed; it is revoked and a new one minted. Same reasoning as the claim
 * URL.
 */

export interface MintedToken {
  readonly id: string;
  /** Shown ONCE, at creation. Never stored, never recoverable. */
  readonly token: string;
  readonly prefix: string;
}

/** The vocabulary. This spec owns it; the server enforces it. */
export const MCP_SCOPES = [
  "threads:read",
  "context:read",
  "comments:write",
  "threads:write",
  "source:map",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * What the dashboard issues by default: **read-only, plus local source
 * mapping**.
 *
 * *"The default token issued by the dashboard carries `threads:read`
 * and `source:map` only."* `context:read` is separate on purpose — breadcrumbs
 * and capture context are the personal-data-bearing half, and an agent that
 * only needs "what is broken and where" should not be handed a console log.
 */
export const DEFAULT_SCOPES: readonly McpScope[] = ["threads:read", "source:map"];

const hash = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export interface MintOptions {
  readonly orgId: string;
  /** Null scopes the token to the whole org. */
  readonly projectId?: string | null;
  readonly name: string;
  readonly scopes?: readonly McpScope[];
  readonly createdBy?: string | null;
  readonly expiresAt?: Date | null;
  /** The transport gate. Default false: a write over HTTP is a decision. */
  readonly allowRemoteWrites?: boolean;
}

export async function mintMcpToken(
  sql: postgres.Sql | postgres.TransactionSql,
  id: string,
  opts: MintOptions,
): Promise<MintedToken> {
  const secret = randomBytes(32).toString("base64url");
  const prefix = randomBytes(6).toString("base64url").slice(0, 8);
  const token = `${CREDENTIAL_PREFIX.mcp}${prefix}_${secret}`;
  const scopes = opts.scopes ?? DEFAULT_SCOPES;

  for (const scope of scopes) {
    if (!(MCP_SCOPES as readonly string[]).includes(scope)) {
      throw new Error(`unknown MCP scope ${JSON.stringify(scope)}. Known: ${MCP_SCOPES.join(", ")}`);
    }
  }

  await inOrg(sql, opts.orgId, (tx) => tx`
    INSERT INTO mcp_tokens (id, org_id, project_id, name, prefix, token_hash, scopes, created_by, expires_at, allow_remote_writes)
    VALUES (${id}, ${opts.orgId}, ${opts.projectId ?? null}, ${opts.name}, ${prefix},
            ${hash(token)}, ${tx.array(scopes as string[])}, ${opts.createdBy ?? null},
            ${opts.expiresAt ?? null}, ${opts.allowRemoteWrites ?? false})
  `);
  return { id, token, prefix };
}

export interface McpClaims {
  readonly tokenId: string;
  /** The name the operator gave it. Becomes the agent reviewer's display name,
   *  so "Claude Code" or "CI bot" is what a client sees on the reply rather
   *  than the word "agent". */
  readonly name: string;
  readonly orgId: string;
  readonly projectId: string | null;
  readonly scopes: readonly string[];
  readonly confirmWrites: boolean;
  readonly allowRemoteWrites: boolean;
}

/**
 * Verify a presented token. Returns null for anything not currently valid —
 * unknown, revoked, or expired — without saying which.
 *
 * The lookup is by HASH, so a token is found in one indexed comparison rather
 * than by scanning and comparing; `timingSafeEqual` on the row that comes back
 * closes the remaining timing channel.
 */
export async function verifyMcpToken(
  sql: postgres.Sql,
  presented: string,
  now: Date = new Date(),
): Promise<McpClaims | null> {
  if (!presented.startsWith(CREDENTIAL_PREFIX.mcp)) return null;

  const digest = hash(presented);
  const [row] = await maintenance(sql, (tx) => tx<
    {
      id: string;
      name: string;
      org_id: string;
      project_id: string | null;
      scopes: string[];
      confirm_writes: boolean;
      allow_remote_writes: boolean;
      token_hash: Buffer;
      revoked_at: Date | null;
      expires_at: Date | null;
    }[]
  >`
    SELECT id, name, org_id, project_id, scopes, confirm_writes, allow_remote_writes,
           token_hash, revoked_at, expires_at
      FROM mcp_tokens
     WHERE token_hash = ${digest}
     LIMIT 1
  `);
  if (!row) return null;
  if (row.token_hash.length !== digest.length || !timingSafeEqual(row.token_hash, digest)) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at <= now) return null;

  return {
    tokenId: row.id,
    name: row.name,
    orgId: row.org_id,
    projectId: row.project_id,
    scopes: row.scopes,
    confirmWrites: row.confirm_writes,
    allowRemoteWrites: row.allow_remote_writes,
  };
}

/**
 * Record use — `last_used_at`, and the address as a SALTED HASH.
 *
 * 07 F29 reads this column and put the salt in migration 0001 so no
 * historical hash predates it. The raw address is never stored anywhere in this
 * system, and a token audit trail is not the place to make the first
 * exception.
 *
 * Deliberately fire-and-forget at the call site: a failure to write an audit
 * timestamp must not fail the request that succeeded.
 */
export async function touchMcpToken(
  sql: postgres.Sql,
  tokenId: string,
  ipHash: Buffer | null,
): Promise<void> {
  await maintenance(sql, (tx) => tx`
    UPDATE mcp_tokens SET last_used_at = now(), last_used_ip = ${ipHash}
     WHERE id = ${tokenId}
  `);
}

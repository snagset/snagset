import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type postgres from "postgres";
import { CREDENTIAL_PREFIX, HTTP_HEADER } from "@snagset/types/names";
import { verifyMcpToken, touchMcpToken, type McpClaims } from "./mcpToken.ts";
import { inOrg, maintenance } from "../db/scope.ts";

/**
 * MCP bearer auth, and the thing that was missing.
 *
 * `mcp_tokens` has existed since migration 0001 (*"a credential table added
 * late is a credential table without an audit history"*), but **no route
 * accepted one**. Which made the central claim — *"It is not a second
 * API. Every read the MCP server performs goes through the same `/api/v1`
 * routes with the same authorisation as any other caller"* — unbuildable: the
 * only way to write the MCP package would have been to give it a database
 * connection, i.e. to build the second API the sentence forbids.
 *
 * So this is the missing half. `packages/mcp` gets no privilege of its own; it
 * gets a token, and this file is where a token becomes an identity.
 *
 * ── ATTACHED, NOT ENFORCED ──
 *
 * Same shape as `bearerAuth` and `ownerAuth`: a valid token is attached and
 * the ROUTE decides what it may do. A presented-but-invalid one is refused
 * loudly, because unlike a reviewer session there is no read-only fallback an
 * agent could silently degrade to — a revoked token that returns an empty
 * thread list reads to an agent as "nothing to fix", which is a wrong answer
 * given confidently.
 */

export type McpEnv = {
  Variables: {
    requestId: string;
    mcp?: McpClaims;
  };
};

/**
 * The write budget, `mcpw:token`, 20 writes per 10 minutes
 * *(calibration)*, and the design is why it exists: *"An agent injected
 * into 'resolve every thread' stops on the 21st and must tell its user."*
 *
 * Counted out of `events` rather than a bucket in memory, and that is not
 * laziness. A budget in process memory resets when the process restarts and
 * does not exist at all across two instances — so on the serverless entry
 * (`serverless.ts`) an attacker gets 20 writes *per warm instance*, which is
 * not a budget. Already requires every agent write to land in
 * `events` with the token id; counting the rows that must exist anyway makes
 * the budget exactly as durable as the audit trail.
 */
export const WRITE_BUDGET = { writes: 20, windowMinutes: 10 } as const;

export function mcpAuth(sql: postgres.Sql): MiddlewareHandler<McpEnv> {
  return async (c, next) => {
    const presented = /^Bearer (.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    // Not an MCP token — a reviewer bearer, or nothing. Costs one string
    // comparison and no query, which is what keeps this mountable app-wide.
    if (!presented?.startsWith(CREDENTIAL_PREFIX.mcp)) return next();

    const claims = await verifyMcpToken(sql, presented);
    if (!claims) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            // One sentence for unknown, revoked and expired alike. Which of
            // the three it was is exactly what a probe is trying to learn, and
            // the operator can see it with `snagset mcp-token list`.
            message:
              "That MCP token is not valid. It may have been revoked or have expired — " +
              "mint a new one with `snagset mcp-token create`.",
            requestId: c.get("requestId"),
          },
        },
        401,
      );
    }

    c.set("mcp", claims);
    // A write over the remote transport needs the token's explicit
    // say-so. The marker is set by our own HTTP transport on the calls it
    // makes back in; a stranger setting it on a request of their own only
    // narrows what that request may do. Reads are untouched.
    if (
      c.req.header(HTTP_HEADER.mcpTransport) === "http" &&
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      !claims.allowRemoteWrites
    ) {
      return c.json(
        {
          error: {
            code: "remote_writes_not_allowed",
            message:
              "This token may read over the remote transport but not write. Mint one with remote writes " +
              "allowed on Studio › Integrations › MCP, or run the stdio server on a machine with the checkout.",
            requestId: c.get("requestId"),
          },
        },
        403,
      );
    }

    /**
     * The audit timestamp, and the address as a per-token salted hash.
     *
     * `void` on purpose — F29 reads `last_used_at`, but a failure to record it
     * must never fail a request that otherwise succeeded.
     *
     * The salt is the token's OWN hash. The design puts the IP salt on
     * `projects`, which works for a project-scoped token and has nothing to
     * offer an org-wide one — and an org-wide token is what the CLI mints, so
     * "use the project salt" would mean recording nothing in the common case
     * and leaving F29 blind. `token_hash` is per-row, already stored, cannot
     * predate the row it is on, and is not derivable by whoever is being
     * hashed. The raw address is still never stored.
     */
    // The `mcp:token` bucket, 120 a minute. Counted in `rate_counters`
    // like the mail allowance — durable, org-scoped, one row per token — so
    // two instances or a restart share the same count.: on 429 the
    // tool layer tells the agent to stop and ask, never to sleep and retry.
    const over = await overReadBudget(sql, claims, new Date()).catch(() => null);
    if (over) return quotaExceeded(c, over);
    void touchMcpToken(sql, claims.tokenId, hashAddress(c, claims)).catch(() => {});

    return next();
  };
}

function hashAddress(c: Context, claims: McpClaims): Buffer | null {
  const raw =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip")?.trim() || "";
  if (!raw) return null;
  return createHash("sha256").update(raw, "utf8").update(claims.tokenId, "utf8").digest();
}

/**
 * Does this token carry the scope, for this org?
 *
 * BOTH halves matter and the org half is the one that is easy to forget: a
 * valid token for another org is a valid token, and every route here resolves
 * its project independently of the credential. This is the same check
 * `asOwner` makes (`owner.orgId === p.org_id`), for the same reason.
 */
export function mcpAllows(claims: McpClaims | undefined, orgId: string, scope: string): boolean {
  return !!claims && claims.orgId === orgId && claims.scopes.includes(scope);
}

/**
 * The refusal, with the scope named — the registered `mcp_scope_denied`.
 *
 * The message says which scope and how to fix it, because the reader is an
 * agent relaying to a developer who minted the token minutes ago and has no
 * idea the default is read-only. "Forbidden" would send them to the dashboard
 * looking for a permission that is not there.
 */
export function scopeDenied(c: Context, scope: string) {
  return c.json(
    {
      error: {
        code: "mcp_scope_denied",
        message:
          `This MCP token does not carry the "${scope}" scope. Mint one that does with ` +
          `\`snagset mcp-token create <name> ${scope}\` — the default token is read-only on purpose.`,
        requestId: c.get("requestId"),
      },
    },
    403,
  );
}

/**
 * Spend one write from the budget, or refuse.
 *
 * Returns null when the write may proceed. Deliberately checked BEFORE the
 * write rather than after: a budget enforced by refusing the 21st response
 * while having already made the 21st change is not a budget.
 */
export async function checkWriteBudget(sql: postgres.Sql, tokenId: string): Promise<number | null> {
  const [row] = await maintenance(sql, (tx) => tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM events
     WHERE actor_kind = 'integration'
       AND payload->>'mcpTokenId' = ${tokenId}
       AND created_at > now() - ${`${WRITE_BUDGET.windowMinutes} minutes`}::interval
  `);
  const spent = row?.n ?? 0;
  return spent >= WRITE_BUDGET.writes ? spent : null;
}

/** The stop signal, as an HTTP response. */
export function budgetExhausted(c: Context) {
  return c.json(
    {
      error: {
        code: "rate_limited",
        message:
          `This agent has made ${WRITE_BUDGET.writes} writes in the last ` +
          `${WRITE_BUDGET.windowMinutes} minutes, which is the limit. Stop and tell your user ` +
          `what you were doing — do not retry.`,
        requestId: c.get("requestId"),
      },
    },
    429,
  );
}

/**
 * The audit row, *"so 'what did the agent do last
 * Tuesday' is one query"*.
 *
 * Takes a transaction, and every caller passes the one doing the write. That
 * is what makes the budget above sound: the audit row and the change it
 * records commit together, so there is no window in which a write has happened
 * and is not yet counted.
 */
export async function recordAgentWrite(
  tx: postgres.TransactionSql,
  what: {
    orgId: string;
    projectId: string;
    type: string;
    subjectType: string;
    subjectId: string;
    reviewerId: string;
    tokenId: string;
  },
): Promise<void> {
  // `tx.json(…)`, NOT `JSON.stringify(…)::jsonb`.
  //
  // postgres.js JSON-encodes a string parameter bound to a jsonb column, so a
  // stringified object arrives as a JSON *string scalar*: `jsonb_typeof` says
  // `string`, and `payload->>'mcpTokenId'` is null. Which silently disabled the
  // write budget — `checkWriteBudget` counted zero, forever, and an agent could
  // write without limit. The audit rows were all there and all unqueryable.
  //
  // Missed by the unit test because that test SEEDED the rows itself, correctly,
  // and then asserted the refusal. It proved the query, and the query was never
  // the broken half. Caught by making 21 real writes through a published tarball
  // and watching all 21 succeed.
  await tx`
    INSERT INTO events (id, org_id, project_id, type, actor_kind, actor_id, subject_type, subject_id, payload)
    VALUES (${randomUUID()}, ${what.orgId}, ${what.projectId}, ${what.type}, 'integration',
            ${what.reviewerId}, ${what.subjectType}, ${what.subjectId},
            ${tx.json({ mcpTokenId: what.tokenId })})
  `;
}

/**
 * Find-or-create the agent's reviewer row — *Authorship*, and the
 * representation: `kind = 'guest'` with `is_agent = true` and
 * `agent_mcp_token_id` set.
 *
 * **Never `verified`.** Draft 2 of 07 posted agent comments as `kind:
 * 'verified'` with an `(agent)` name suffix and that is deleted: `verified`
 * means the host application's server vouched for a named human, and it
 * carries a moderation bypass. Laundering a machine credential into it hands
 * an agent — possibly one acting on injected instructions — the highest trust
 * tier in the system on the strength of a name convention.
 *
 * `holder_secret_hash` is 32 random bytes whose plaintext is DISCARDED here and
 * never existed anywhere else. 0001's CHECK requires a non-verified row to be a
 * credential holder, a studio member or a placeholder, and an agent is the
 * first of those — its credential is the MCP token. Hashing something guessable
 * instead (the token id, say) would make this row impersonable through
 * `/sessions`' guest path by anyone who learned a uuid; hashing a secret nobody
 * holds means that door is not merely locked, there is no key.
 */
export async function agentReviewer(
  tx: postgres.TransactionSql,
  what: { orgId: string; projectId: string; tokenId: string; tokenName: string },
): Promise<string> {
  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM reviewers
     WHERE project_id = ${what.projectId}::uuid AND agent_mcp_token_id = ${what.tokenId}::uuid
  `;
  if (existing) return existing.id;

  const id = randomUUID();
  await tx`
    INSERT INTO reviewers (id, org_id, project_id, kind, name, holder_secret_hash, is_agent, agent_mcp_token_id)
    VALUES (${id}::uuid, ${what.orgId}::uuid, ${what.projectId}::uuid, 'guest',
            ${what.tokenName}, ${createHash("sha256").update(randomBytes(32)).digest()},
            true, ${what.tokenId}::uuid)
  `;
  return id;
}

/** `mcp:token`,: 120 requests per minute per token. */
export const READ_BUDGET = { requests: 120, windowMs: 60_000 } as const;

/** Bump the token's minute window; the moment it clears when over, else null. */
export async function overReadBudget(sql: postgres.Sql, claims: McpClaims, now: Date): Promise<Date | null> {
  const key = `mcp:${claims.tokenId}`;
  const windowStart = new Date(now.getTime() - READ_BUDGET.windowMs);
  const expires = new Date(now.getTime() + READ_BUDGET.windowMs);
  const [row] = await inOrg(sql, claims.orgId, (tx) => tx<{ count: string; window_start: Date }[]>`
    INSERT INTO rate_counters (org_id, bucket_key, window_start, count, expires_at)
    VALUES (${claims.orgId}::uuid, ${key}, ${now}, 1, ${expires})
    ON CONFLICT (org_id, bucket_key) DO UPDATE
      SET count = CASE WHEN rate_counters.window_start < ${windowStart} THEN 1 ELSE rate_counters.count + 1 END,
          window_start = CASE WHEN rate_counters.window_start < ${windowStart} THEN ${now} ELSE rate_counters.window_start END,
          expires_at = CASE WHEN rate_counters.window_start < ${windowStart} THEN ${expires} ELSE rate_counters.expires_at END
    RETURNING count::text, window_start
  `);
  if (!row || Number(row.count) <= READ_BUDGET.requests) return null;
  return new Date(new Date(row.window_start).getTime() + READ_BUDGET.windowMs);
}

export function quotaExceeded(c: Context, clearsAt: Date) {
  const seconds = Math.max(1, Math.ceil((clearsAt.getTime() - Date.now()) / 1000));
  return c.json(
    {
      error: {
        code: "quota_exceeded",
        message:
          `This MCP token has made ${READ_BUDGET.requests} requests in the last minute. Stop and ask your user ` +
          `before continuing — do not retry on your own. The window clears in ${seconds}s.`,
        requestId: c.get("requestId"),
      },
    },
    429,
  );
}

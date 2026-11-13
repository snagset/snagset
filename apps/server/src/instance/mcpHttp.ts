import type postgres from "postgres";
import type { Config } from "../config.ts";
import type { Keyring } from "../keys.ts";
import { firstOrgId, readSetting, writeSetting, clearSetting } from "./settings.ts";

/**
 * Whether `POST /mcp` is served, the address's shape for the
 * one switch left in the environment.
 *
 * Three sources, in the order they win:
 *
 *   env      `SNAGSET_MCP_HTTP_ENABLED` — typed by the operator, to either
 *            value. Wins and LOCKS the switch (the rule): a deploy that
 *            names it has decided, and a dashboard that could overrule an
 *            environment file is how two people debug two configs.
 *   stored   `instance_settings.mcp_http` — the switch on Studio ›
 *            Integrations › MCP, flipped by an owner. The self-host's case.
 *   default  off. An agent-reachable surface is a decision, not a default —
 *            and an owner's click is a decision, a more visible one than a
 *            line in an env file nobody reads twice.
 *
 * Read live, cached for ten seconds like the address, so the switch counts
 * from the next request and restarts nothing.
 */
export interface ResolvedMcpHttp {
  enabled: boolean;
  source: "env" | "stored" | "default";
  updatedAt?: Date;
}

interface StoredMcpHttp {
  enabled: boolean;
}

const KEY = "mcp_http";
const TTL_MS = 10_000;
// Keyed by org for the same reason the address's cache is: one process, one
// instance in v1, but the test suite runs many schemas through one process.
const cache = new Map<string, { at: number; value: ResolvedMcpHttp }>();

export function invalidateMcpHttp(): void {
  cache.clear();
}

/** Set in the environment, to either value — `describe()` knows the difference from the registry's default. */
export function mcpHttpPinned(cfg: Config): boolean {
  return cfg.describe().some((v) => v.name === "SNAGSET_MCP_HTTP_ENABLED" && v.source === "env");
}

export async function resolveMcpHttp(sql: postgres.Sql, keys: Keyring, cfg: Config): Promise<ResolvedMcpHttp> {
  if (mcpHttpPinned(cfg)) return { enabled: cfg.bool("SNAGSET_MCP_HTTP_ENABLED"), source: "env" };
  const orgId = await firstOrgId(sql).catch(() => null);
  const hit = cache.get(orgId ?? "");
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: ResolvedMcpHttp = { enabled: false, source: "default" };
  if (orgId) {
    const stored = await readSetting<StoredMcpHttp>(sql, keys, orgId, KEY).catch(() => null);
    if (stored && typeof stored.value?.enabled === "boolean") {
      value = { enabled: stored.value.enabled, source: "stored", updatedAt: stored.updatedAt };
    }
  }
  cache.set(orgId ?? "", { at: Date.now(), value });
  return value;
}

/** What the routes hold instead of a boolean frozen at boot. */
export type McpHttpSource = () => Promise<ResolvedMcpHttp>;

export function mcpHttpSource(sql: postgres.Sql, keys: Keyring, cfg: Config): McpHttpSource {
  return () => resolveMcpHttp(sql, keys, cfg);
}

export async function setMcpHttp(sql: postgres.Sql, keys: Keyring, orgId: string, enabled: boolean, by: string | null): Promise<void> {
  await writeSetting(sql, keys, { orgId, key: KEY, value: { enabled } satisfies StoredMcpHttp, secret: null, updatedBy: by });
  invalidateMcpHttp();
}

export async function forgetMcpHttp(sql: postgres.Sql, orgId: string): Promise<void> {
  await clearSetting(sql, orgId, KEY);
  invalidateMcpHttp();
}

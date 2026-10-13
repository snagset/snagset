import type postgres from "postgres";
import type { Context } from "hono";
import type { Keyring } from "./keys.ts";
import { readSetting } from "./instance/settings.ts";

/**
 * The plan seam — the mechanism, the boundary.
 *
 * The cloud adds NUMBERS, never mechanisms: how many sites, how
 * many members, whether the pixel tier and the integrations are on. Every
 * self-host is unlimited, and the rule makes that a promise — nothing here
 * withholds a feature on someone else's deployment. Three sources, in the
 * order they win:
 *
 *   resolver  `createApp({ planResolver })` — the private caller's answer for
 *             the org, from its plan (Stripe's word, the ladder). Absent on
 *             every self-host and every dev machine.
 *   stored    `instance_settings.limits` — numbers an operator set by hand.
 *             No screen for it; a self-host that wants a cap writes the row.
 *   default   unlimited.
 *
 * Read live per org, cached ten seconds like the address, so a plan change
 * counts from the next request. Reviewers are never counted anywhere:
 * the two numbers are sites and memberships, the two booleans are the pixel
 * tier and the integrations.
 */
export interface PlanLimits {
  /** Live sites the studio may have; null is unlimited. */
  projects: number | null;
  /** Memberships — owners, admins, members; null is unlimited. Never reviewers. */
  members: number | null;
  /** Whether screenshots and uploads are offered at all (with a bucket). */
  screenshots: boolean;
  /** Whether the tracker and Slack cards may connect. */
  integrations: boolean;
  /** Bytes of pictures the studio may hold across its sites; null is unlimited. L4's per-project ceiling still applies underneath. */
  storageBytes: number | null;
}

export const UNLIMITED: PlanLimits = { projects: null, members: null, screenshots: true, integrations: true, storageBytes: null };

/** What the private caller gives `createApp`: the org's limits, from its plan. A partial answer is filled from the defaults. */
export type PlanResolver = (org: { id: string; plan: string }) => Promise<Partial<PlanLimits> | null | undefined> | Partial<PlanLimits> | null | undefined;

export interface ResolvedLimits extends PlanLimits {
  source: "resolver" | "stored" | "default";
}

/** What the routes hold: the org's limits, read live. */
export type LimitsSource = (orgId: string) => Promise<ResolvedLimits>;

const KEY = "limits";
const TTL_MS = 10_000;
const cache = new Map<string, { at: number; value: ResolvedLimits }>();

export function invalidateLimits(): void {
  cache.clear();
}

/** Only the four keys, only their shapes: a stray string in a stored row is ignored, never a crash. */
export function normaliseLimits(raw: unknown): Partial<PlanLimits> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<PlanLimits> = {};
  for (const k of ["projects", "members", "storageBytes"] as const) {
    const v = r[k];
    if (v === null) out[k] = null;
    else if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  for (const k of ["screenshots", "integrations"] as const) {
    if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  }
  return out;
}

export function limitsSource(sql: postgres.Sql, keys: Keyring, resolver?: PlanResolver): LimitsSource {
  return async (orgId) => {
    const hit = cache.get(orgId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    let value: ResolvedLimits = { ...UNLIMITED, source: "default" };
    const stored = await readSetting(sql, keys, orgId, KEY).catch(() => null);
    if (stored) value = { ...value, ...normaliseLimits(stored.value), source: "stored" };
    if (resolver) {
      const [org] = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
        return tx<{ plan: string }[]>`SELECT plan FROM orgs WHERE id = ${orgId}::uuid`;
      });
      const answer = await resolver({ id: orgId, plan: org?.plan ?? "selfhost" });
      if (answer) value = { ...value, ...normaliseLimits(answer), source: "resolver" };
    }
    cache.set(orgId, { at: Date.now(), value });
    return value;
  };
}

/** The counts the numbers are measured against, under the org's claim. Storage is bucket bytes summed over the studio's sites (L4's per-project counters). */
export async function usage(tx: postgres.TransactionSql | postgres.Sql, orgId: string): Promise<{ projects: number; members: number; storageBytes: number }> {
  const [p] = await tx<{ n: number; bytes: number }[]>`SELECT count(*)::int AS n, COALESCE(sum(storage_bytes_used), 0)::float8 AS bytes FROM projects WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL`;
  const [m] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM memberships WHERE org_id = ${orgId}::uuid`;
  return { projects: p?.n ?? 0, members: m?.n ?? 0, storageBytes: Number(p?.bytes ?? 0) };
}

/** Thrown inside a transaction that has counted; the route turns it into the 403. */
export class LimitReached extends Error {
  readonly resource: "projects" | "members" | "integrations" | "screenshots" | "storage";
  readonly limit: number;
  readonly used: number;
  constructor(resource: "projects" | "members" | "integrations" | "screenshots" | "storage", limit: number, used: number) {
    super(`${resource}: ${used} of ${limit}`);
    this.name = "LimitReached";
    this.resource = resource;
    this.limit = limit;
    this.used = used;
  }
}

const NOUN = { projects: "sites", members: "members", integrations: "the integrations", screenshots: "screenshots", storage: "picture storage" } as const;

/**
 * `403 plan_limit_reached`. The sentence names the number and
 * what to do about it without naming a price: a self-host with a hand-set
 * row reads it the same way a cloud studio does, and the cloud's own
 * caller is the one that knows what the next plan costs.
 */
export function planLimitReached(c: Context, e: LimitReached) {
  const message =
    e.resource === "projects" || e.resource === "members"
      ? `This studio's plan allows ${e.limit} ${NOUN[e.resource]} and it has ${e.used}. Remove one, or move to a plan with more.`
      : `This studio's plan does not include ${NOUN[e.resource]}. Move to a plan that does.`;
  return c.json(
    { error: { code: "plan_limit_reached", message, details: { resource: e.resource, limit: e.limit, used: e.used }, requestId: c.get("requestId") } },
    403,
  );
}

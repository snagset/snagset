import type postgres from "postgres";
import type { Config } from "../config.ts";
import type { Keyring } from "../keys.ts";
import { firstOrgId, readSetting, writeSetting, clearSetting } from "./settings.ts";

/**
 * The instance's public address, the mail row's shape for the
 * one value every link is built from.
 *
 * Three sources, in the order they win:
 *
 *   env      `SNAGSET_BASE_URL` — typed by the operator, or filled from the
 *            platform's own variable. Wins and LOCKS the setting,
 *            because a proxy or a platform routes to it.
 *   stored   `instance_settings.address` — set at claim time from the owner's
 *            own browser (it is what they typed to get there), editable on
 *            Studio › General. The self-host's normal case.
 *   default  `http://localhost:<port>` — a laptop before anyone has claimed.
 *
 * Never a request's `Host` header: one forged request would send the next
 * mailed review link to the forger's domain. Read live, cached for ten
 * seconds like the mailer, so an owner who edits the row restarts nothing.
 */
export interface ResolvedAddress {
  url: string;
  source: "env" | "stored" | "default";
  updatedAt?: Date;
}

export interface StoredAddress {
  url: string;
}

const TTL_MS = 10_000;
// Keyed by org: one process serves one instance in v1, but the test suite
// runs many schemas through one process, and a cached answer from the last
// one is not this one's.
const cache = new Map<string, { at: number; value: ResolvedAddress }>();

export function invalidateAddress(): void {
  cache.clear();
}

/**
 * The rule, applied before storage: an absolute origin, https unless
 * it is loopback, nothing after the host. Returns the origin, or the
 * sentence that says why not.
 */
export function validateAddress(raw: string): { ok: true; origin: string } | { ok: false; reason: string } {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "The address is a full URL, like https://review.kilnwork.studio." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "The address starts with https:// (or http:// on this machine)." };
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname.endsWith(".localhost");
  if (u.protocol === "http:" && !loopback) {
    return { ok: false, reason: "A public address needs https:// — review links and sign-in cookies do not survive plain http." };
  }
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
    return { ok: false, reason: "Just the origin — no path, query or fragment. Every link is built from it." };
  }
  return { ok: true, origin: u.origin };
}

/**
 * Set in the environment — typed, or filled by the platform. The
 * registry's default is not a pin, and the config is the one party that
 * knows the difference: `describe()` says where each value came from.
 */
export function addressPinned(cfg: Config): boolean {
  return cfg.describe().some((v) => v.name === "SNAGSET_BASE_URL" && v.source === "env" && !!v.value);
}

export async function resolveAddress(sql: postgres.Sql, keys: Keyring, cfg: Config): Promise<ResolvedAddress> {
  if (addressPinned(cfg)) return { url: cfg.required("SNAGSET_BASE_URL").replace(/\/+$/, ""), source: "env" };
  const orgId = await firstOrgId(sql).catch(() => null);
  const hit = cache.get(orgId ?? "");
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const fallback: ResolvedAddress = { url: `http://localhost:${cfg.int("SNAGSET_PORT")}`, source: "default" };
  let value = fallback;
  if (orgId) {
    const stored = await readSetting<StoredAddress>(sql, keys, orgId, "address").catch(() => null);
    if (stored && typeof stored.value?.url === "string") {
      const v = validateAddress(stored.value.url);
      if (v.ok) value = { url: v.origin, source: "stored", updatedAt: stored.updatedAt };
    }
  }
  cache.set(orgId ?? "", { at: Date.now(), value });
  return value;
}

/** The function every link-builder holds instead of a string frozen at boot. */
export type AddressSource = () => Promise<string>;

export function addressSource(sql: postgres.Sql, keys: Keyring, cfg: Config): AddressSource {
  return async () => (await resolveAddress(sql, keys, cfg)).url;
}

export async function storeAddress(sql: postgres.Sql, keys: Keyring, orgId: string, origin: string, by: string | null): Promise<void> {
  await writeSetting(sql, keys, { orgId, key: "address", value: { url: origin } satisfies StoredAddress, secret: null, updatedBy: by });
  invalidateAddress();
}

export async function forgetAddress(sql: postgres.Sql, orgId: string): Promise<void> {
  await clearSetting(sql, orgId, "address");
  invalidateAddress();
}

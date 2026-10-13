import { storageKey } from "@snagset/types/names";
import type { Snag } from "./types.ts";

/**
 * `snag:counts:<origin>` — written by the runtime, read by the stub.
 *
 * This is the whole of the dormant badge. A returning reviewer sees the
 * unresolved count before the runtime has loaded, from a local read inside a
 * try/catch — never from the network. Draft 1 of 02 had the stub fire a count
 * query on every page load, which on the recommended production install would
 * have pinged the review host from **every visitor's browser**, disclosing IP,
 * UA and route to a vendor those visitors never heard of. That is deleted, with
 * no replacement, and this file is what replaces it.
 *
 * On a first visit there is no cache and the badge is absent — correct
 * behaviour, not a degradation (A1 corrigendum, verbatim).
 */

/** The design owns this shape, because the runtime writes it and the stub reads it. */
export interface Counts {
  /** Schema version. */
  v: 1;
  /** Project-wide open count. */
  p: number;
  /** Per-route open counts, keyed by route. */
  r: Record<string, number>;
  /** ISO write timestamp. */
  t: string;
}

/** Capped at 64 routes (LRU) and 4 KB serialised. */
const MAX_ROUTES = 64;
const MAX_BYTES = 4096;

const key = (origin: string): string => storageKey.counts(origin);

/** Unresolved is what a badge means — a resolved snag is not waiting for anyone. */
const openCount = (snags: Snag[]): number => snags.filter((s) => s.status !== "resolved").length;

/**
 * Recompute and store. Called after every change, and cheap enough to be: the
 * whole point is that the NEXT page load can paint a badge without asking
 * anyone anything.
 */
export function writeCounts(origin: string, all: Snag[], route: string): Counts | null {
  // Derived from `all`, NOT merged into whatever was cached last time. The
  // first version merged, and it thrashed: over budget the rule below drops
  // `r`, so the next write started from an empty map and grew back, cycling
  // every dozen or so writes. `all` already holds every route the adapter has,
  // which makes the merge unnecessary as well as wrong.
  const byRoute = new Map<string, { n: number; seen: string }>();
  for (const s of all) {
    const cur = byRoute.get(s.route) ?? { n: 0, seen: "" };
    if (s.status !== "resolved") cur.n++;
    if (s.updatedAt > cur.seen) cur.seen = s.updatedAt;
    byRoute.set(s.route, cur);
  }
  // The route being viewed always appears, even at zero: "none here" is a fact
  // worth caching, and its absence would read as "not visited yet".
  if (!byRoute.has(route)) byRoute.set(route, { n: 0, seen: new Date().toISOString() });

  // LRU by last activity, and the current route survives the trim regardless.
  const ordered = [...byRoute.entries()].sort((a, b) => b[1].seen.localeCompare(a[1].seen));
  const keep = ordered.slice(0, MAX_ROUTES);
  if (!keep.some(([k]) => k === route)) keep[keep.length - 1] = [route, byRoute.get(route)!];

  let counts: Counts = {
    v: 1,
    p: openCount(all),
    r: Object.fromEntries(keep.map(([k, v]) => [k, v.n])),
    t: new Date().toISOString(),
  };

  // Over budget, drop `r` and keep `p`: a project-wide number is
  // still a true number, whereas a truncated per-route map would be quietly
  // wrong for whichever routes fell off.
  if (JSON.stringify(counts).length > MAX_BYTES) counts = { ...counts, r: {} };

  try {
    localStorage.setItem(key(origin), JSON.stringify(counts));
  } catch {
    // Quota or storage disabled. The badge is a nicety; losing it must never
    // cost the reviewer anything, so unlike a thread write this one is silent.
    return null;
  }
  return counts;
}

/**
 * Read the cache. Any parse failure, quota error or missing key is swallowed
 * and the badge is simply absent — this runs on a stranger's page,
 * and data written by a version we have never seen is the expected case, not
 * an exceptional one.
 */
export function readCounts(origin: string): Counts | null {
  try {
    const raw = localStorage.getItem(key(origin));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as Partial<Counts>;
    if (c.v !== 1 || typeof c.p !== "number") return null;
    return { v: 1, p: c.p, r: typeof c.r === "object" && c.r ? c.r : {}, t: String(c.t ?? "") };
  } catch {
    return null;
  }
}

/** What `data-snag-badge="route"` shows; `"project"` reads `p` instead. */
export function badgeFor(counts: Counts | null, route: string): number {
  return counts?.r[route] ?? 0;
}

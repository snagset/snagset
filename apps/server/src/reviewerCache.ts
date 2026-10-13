import type postgres from "postgres";
import { maintenance } from "./db/scope.ts";

/**
 * `reviewers.identity_valid_after`, cached for ten seconds, and the
 * half of that was never built.
 *
 * ── THE GAP THIS CLOSES ──
 *
 * The spec says per-identity revocation "is checked on refresh **and on the
 * 10-second cache miss path**, not on every request". Only the refresh check
 * existed. So calling the host app's logout hook — which is what sets this
 * column — left the signed-out person working until their token next
 * refreshed: up to the full 15-minute sliding TTL, not the ten seconds a
 * reader of that sentence would expect.
 *
 * Project-wide revocation was never affected. `session_epoch` rides the
 * project cache and is compared on every request at no cost, so revoking a
 * LINK has always been ~10 s. It is the per-PERSON case — one reviewer signed
 * out while the round continues — that ran wide.
 *
 * ── WHY A CACHE AND NOT A QUERY ──
 *
 * `bearerAuth` makes **zero** database reads per request, deliberately: verify
 * the JWT, compare `epo` against a project row that was already in memory.
 * Adding a per-request lookup would trade that property away for a column that
 * is null for almost every reviewer almost always.
 *
 * Ten seconds per REVIEWER instead: one query per active reviewer per window,
 * which for a review round is a handful of queries a minute. That is what the
 * spec's "10-second cache miss path" means, and it lands the revoke inside the
 * same window the link revoke already lives in.
 *
 * Modelled on `projectCache` deliberately, down to the in-flight map: a cold
 * cache under load would otherwise send one identical query per concurrent
 * request, which is the stampede the cache exists to prevent.
 */

export interface ReviewerCache {
  /**
   * The instant before which this reviewer's sessions are void, or null when
   * they have never been signed out.
   *
   * Returns null when the row is missing, and that is correct rather than
   * lenient: a session whose subject does not exist fails on its own at the
   * first write, and inventing a revocation here would turn a deleted-reviewer
   * bug into a confusing "you have been signed out".
   */
  validAfter(reviewerId: string): Promise<Date | null>;
  /** Drop an entry, so an operator who revokes sees it on THIS node at once. */
  invalidate(reviewerId: string): void;
}

interface Entry {
  at: number;
  value: Date | null;
}

export function createReviewerCache(
  sql: postgres.Sql,
  opts: { ttlMs?: number; now?: () => number } = {},
): ReviewerCache {
  const ttl = opts.ttlMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<Date | null>>();

  async function load(id: string): Promise<Date | null> {
    const [row] = await maintenance(sql, (tx) => tx<{ identity_valid_after: Date | null }[]>`
      SELECT identity_valid_after FROM reviewers WHERE id = ${id}::uuid
    `);
    return row?.identity_valid_after ?? null;
  }

  return {
    async validAfter(reviewerId) {
      const hit = entries.get(reviewerId);
      if (hit && now() - hit.at < ttl) return hit.value;

      const running = inflight.get(reviewerId);
      if (running) return running;

      const p = load(reviewerId)
        .then((value) => {
          entries.set(reviewerId, { at: now(), value });
          return value;
        })
        .finally(() => inflight.delete(reviewerId));
      inflight.set(reviewerId, p);
      return p;
    },
    invalidate(reviewerId) {
      entries.delete(reviewerId);
    },
  };
}

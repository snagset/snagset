import { RESERVED_URL_PARAMS } from "@snagset/types/names";

/**
 * The query-parameter policy, the Vercel problem.
 *
 * Vercel documents the failure this file inverts: comments left on pages with
 * query params may not appear at the base URL, with a dashboard wildcard
 * search as the workaround. That is a search feature papering over a
 * storage-key mistake. Our rule: parameters are STRIPPED from page identity
 * unless the host names them significant — and nothing is lost, because the
 * full raw URL stays in `CaptureContext.url` and the detail card offers
 * "open with original query".
 *
 * The reserved denylist is GENERATED (`RESERVED_URL_PARAMS`,
 * exported by @snagset/types) and never restated here — draft 1 of the spec
 * stripped two parameter names nothing ever emitted while missing the ones
 * that do appear, and generating from the registry is what makes that class
 * of bug impossible. It is NOT overridable: every member is a permalink or a
 * QA switch, and if one of them split a route, opening a thread permalink
 * would hide the pin the permalink points at.
 */

/** The tracking-parameter shapes, verbatim. */
const TRACKING: readonly RegExp[] = [
  /^utm_/,
  /^(gclid|gbraid|wbraid|fbclid|msclkid|ttclid|twclid|igshid|yclid|li_fat_id)$/,
  /^(mc_cid|mc_eid|_hsenc|_hsmi|vero_id|oly_enc_id|oly_anon_id)$/,
  /^_vercel_/,
  /^__vercel_/,
  /^_rsc$/,
];

/**
 * The FRAGMENT half is included defensively: The design puts the review-link
 * secret in the fragment precisely so it never reaches a server, but a URL
 * where `snag_k` has been hand-moved into the query must not make it a page
 * identity either — the DoD asserts it absent from `PageRef.query` on
 * exactly that fixture.
 */
const RESERVED: readonly string[] = [...RESERVED_URL_PARAMS.query, ...RESERVED_URL_PARAMS.fragment];

export function isIgnoredQueryParam(name: string, ignored: readonly string[] = []): boolean {
  if (RESERVED.includes(name)) return true;
  if (ignored.includes(name)) return true;
  return TRACKING.some((re) => re.test(name));
}

export interface QueryPolicy {
  /** `'*'` reproduces Vercel's exact-match behaviour minus the reserved set. */
  significantQueryParams?: readonly string[] | "*";
  ignoredQueryParams?: readonly string[];
}

/**
 * `PageRef.query` carries ONLY the significant keys, or is
 * absent entirely. Both-absent counts as equal in the match rule, so an empty
 * object must never be emitted where `undefined` is meant.
 */
export function significantQuery(search: string, policy: QueryPolicy = {}): Record<string, string> | undefined {
  const sig = policy.significantQueryParams ?? [];
  if (sig !== "*" && sig.length === 0) return undefined;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of params) {
    if (isIgnoredQueryParam(k, policy.ignoredQueryParams ?? [])) continue;
    if (sig !== "*" && !sig.includes(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** For every significant key, stored and current must agree. */
export function queryMatches(
  pin: Record<string, string> | undefined,
  current: Record<string, string> | undefined,
  policy: QueryPolicy = {},
): boolean {
  const sig = policy.significantQueryParams ?? [];
  if (sig === "*") {
    const a = pin ?? {};
    const b = current ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (a[k] !== b[k]) return false;
    return true;
  }
  for (const k of sig) {
    if ((pin?.[k] ?? undefined) !== (current?.[k] ?? undefined)) return false;
  }
  return true;
}

import { SignJWT, jwtVerify, errors as joseErrors, type JWTPayload } from "jose";
import { randomUUID } from "node:crypto";
import { PRODUCT, ID_PREFIX } from "@snagset/types/names";
import type { Keyring } from "./keys.ts";

/**
 * The widget's bearer session.
 *
 * HS256 via `jose`, signed under `HKDF(SNAGSET_SECRET_KEY, 'reviewer-session')`.
 * Sessions are signed and stateless because they are high-frequency and
 * short-lived; review links are opaque and stateful because they are the
 * opposite (the closing decision).
 *
 * TWO CLOCKS, and confusing them is the subtle bug this module is shaped to
 * prevent:
 *
 *   `exp`  — 15 minutes, slides on every refresh. The token's life.
 *   `iat`  — when the SESSION began. Carried forward UNCHANGED across every
 *            refresh, because `refreshableUntil` is derived from it and a
 *            re-stamped `iat` would slide the 12-hour absolute cap forever.
 *
 * The table reads `min(review_link.expires_at, iat + ABSOLUTE_TTL)`. Read
 * with a fresh `iat` per token, that expression re-bases every 15 minutes and
 * the cap never arrives — a reviewer stays authenticated indefinitely off one
 * exchange, which is precisely what an absolute cap exists to stop. `iat`
 * means "this session began", not "this token was signed". The spec's own
 * claim list has no session-start member, which is what makes `iat` that
 * member.
 *
 * `sid` is likewise stable across refreshes (one session, one id) while `jti`
 * is fresh per token.
 */

export type SessionKind = "guest" | "link" | "verified";

/** The `permissions`. The two that decide what a session may SEE and route
 *  are minted here and never inferred from a request (the table). */
export type Permission =
  | "thread:create"
  | "comment:create"
  | "thread:resolve"
  | "thread:delete:own"
  | "thread:private"
  | "thread:assign";

export const PERMISSIONS: readonly Permission[] = [
  "thread:create",
  "comment:create",
  "thread:resolve",
  "thread:delete:own",
  "thread:private",
  "thread:assign",
];

/** The claim set, closed at 14 members. */
export interface SessionClaims {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  env: string;
  kind: SessionKind;
  lnk: string | null;
  perm: Permission[];
  epo: number;
  /** Identity-envelope expiry — verified sessions only, a HARD ceiling. */
  iex?: number;
}

export interface MintInput {
  projectUid: string;
  reviewerId: string;
  environmentKey: string;
  kind: SessionKind;
  reviewLinkId: string | null;
  permissions: Permission[];
  sessionEpoch: number;
  /** Absent on a first exchange; carried forward on refresh. */
  sid?: string;
  iat?: number;
  iex?: number;
  /** `review_links.expires_at` as epoch seconds — the link's own ceiling. */
  linkExpiresAt?: number;
}

export interface Ttls {
  /** `SNAGSET_SESSION_TTL_S` — the sliding window, 900. */
  slidingS: number;
  /** `SNAGSET_SESSION_ABSOLUTE_TTL_S` — the hard cap, 43200. */
  absoluteS: number;
}

export interface MintedSession {
  token: string;
  claims: SessionClaims;
  expiresAt: Date;
  refreshableUntil: Date;
}

/**
 * `refreshableUntil` — the table, verbatim.
 *
 * Every row is a `min()` against `iat + ABSOLUTE_TTL`, so no credential can
 * outlive the absolute cap however generous its own expiry is. The two extra
 * ceilings are the ones that would otherwise be silently discarded: a link's
 * `expires_at`, and `iex`, the identity envelope's expiry — records that
 * draft 1 checked `iex` at exchange and threw it away, so a host app signing a
 * sensible 5-minute envelope still handed out an 8-hour credential that
 * refreshed forever.
 */
function refreshableUntil(kind: SessionKind, iat: number, ttls: Ttls, linkExpiresAt?: number, iex?: number): number {
  const cap = iat + ttls.absoluteS;
  if (kind === "link") return Math.min(linkExpiresAt ?? cap, cap);
  if (kind === "verified") return Math.min(cap, iex ?? cap);
  return cap;
}

export function mintSession(
  keys: Keyring,
  input: MintInput,
  ttls: Ttls,
  now: () => Date = () => new Date(),
): Promise<MintedSession> {
  const nowS = Math.floor(now().getTime() / 1000);
  // Carried forward on refresh, minted on first exchange. See the header:
  // re-stamping `iat` slides the absolute cap forever.
  const iat = input.iat ?? nowS;
  const sid = input.sid ?? randomUUID();
  const exp = nowS + ttls.slidingS;
  const until = refreshableUntil(input.kind, iat, ttls, input.linkExpiresAt, input.iex);

  const claims: SessionClaims = {
    iss: PRODUCT.toLowerCase(),
    aud: input.projectUid,
    sub: input.reviewerId,
    sid,
    jti: randomUUID(),
    iat,
    nbf: nowS,
    // A token must never outlive the window it can be refreshed within —
    // otherwise the last token issued before the cap stays valid past it.
    exp: Math.min(exp, until),
    env: input.environmentKey,
    kind: input.kind,
    lnk: input.reviewLinkId,
    perm: input.permissions,
    epo: input.sessionEpoch,
    ...(input.iex ? { iex: input.iex } : {}),
  };

  return new SignJWT(claims as unknown as JWTPayload)
    .setProtectedHeader({ alg: "HS256", kid: keys.kid })
    .sign(keys.derive("reviewer-session"))
    .then((token) => ({
      token,
      claims,
      expiresAt: new Date(claims.exp * 1000),
      refreshableUntil: new Date(until * 1000),
    }));
}

export type VerifyFailure =
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "expired"
  | "wrong_project"
  | "session_revoked";

export type VerifyResult =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: VerifyFailure };

/**
 * Verify a presented bearer.
 *
 * `expectedEpoch` is the project's current `session_epoch`, read from the 10 s
 * cache — which is what makes revocation cost nothing per request. A
 * mismatch is `session_revoked`, not `expired`: the reviewer is not late, they
 * have been signed out, and the two need different copy (F-19 vs F-18b).
 *
 * `allowExpired` is for the REFRESH path only. The design allows refreshing "an
 * expiring or recently expired token", and the alternative — refusing a token
 * that lapsed while a laptop was shut — is the four-re-auths-an-afternoon
 * behaviour the design calls a bug rather than a policy.
 */
export async function verifySession(
  keys: Keyring,
  token: string,
  opts: {
    projectUid: string;
    expectedEpoch: number;
    /** Refresh path only — see `clockTolerance` below. */
    allowExpired?: boolean;
    /** How far past `exp` the refresh path tolerates: the absolute cap. */
    absoluteTtlS?: number;
    now?: () => Date;
  },
): Promise<VerifyResult> {
  const now = opts.now ?? (() => new Date());
  const ttlToleranceS = opts.absoluteTtlS ?? 43_200;

  // The header is read BEFORE verification to find the key, which is the whole
  // point of `kid`. An unknown kid is refused rather than falling back to
  // trying every key — see keys.ts.
  let kid: string | undefined;
  try {
    const [rawHeader] = token.split(".");
    if (!rawHeader) return { ok: false, reason: "malformed" };
    kid = (JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8")) as { kid?: string }).kid;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!kid) return { ok: false, reason: "malformed" };

  const key = keys.forKid(kid, "reviewer-session");
  if (!key) return { ok: false, reason: "unknown_key" };

  let claims: SessionClaims;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: PRODUCT.toLowerCase(),
      audience: opts.projectUid,
      currentDate: now(),
      /**
       * On the REFRESH path, tolerate a token that has already lapsed.
       *
       * The design allows refreshing "an expiring or recently expired token", and
       * jose has no "ignore exp" switch — so the tolerance is widened to the
       * absolute cap, and `withinRefreshWindow()` applies the real bound
       * afterwards against the ORIGINAL `iat`. Nothing is loosened: a token
       * past the 12-hour cap still fails there, and this path is reachable
       * only when the caller asks for it.
       *
       * NOT `currentDate: new Date(0)`, which was the first attempt: moving
       * the clock to 1970 makes every token fail its `nbf` instead, and the
       * refresh silently stops working for a reason the error does not name.
       */
      clockTolerance: opts.allowExpired ? ttlToleranceS : 5,
    });
    claims = payload as unknown as SessionClaims;
  } catch (e) {
    // jose's TYPED errors, not its message text: the strings are not API and
    // matching them made a wrong-project token report as a bad signature,
    // which sends a reviewer to "something is broken" instead of "this link is
    // for a different site".
    if (e instanceof joseErrors.JWTExpired) return { ok: false, reason: "expired" };
    if (e instanceof joseErrors.JWTClaimValidationFailed) {
      return { ok: false, reason: e.claim === "aud" ? "wrong_project" : "malformed" };
    }
    return { ok: false, reason: "bad_signature" };
  }

  // A session minted before the project's epoch was bumped is revoked — the
  // zero-query half .4's revocation story.
  if (claims.epo !== opts.expectedEpoch) return { ok: false, reason: "session_revoked" };

  if (typeof claims.sub !== "string" || !claims.sub) return { ok: false, reason: "malformed" };

  return { ok: true, claims };
}

/** Is this session still inside its refresh window? The absolute cap. */
export function withinRefreshWindow(
  claims: SessionClaims,
  ttls: Ttls,
  linkExpiresAt?: number,
  now: () => Date = () => new Date(),
): boolean {
  const until = refreshableUntil(claims.kind, claims.iat, ttls, linkExpiresAt, claims.iex);
  return Math.floor(now().getTime() / 1000) < until;
}

/** `rev_…` — the wire identity a session's `sub` becomes on the way out. */
export const reviewerWireId = (uuid: string): string => ID_PREFIX.reviewer + uuid;

import { storageKey } from "@snagset/types/names";

/**
 * The reviewer's bearer session, held in `sessionStorage` under
 * `snag:session:<uid>`.
 *
 * `sessionStorage`, never `localStorage` and never a cookie, and each of those
 * three is a separate decision the design makes:
 *
 *  - Not `localStorage`: a review session must not outlive the tab. A shared
 *    machine at a client's office is the normal case, not the exotic one.
 *  - Not a cookie: no cookie is used for API auth, which is exactly why no
 *    widget route needs CSRF machinery.
 *  - Per project, because a token's `aud` is a project uid — one browser
 *    reviewing two instrumented sites holds two unrelated sessions.
 *
 * THE RAW LINK TOKEN IS NEVER PERSISTED, and
 * all say so, and asserts the absence of any `snag:k:` key. Only the
 * derived session is stored. The cost is stated rather than hidden: after the
 * absolute cap, or after a tab reload once the in-memory copy is gone, the
 * reviewer re-opens their link. That is the correct trade — a persisted link
 * token is a long-lived bearer credential sitting in web storage, and
 * T-the residual-risk claim rests on it not being there.
 */

export interface StoredSession {
  token: string;
  /** Epoch ms. When this passes, a refresh is due — not a re-prompt. */
  expiresAt: number;
  /** Epoch ms. When THIS passes, the reviewer must re-open their link. */
  refreshableUntil: number;
  reviewerId: string;
  permissions: string[];
  /** T8/: the round NUMBER a review link pins its reviewer to, when the
   *  session was minted (or last refreshed with one) from a round-pinned
   *  link. Absent for an unpinned link and for a guest. Stored beside the
   *  bearer rather than fetched separately — the HTTP adapter reads this to
   *  default `GET …/threads`'s `?round` without a second round trip, and a
   *  future round dropdown reads it as the initial selection. */
  round?: number;
  /**
   * The studio member's name, present only on a session minted by
   * "Sign in with Snagset" (the dashboard popup, `panels/signin.ts`) rather
   * than by the exchange. It is what tells the composer to stop asking for a
   * name, and the adapter to stop re-exchanging when a stored guest name
   * differs — that re-exchange is a GUEST one, and it would quietly replace
   * the member with the person they were before signing in. Carried across
   * refreshes; gone with the session.
   */
  member?: string;
  /** That member is a studio owner or admin — Delete on every comment.
   *  Only what to draw; the server checks the membership on each delete. */
  moderator?: boolean;
  /**
   * The name this session was EXCHANGED with, so the adapter can tell when the
   * reviewer has since typed a different one. It lived in memory alone, so
   * every page load of a named guest found "no name exchanged yet", re-ran the
   * exchange, and paid a round trip before its first read. Carried across
   * refreshes, which present no name.
   */
  name?: string;
}

const key = (uid: string): string => storageKey.session(uid);

/**
 * WHERE: a guest's or link reviewer's session in `sessionStorage`, for the
 * reasons at the top of this file. A STUDIO MEMBER's in `localStorage`
 * they sign in once per browser, as on any tool they work in all
 * day, and a new tab of the client's site already knows them. The shared
 * office machine that rule protects is the client's, not the studio's; a
 * member's session still ends at the same absolute cap, and "Sign out" clears
 * it for every tab.
 */
function parse(raw: string | null): StoredSession | null {
  if (!raw) return null;
  const v = JSON.parse(raw) as StoredSession;
  return typeof v?.token === "string" && typeof v?.refreshableUntil === "number" ? v : null;
}

export function readSession(uid: string): StoredSession | null {
  try {
    const tab = parse(sessionStorage.getItem(key(uid)));
    if (tab) return tab;
    const kept = parse(localStorage.getItem(key(uid)));
    return kept?.member ? kept : null;
  } catch {
    // Private-mode Safari and partitioned iframes throw on access. A reviewer
    // there re-exchanges on every page, which works and is slower — not a
    // broken widget.
    return null;
  }
}

export function writeSession(uid: string, s: StoredSession): void {
  try {
    if (s.member) {
      localStorage.setItem(key(uid), JSON.stringify(s));
      sessionStorage.removeItem(key(uid));
    } else {
      sessionStorage.setItem(key(uid), JSON.stringify(s));
    }
  } catch {
    /* see readSession */
  }
}

export function clearSession(uid: string): void {
  try {
    sessionStorage.removeItem(key(uid));
    localStorage.removeItem(key(uid));
  } catch {
    /* see readSession */
  }
}

/** Due for a refresh — 30 s early, so a request in flight when the token
 *  lapses does not become the reviewer's problem. */
export const needsRefresh = (s: StoredSession, now = Date.now()): boolean => now > s.expiresAt - 30_000;

/** Past the 12-hour cap: re-opening the link is the only way back (F-18b). */
export const isFinished = (s: StoredSession, now = Date.now()): boolean => now >= s.refreshableUntil;

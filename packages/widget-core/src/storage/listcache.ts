import { storageKey } from "@snagset/types/names";
import type { Snag } from "./types.ts";

/**
 * `snag:list:<uid>:<class>` — the last thread list this browser was shown,
 * per environment and round, so the dock can paint it while the network
 * answers (stale-while-revalidate).
 *
 * Without it every page load opened the dock onto "No comments yet" until
 * the list came back, which on a live client site read as "this round is
 * empty" — the one sentence a reviewer acts on by leaving.
 *
 * WHERE, and why it is two places: the class is what the list was read WITH.
 * A studio member's session can see studio-private threads and lives in
 * `localStorage` (session.ts), so their copy goes there too; a guest's
 * or link reviewer's session lives in `sessionStorage`, so theirs does. The
 * cache therefore never outlives the credential that read it, and a guest
 * never reads a member's copy — it is in a different store under a different
 * key, not merely filtered on the way out.
 *
 * A TEAM link's session sees studio-private threads too and is still
 * the `guest` class: it lives in `sessionStorage`, so its copy does, and the
 * adapter drops both classes whenever a different reviewer's session takes
 * over the tab (http.ts `end()`), and paints nothing while a new link is
 * being presented (`cached()`). The class names the store, not the view.
 *
 * ONE key per project and class, holding every env/round slot, so dropping a
 * class on sign-out is one `removeItem` rather than a scan of the store.
 */
export type ListClass = "member" | "guest";

/** The serialised cap. A list this big is a project, not a page of review —
 *  past it the write is SKIPPED (and the stale copy dropped) rather than
 *  pushing the host page's own storage toward its quota. */
const MAX = 1_000_000;

const area = (c: ListClass): Storage => (c === "member" ? localStorage : sessionStorage);

function load(uid: string, c: ListClass): Record<string, Snag[]> {
  // Version-checked: a shape written by a release we have never seen is the
  // expected case on a long-lived member browser, and it reads as "no cache".
  const v = JSON.parse(area(c).getItem(storageKey.list(uid, c)) ?? "0") as { v?: number; m?: Record<string, Snag[]> };
  return v?.v === 1 && v.m && typeof v.m === "object" ? v.m : {};
}

/** The cached list for one env/round slot, or null. Never throws. */
export function readList(uid: string, c: ListClass, slot: string): Snag[] | null {
  try {
    const d = load(uid, c)[slot];
    return Array.isArray(d) ? d : null;
  } catch {
    return null;
  }
}

/** Store one slot's list. Over the cap the write is skipped and the key goes
 *  with it: a stale copy of a list too big to store would be worse than none,
 *  and the next write starts from empty. Never throws: this is a nicety, and
 *  the eager chunk it ships in has a byte budget, so it stays this small. */
export function writeList(uid: string, c: ListClass, slot: string, d: Snag[]): void {
  const k = storageKey.list(uid, c);
  try {
    let m: Record<string, Snag[]> = {};
    try {
      m = load(uid, c);
    } catch {
      /* unreadable: start over */
    }
    m[slot] = d;
    const s = JSON.stringify({ v: 1, m });
    if (s.length > MAX) area(c).removeItem(k);
    else area(c).setItem(k, s);
  } catch {
    /* quota, or storage denied: the next load fetches, as it always did */
  }
}

/** Forget a class's copy for this project — sign-out, a revoked or refused
 *  session, a different identity. Never throws. */
export function dropList(uid: string, c: ListClass): void {
  try {
    area(c).removeItem(storageKey.list(uid, c));
  } catch {
    /* see writeList */
  }
}

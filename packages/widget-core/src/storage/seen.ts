import { storageKey } from "@snagset/types/names";
import type { Snag } from "./types.ts";

/**
 * Read/unread, and client-local by decision (the note).
 *
 * There is deliberately no route for this. The *See new activity · n* pill
 * and the per-row unread dot are computed here from a
 * last-seen timestamp the widget keeps itself. The consequences are stated in
 * 05 rather than discovered: unread is PER DEVICE, so the same person reading
 * on a laptop still has dots on their phone, and clearing site data marks
 * everything read. Server-side seen state is v2 and it is not free.
 *
 * WHERE IT LIVES, and why the spec was amended to let it live there.
 *
 * The note put this "beside the thread cache in `snag:threads:<uid>:<env>`",
 * and the design said "No other key exists". It was built that way first — a sidecar
 * record inside the same array, shaped so an older build's `.filter(isSnag)`
 * would drop it rather than choke on it. That much worked. Three things it also
 * did, none of them predicted:
 *
 *  1. Every reader of that array had to learn what a thread is not. Twelve test
 *     sites parsed it directly and started counting a record that was not a
 *     comment.
 *  2. The threads key came into existence BEFORE any thread was in it, because
 *     marking your own new thread seen happens at creation. Anything treating
 *     "the key exists" as "there is work here" got a race it never had.
 *  3. Two writers on one key: the adapter had to carry a record it knew nothing
 *     about through every write, or silently delete a reviewer's read-state on
 *     the next comment they filed.
 *
 * So it has its own registered key. Losing a seen-map is cosmetic — some dots
 * come back — and it should not be able to reach the one store that holds the
 * reviewer's actual work.
 */

/** thread id → epoch ms it was last looked at. */
type SeenMap = Record<string, number>;

export interface SeenStore {
  /** For `isUnread`. */
  map(): ReadonlyMap<string, number>;
  /** Opening a detail clears THAT thread's dot (the first level). */
  mark(id: string): void;
  /** Closing the dock marks everything seen (the second level). */
  markAll(snags: readonly Snag[]): void;
}

/**
 * Two levels of "seen", deliberately (DESIGN.md Q2(vi)): opening a
 * detail clears that thread's dot so triage continues in place with the rest
 * intact; closing the dock clears them all. One without the other gives you
 * either a counter that never moves or a list that empties on the first read.
 */
export function createSeenStore(uid: string, env: string, now = (): number => Date.now()): SeenStore {
  const key = storageKey.seen(uid, env);
  let cache: SeenMap | null = null;

  function read(): SeenMap {
    if (cache) return cache;
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      // Anything else — an array, a string, a half-written entry — reads as
      // "nothing seen", which shows a reviewer MORE than they have read rather
      // than less. That is the safe direction for this particular lie.
      return (cache = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as SeenMap)
        : {});
    } catch {
      return (cache = {});
    }
  }

  function write(next: SeenMap): void {
    cache = next;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Denied or full. This is read-state, not work: it must never throw a
      // quota error into a path that is trying to save a comment.
    }
  }

  return {
    map: () => new Map(Object.entries(read())),
    mark(id) {
      write({ ...read(), [id]: now() });
    },
    markAll(snags) {
      const t = now();
      const next = { ...read() };
      for (const s of snags) next[s.id] = t;
      write(next);
    },
  };
}

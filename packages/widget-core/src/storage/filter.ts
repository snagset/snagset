import type { Snag, Status } from "./types.ts";

/**
 * The filter model — VERBATIM. The plan said "the ListFilter
 * object M1 already carries"; M1 never built it, so this is where it first
 * exists, defaults per the spec, and the one-code-path promise holds
 * from here on.
 *
 * THE SPLIT IS THE RULE: `statuses`, `read`, `by`, `assignee`,
 * `page` govern the list AND the pins — they are properties of a comment,
 * and a statement about which comments matter should be true on the page as
 * well as in the panel. `q`, `pageOnly`, `newOnly`, `sort` are ways of narrowing
 * what you are reading right now and NEVER touch the pins — applying them
 * to the page would make the pins flicker while someone types in a search
 * box. Asserts the split on the rendered bytes.
 *
 * PERSISTED PER TAB, under the registered `snag:filter:<uid>:<env>`
 * (filterstore.ts). Before it, deferred persistence
 * .6 had a key, and the filter reset on every document load — which on a
 * multi-page site meant opening a comment on another page threw the chips
 * away. sessionStorage, so a new tab or a restart still starts from the
 * defaults, and the registry diff still governs what is written.
 *
 * One SOURCE module: the runtime bundles only the pin-governing
 * predicate; the dock chunk bundles the list machinery. Rollup keeps what
 * each chunk uses, which is what keeps the eager half inside the envelope.
 */
export interface ListFilter {
  /** Multi-select, never empty in the UI: all four lit is the default and
   *  means "no filter"; `[]` is read the same way for safety. */
  statuses: Status[];
  read: "all" | "unread" | "read";
  /** Reviewer id. */
  by?: string;
  /**
   * Who the snag is WITH — a reviewer id, or `null` for "Unassigned".
   * Absent means anyone. Options come from the round's own snags, not from
   * `listAssignees`, which only a session holding thread:assign can call.
   */
  assignee?: string | null;
  /** PageRef.route — never the raw URL, NEVER origin. */
  page?: string;
  /** Substring over body + author, client-side, list only. */
  q?: string;
  pageOnly: boolean;
  /** The "See new activity" pill. */
  newOnly: boolean;
  sort: "page" | "newest" | "oldest";
}

/** The four canonical statuses, .1's order — the chip grid's rows. */
export const ALL_STATUSES: readonly Status[] = ["open", "progress", "review", "resolved"];

export function defaultFilter(): ListFilter {
  return { statuses: [...ALL_STATUSES], read: "all", pageOnly: false, newOnly: false, sort: "page" };
}

/**
 * Pastel's model: the chips start all lit, and at least one stays lit — the
 * last lit chip does not turn off, so the list can never be empty because of
 * the status row alone.
 */
export function toggleStatus(current: readonly Status[], s: Status): Status[] {
  if (!current.includes(s)) return [...current, s];
  return current.length > 1 ? current.filter((x) => x !== s) : [...current];
}

/** "Clear": back to the one status that matters first, as Pastel does. */
export const CLEARED_STATUSES: readonly Status[] = ["open"];

/** Does the status row hide anything? All four lit (or none) does not. */
export function statusNarrows(statuses: readonly Status[]): boolean {
  return statuses.length > 0 && !ALL_STATUSES.every((st) => statuses.includes(st));
}

/**
 * The PIN-governing predicate — the eager half. `read` is judged
 * against the seen map when one exists; with no seen model loaded every
 * thread passes, which is also v0's behaviour (every field at default).
 *
 * F-07b: an unknown status is "not hidden by a status filter it cannot
 * match" — the statuses test only hides the four values it can name.
 */
export function pinPass(s: Snag, f: ListFilter, seenAt?: ReadonlyMap<string, number>): boolean {
  if (statusNarrows(f.statuses) && (ALL_STATUSES as readonly string[]).includes(s.status) && !f.statuses.includes(s.status)) {
    return false;
  }
  if (f.by && s.createdBy.id !== f.by) return false;
  if (f.assignee !== undefined && (s.assignee?.id ?? null) !== f.assignee) return false;
  if (f.page && s.route !== f.page) return false;
  if (f.read !== "all" && seenAt) {
    const unread = isUnread(s, seenAt);
    if (f.read === "unread" && !unread) return false;
    if (f.read === "read" && unread) return false;
  }
  return true;
}

/** A thread is unread while activity postdates the reviewer's last look. */
export function isUnread(s: Snag, seenAt: ReadonlyMap<string, number>): boolean {
  const seen = seenAt.get(s.id) ?? 0;
  return Date.parse(s.updatedAt) > seen;
}

/**
 * The LIST-only narrowing (2/5): q over every comment body
 * (first + replies, tombstones as "") and author names, case-insensitive,
 * live per keystroke; page-only against the current route; the pill against
 * the seen map. Never called by the pin path.
 */
export function listNarrow(
  snags: Snag[],
  f: ListFilter,
  currentRoute: string,
  seenAt?: ReadonlyMap<string, number>,
): Snag[] {
  let out = snags;
  if (f.pageOnly) out = out.filter((s) => s.route === currentRoute);
  if (f.newOnly && seenAt) out = out.filter((s) => isUnread(s, seenAt));
  const q = f.q?.trim().toLowerCase();
  if (q) {
    out = out.filter(
      (s) =>
        s.comments.some(
          (c) => (c.body ?? "").toLowerCase().includes(q) || c.author.name.toLowerCase().includes(q),
        ) || s.createdBy.name.toLowerCase().includes(q),
    );
  }
  return out;
}

/**
 * *Newest first · Oldest first · By page*. Date sorts flatten
 * the list; `page` keeps the dock's stable grouped order (the dock owns
 * grouping — this returns the input untouched for it). Creation time, not
 * updatedAt: "newest" is about when a comment entered the round, and a reply
 * reordering the whole list mid-read is the flicker bans elsewhere.
 */
export function sortSnags(snags: Snag[], sort: ListFilter["sort"]): Snag[] {
  if (sort === "page") return snags;
  const by = (a: Snag, b: Snag): number => Date.parse(a.createdAt) - Date.parse(b.createdAt);
  const asc = [...snags].sort(by);
  return sort === "oldest" ? asc : asc.reverse();
}

export interface StatusCounts {
  all: number;
  byStatus: Map<string, number>;
}

/**
 * Chip counts read the WHOLE round (search placeholder "counts the
 * round"; F-07b: unknown statuses count in the `all` total but in no status
 * chip — they get their own neutral entry under their raw value).
 */
export function countStatuses(snags: Snag[]): StatusCounts {
  const byStatus = new Map<string, number>();
  for (const s of snags) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  return { all: snags.length, byStatus };
}

/** The Filter button's `· n` — active facets of ITS panel (Marked as / by /
 *  Assigned to / Pages). */
export function activeFacets(f: ListFilter): number {
  return (f.read !== "all" ? 1 : 0) + (f.by ? 1 : 0) + (f.assignee !== undefined ? 1 : 0) + (f.page ? 1 : 0);
}

import { storageKey } from "@snagset/types/names";
import { ALL_STATUSES, defaultFilter, type ListFilter } from "./filter.ts";

/**
 * `snag:filter:<uid>:<env>` — the round's ListFilter, carried across document
 * loads within one tab.
 *
 * WHY: opening a comment that lives on another page is a real navigation on a
 * multi-page site (jump.ts), and the runtime that comes up on the far
 * side used to start from `defaultFilter()`. A reviewer working "In progress,
 * assigned to me" lost both on every jump, and read it as the filter being
 * broken. On an SPA the same filter survived, because it lived in memory; the
 * site's architecture was deciding whether the widget remembered.
 *
 * WHAT: everything an SPA navigation keeps, so the two kinds of site behave
 * alike — statuses, read, by, assignee, page, q, pageOnly, sort — and NOT
 * `newOnly`. The pill is a view over "unseen since the dock last closed", it
 * is cleared by closing the dock and by reading the last new thread, and
 * restoring it into a fresh load would open onto "You're caught up" over an
 * empty list.
 *
 * WHERE: sessionStorage, as `snag:mode` and the handoff are — a filter is
 * "what I am doing in this tab right now", so a new tab or a restart starts
 * from the defaults. Per project and env, as `seen` is; NOT per round, so a
 * round switch keeps the filter just as it does in memory.
 *
 * Every access is try/catch and a bad read is "no saved filter": versioned,
 * and each field that does not validate falls back to its default rather than
 * reaching pinPass with a shape it never expected. It is in the eager chunk
 * (the first paint needs it), so it stays this small.
 */
export function readFilter(uid: string, env: string): ListFilter | null {
  try {
    const o = JSON.parse(sessionStorage.getItem(storageKey.filter(uid, env)) ?? "0") as Record<string, unknown>;
    if (o?.v !== 1) return null;
    const f = defaultFilter();
    const st = ALL_STATUSES.filter((x) => Array.isArray(o.statuses) && o.statuses.includes(x));
    if (st.length) f.statuses = st;
    if (o.read === "unread" || o.read === "read") f.read = o.read;
    if (o.sort === "newest" || o.sort === "oldest") f.sort = o.sort;
    if (o.pageOnly === true) f.pageOnly = true;
    for (const k of ["by", "page", "q"] as const) if (typeof o[k] === "string" && o[k]) f[k] = o[k] as string;
    if (o.assignee === null || (typeof o.assignee === "string" && o.assignee)) f.assignee = o.assignee;
    return f;
  } catch {
    return null;
  }
}

/** Store the filter, minus `newOnly`. Never throws: a tab that cannot store
 *  it gets today's behaviour, a filter that resets on the next load. */
export function writeFilter(uid: string, env: string, f: ListFilter): void {
  try {
    const { newOnly: _view, ...keep } = f;
    sessionStorage.setItem(storageKey.filter(uid, env), JSON.stringify({ v: 1, ...keep }));
  } catch {
    /* quota, or storage denied */
  }
}

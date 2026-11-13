import { storageKey } from "@snagset/types/names";

/**
 * The cross-route handoff.
 *
 * A widget injected by one `<script>` tag cannot drive the host's router — it
 * does not know which router the host has. So a cross-page jump is a real
 * document load, and the panel state has to survive it. The design specifies the
 * mechanism: a `sessionStorage` handoff carrying `{ openThreadId }`, written
 * BEFORE navigation and cleared on consumption, because a redirect or an
 * aggressive cache can eat the load — and its absence must land on the LIST,
 * never on a blank dock.
 *
 * Session-scoped for the same reason `mode` is: a handoff that outlived the tab
 * would reopen a detail nobody asked for, days later.
 *
 * This half lives in the RUNTIME because it is consumed at boot, before the
 * panels chunk exists. The scroll half is in the panels chunk, where the dock it
 * has to measure around is (`panels/scroll.ts`).
 */

export function writeHandoff(win: Window, id: string): void {
  try {
    win.sessionStorage.setItem(storageKey.handoff, JSON.stringify({ openThreadId: id }));
  } catch {
    /* storage disabled — navigate anyway and land on the list, .5 */
  }
}

/**
 * Read the handoff and clear it in the same breath.
 *
 * Cleared BEFORE the value is parsed, deliberately: a corrupt entry that threw
 * on the way out would otherwise stay in storage and throw again on every load
 * for the rest of the session.
 */
export function takeHandoff(win: Window): string | null {
  try {
    const raw = win.sessionStorage.getItem(storageKey.handoff);
    if (raw === null) return null;
    win.sessionStorage.removeItem(storageKey.handoff);
    const parsed = JSON.parse(raw) as { openThreadId?: unknown };
    return typeof parsed.openThreadId === "string" ? parsed.openThreadId : null;
  } catch {
    return null;
  }
}

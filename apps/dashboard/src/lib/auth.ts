/**
 * How the last load in this browser ended — so the front door paints the
 * likely truth first and confirms it behind.
 *
 * If the last load ended signed out (an expired session is the common way to
 * arrive), the sign-in form paints NOW and `/api/v1/me` runs behind it; the
 * ~550 ms that call spends validating a stale cookie against Neon was the
 * whole of the loading screen the maintainer kept seeing "before going into the sign
 * in". If `/me` unexpectedly succeeds — signed in elsewhere since — the app
 * replaces the form.
 *
 * Dashboard-local, like the theme key: it never crosses a package boundary,
 * so it is not the names registry's.
 */
const LAST_AUTH_KEY = "snagset:last-auth";

export type LastAuth = "in" | "out";

export function lastAuth(): LastAuth | null {
  try {
    const v = localStorage.getItem(LAST_AUTH_KEY);
    return v === "in" || v === "out" ? v : null;
  } catch {
    return null;
  }
}

export function rememberAuth(v: LastAuth): void {
  try {
    localStorage.setItem(LAST_AUTH_KEY, v);
  } catch {
    /* not remembered; the next load simply waits like it used to */
  }
}

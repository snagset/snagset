import { DOM_EVENT_PREFIX, NPM_PACKAGE } from "@snagset/types/names";
import type { MemberSession } from "../storage/types.ts";

/**
 * "Sign in with Snagset", the widget's half.
 *
 * A studio member reviewing a client's site is signed in to the DASHBOARD,
 * on the server's own origin, with a first-party cookie the client's page
 * can neither see nor send (it is another site, and third-party cookies are
 * not a thing to build on). So the widget does not ask: it opens a popup on
 * the dashboard, the dashboard confirms with the member and mints a session
 * for THIS page's origin (`POST …/sessions/member`, which checks the origin
 * is the site's), and posts it back here with that exact origin as its
 * target. The popup closes itself; the session is stored by the adapter as
 * any exchange's is.
 *
 * TWO CHECKS ON EVERY MESSAGE, and both are load-bearing:
 *
 *   `event.origin` is the server's — anything else on the page (an ad
 *   frame, a browser extension, the host app's own messaging) can post a
 *   `{type: "snagset:session"}` too, and a session accepted from it would
 *   make whoever sent it the author of the next comment;
 *
 *   `event.source` is the popup WE opened — the server's origin is not
 *   unique to it (the dashboard could be open in an iframe on the page, or
 *   a second popup), and only the window the member just confirmed in
 *   speaks for this sign-in.
 *
 * The listener exists only while the popup does, and it is the only one.
 */

/** The message's `type` — composed from the registry, as the dashboard's
 *  page (`apps/dashboard/src/routes/widget-signin.tsx`) composes it. */
export const SIGNIN_MESSAGE = `${DOM_EVENT_PREFIX}session`;

/** Is this message the dashboard handing back a session? Pure, so it is tested without a DOM. */
export function isSessionMessage(
  ev: { origin: string; source: unknown; data: unknown },
  serverOrigin: string,
  popup: unknown,
): ev is { origin: string; source: unknown; data: { type: string; session: MemberSession } } {
  if (ev.origin !== serverOrigin || !popup || ev.source !== popup) return false;
  const d = ev.data as { type?: unknown; session?: { sessionToken?: unknown; reviewer?: { name?: unknown } } } | null;
  return (
    !!d &&
    d.type === SIGNIN_MESSAGE &&
    typeof d.session?.sessionToken === "string" &&
    typeof d.session.reviewer?.name === "string"
  );
}

/** The dashboard page that asks — `/widget-signin` (apps/dashboard). */
export function signInUrl(host: string, uid: string, pageOrigin: string, env?: string): string {
  const q = new URLSearchParams({ project: uid, origin: pageOrigin });
  if (env) q.set("env", env);
  return `${new URL(host).origin}/widget-signin?${q}`;
}

/**
 * Open the popup and wait. Resolves with the session, with null when the
 * member closed the window without confirming, and with `"blocked"` when the
 * browser refused to open one at all — which needs saying, because nothing
 * else on screen changes.
 *
 * Must be called from the click itself: a popup opened after an `await` is
 * not a user-initiated one, and every browser blocks it.
 */
export function signIn(host: string, uid: string, env?: string): Promise<MemberSession | null | "blocked"> {
  const server = new URL(host).origin;
  const popup = window.open(signInUrl(host, uid, location.origin, env), `${NPM_PACKAGE}-signin`, "popup,width=480,height=600");
  if (!popup) return Promise.resolve("blocked");
  return new Promise((resolve) => {
    let closedSeen = 0;
    const done = (v: MemberSession | null): void => {
      removeEventListener("message", onMessage);
      clearInterval(poll);
      resolve(v);
    };
    const onMessage = (ev: MessageEvent): void => {
      if (isSessionMessage(ev, server, popup)) done(ev.data.session);
    };
    addEventListener("message", onMessage);
    // The member may simply close the window. Seen closed on TWO ticks, not
    // one: the dashboard posts and then closes itself, and a single check
    // landing between the two would resolve null with the session's message
    // still queued behind it.
    const poll = setInterval(() => {
      if (popup.closed && ++closedSeen > 1) done(null);
    }, 400);
  });
}

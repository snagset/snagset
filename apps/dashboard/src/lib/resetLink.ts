import { inviteToken } from "./invite.ts";

/**
 * The reset link's page, as decisions that can be proved without a browser
 * `<address>/reset#<token>`.
 *
 * The token has an invite's shape and rides in the fragment for an invite's
 * reason, so it is read by the same strict reader.
 */
export const linkToken = inviteToken;

/** Where a dead link sends the person next. */
export type LinkNext = "sign-in" | "forgot";

/**
 * Why a link does not work, as a heading and the one useful next step. The
 * server's sentence is kept as the body; this chooses the words above it and
 * the link below, so "used" and "expired" read as two situations.
 *
 * A used link points at sign-in, because it may have been you. An expired or
 * unknown one points back at where a new link is asked for.
 */
export function resetProblem(code: string | null): { title: string; next: LinkNext } {
  switch (code) {
    case "link_used":
      return { title: "This reset link has been used", next: "sign-in" };
    case "link_expired":
      return { title: "This reset link has expired", next: "forgot" };
    case "quota_exceeded":
      return { title: "Too many attempts", next: "forgot" };
    default:
      return { title: "This reset link does not work", next: "forgot" };
  }
}

export const NEXT_LABEL: Record<LinkNext, string> = {
  "sign-in": "Sign in",
  forgot: "Ask for a new link",
};

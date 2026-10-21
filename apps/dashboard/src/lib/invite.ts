import { withArticle } from "@snagset/types/roles";

/**
 * The invite page's two decisions, outside the component so they can be
 * proved without a browser.
 *
 * The link is `<address>/invite#<token>`: the token rides in the FRAGMENT,
 * which a browser never sends — not to this server's log, not in a Referer —
 * the argument review links' `#snag_k=` made first. So this page is the one
 * place that reads it, and it reads it strictly: 43 characters of unpadded
 * base64url, the shape the server mints, or nothing. A mangled paste is told
 * so here rather than spending a rate-limited lookup on it.
 */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function inviteToken(hash: string): string | null {
  const raw = hash.replace(/^#/, "").trim();
  // Tolerate a `token=` spelling, in case a mail client or a person wrote one.
  const value = raw.startsWith("token=") ? raw.slice(6) : raw;
  return TOKEN.test(value) ? value : null;
}

/**
 * Why a link does not work, as a heading and a next step. The server's
 * sentence is kept as the body — it carries the date an invite expired — and
 * this only chooses the words above it, so "expired", "used" and "withdrawn"
 * read as three different situations rather than one generic error.
 */
export function inviteProblem(code: string | null): { title: string; signIn: boolean } {
  switch (code) {
    case "invite_used":
      return { title: "This invite has been used", signIn: true };
    case "invite_expired":
      return { title: "This invite has expired", signIn: false };
    case "invite_revoked":
      return { title: "This invite was withdrawn", signIn: false };
    case "quota_exceeded":
      return { title: "Too many attempts", signIn: false };
    default:
      return { title: "This invite link does not work", signIn: false };
  }
}

/** "an owner" / "an admin" / "a member" — the article is the one thing a template gets wrong. */
export function asRole(role: string): string {
  return withArticle(role);
}

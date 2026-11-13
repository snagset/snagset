/**
 * Who in a studio may do what, the `member` seat wired.
 *
 * ONE TABLE, read by the server's routes and the dashboard alike, so the
 * button a page draws and the answer the route gives cannot come from two
 * ideas of a role. Until the rule was string compares scattered across
 * a dozen route files (`role === "owner" || role === "admin"`), and every
 * route that compared nothing quietly meant "anyone with a cookie", which was
 * harmless only while every cookie belonged to an owner or an admin.
 *
 * The acts are coarse on purpose. A route asks one question in its own words
 * ("may this person change the site's settings?"), and the finer rule that
 * only a route can know — a member deletes their OWN comment, an admin
 * invites only members, an admin revokes only their own agent token — stays
 * in that route beside the data it needs.
 *
 *   review     comment, reply, edit and delete one's own words, change
 *              status, assign, start a round, move comments between rounds,
 *              add reviewers, sign in from the widget, keep one's own agent
 *              tokens. Everyone in the studio but a viewer.
 *   moderate   delete somebody else's comment or thread.
 *   settings   a site's settings and existence (add, delete, addresses,
 *              domain, audience, widget switch, guest status), its rounds'
 *              shape (rename, close, reopen, archive, restore, delete), its
 *              tracker connections and the issues made through them.
 *   invite     mint, mail and withdraw invites. An admin's are for members
 *              only (`invitable`).
 *   tokens     see every agent token in the studio, not only one's own.
 *   people     change a role, remove somebody, invite an owner or an admin.
 *   studio     rename the studio; what the instance is connected to.
 *
 * `viewer` is in the enum since 0001 and holds nothing here: a read-only
 * seat is still undesigned (01 F-27), and an empty row is the honest way to
 * say so — every route that asks refuses it.
 */

export type StudioRole = "owner" | "admin" | "member" | "viewer";

export type StudioAct = "review" | "moderate" | "settings" | "invite" | "tokens" | "people" | "studio";

const ACTS: Record<StudioRole, readonly StudioAct[]> = {
  owner: ["review", "moderate", "settings", "invite", "tokens", "people", "studio"],
  admin: ["review", "moderate", "settings", "invite", "tokens"],
  member: ["review"],
  viewer: [],
};

/** Whether a role may do an act. An unknown role (a value from a newer server) may do nothing. */
export function can(role: string | null | undefined, act: StudioAct): boolean {
  return !!role && (ACTS[role as StudioRole]?.includes(act) ?? false);
}

/** The roles somebody may be given — by invite or by a role change — and in the order a picker lists them. */
export const ASSIGNABLE_ROLES = ["owner", "admin", "member"] as const satisfies readonly StudioRole[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Which roles this person may put on an invite: an owner any of the three, an admin a member, anyone else none. */
export function invitable(role: string | null | undefined): AssignableRole[] {
  if (can(role, "people")) return [...ASSIGNABLE_ROLES];
  if (can(role, "invite")) return ["member"];
  return [];
}

/** One line per role, for the invite dialog and the role picker. */
export const ROLE_SUMMARY: Record<AssignableRole, string> = {
  owner: "Everything, including who is in the studio and what the instance is connected to.",
  admin: "Everything about sites, rounds, integrations and comments; invites members.",
  member: "Comments, status, assignees and rounds on every site; no settings.",
};

/** "an owner", "an admin", "a member" — for a sentence. */
export function withArticle(role: string): string {
  return role === "owner" ? "an owner" : role === "admin" ? "an admin" : role === "member" ? "a member" : `a ${role}`;
}

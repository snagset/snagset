import type { Me } from "./api";

/**
 * Whether the studio on screen is the operator's: the one that claimed the
 * instance, and the only one that sees or changes what the instance is
 * connected to. Outside the components so it can be proved without a browser.
 *
 * An instance with sign-up open holds many studios and still has one address,
 * one bucket, one mail transport and one remote MCP switch. From any studio
 * but the operator's the server refuses those routes with a 403, so a page
 * there leaves the rows out: it does not ask, and it has no refusal to draw.
 *
 * Only an explicit `false` leaves them out. A server from before the field
 * existed sends none, and on that server every studio could read and change
 * them; treating a missing answer as "no" would take the rows away from the
 * one studio a self-host has.
 */
export function isOperator(me: Pick<Me, "org">): boolean {
  return me.org.operator !== false;
}

/**
 * Which storage row Studio › General draws for this studio.
 *
 *   instance  the operator's studio: Storage and Mail as the instance has
 *             them, with the address above, all read from the instance.
 *   usage     any other studio whose plan caps its pictures: that one number
 *             which is the studio's own and comes with `/me`.
 *   none      any other studio: no row. The bucket is not theirs to see.
 */
export function storageRow(me: Pick<Me, "org" | "limits">): "instance" | "usage" | "none" {
  if (isOperator(me)) return "instance";
  return me.limits.storage.limit === null ? "none" : "usage";
}

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { can, type StudioAct } from "@snagset/types/roles";
import { useMe } from "./me";

export { can, invitable, ROLE_SUMMARY, withArticle, type AssignableRole, type StudioAct } from "@snagset/types/roles";

/**
 * What the signed-in person may do, from the same table the server's routes
 * read (`@snagset/types/roles`). The role comes from `/api/v1/me`,
 * live, so a page re-renders the moment a refetch says it changed; the
 * server refuses whatever a stale page still offers.
 */
export function useCan(): (act: StudioAct) => boolean {
  const role = useMe().user.role;
  return (act) => can(role, act);
}

/**
 * The queries whose ANSWER depends on the role, not only on the studio: a
 * member's token list is their own, an admin's is everybody's; the instance
 * and the studio-wide integrations answer 403 below admin. When `/me` comes
 * back with a different role — somebody promoted or demoted you while the tab
 * was open — those are reset rather than shown from the old seat's cache,
 * and a page showing one asks again at once.
 */
const ROLE_SHAPED = [["mcp-tokens"], ["instance"], ["integrations"], ["invites"], ["members"]] as const;

export function useForgetOnRoleChange(): void {
  const role = useMe().user.role;
  const qc = useQueryClient();
  const was = useRef(role);
  useEffect(() => {
    if (was.current === role) return;
    was.current = role;
    for (const queryKey of ROLE_SHAPED) void qc.resetQueries({ queryKey });
  }, [role, qc]);
}

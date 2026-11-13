import { useSuspenseQuery } from "@tanstack/react-query";
import { q } from "./query";
import type { Me } from "./api";

/**
 * The signed-in account, LIVE. The `_app` route's `beforeLoad` proves there is
 * one before any of this renders, so the suspense query resolves from cache
 * instantly; components read it here rather than from route context so a
 * rename or a new site re-renders them without a navigation.
 */
export function useMe(): Me {
  return useSuspenseQuery(q.me()).data;
}

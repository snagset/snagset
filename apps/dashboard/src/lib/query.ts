import { QueryClient, queryOptions } from "@tanstack/react-query";
import { api, ApiFailure, type ThreadFilters } from "./api";

/**
 * One client, one key factory — data rules in code.
 *
 * READ ONCE, KEEP IT. Every screen used to set its list to null and refetch
 * on mount, so each navigation showed a skeleton for one Neon round trip
 * (300–500 ms from a laptop in Europe). With a 30 s freshness window the
 * screen you just left paints from memory and refreshes behind.
 *
 * The keys live here rather than at each call site for the reason every other
 * registry in this codebase exists: an invalidation that spells a key
 * differently from the query it means to refresh is a cache that never
 * refreshes, and nothing goes red.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // A 401 is an answer, not a hiccup: the session is gone and the gate
      // redirects. Retrying it three times is three more round trips before
      // the sign-in form.
      retry: (count, err) => {
        if (err instanceof ApiFailure && (err.status === 401 || err.status === 403 || err.status === 404)) return false;
        return count < 2;
      },
    },
  },
});

export const q = {
  me: () => queryOptions({ queryKey: ["me"] as const, queryFn: api.me }),
  /** Whether anyone has claimed this instance. Asked once per page load —
   *  it changes exactly once in an instance's life. */
  claimed: () => queryOptions({ queryKey: ["claimed"] as const, queryFn: api.claimed, staleTime: Infinity }),
  /** Claimed, and whether sign-up is open — the front door's two facts. */
  setupState: () => queryOptions({ queryKey: ["setup-state"] as const, queryFn: api.setupState, staleTime: Infinity }),
  meta: () => queryOptions({ queryKey: ["meta"] as const, queryFn: api.meta, staleTime: Infinity }),
  threads: (uid: string, f: ThreadFilters = {}) =>
    queryOptions({
      queryKey: ["threads", uid, f] as const,
      queryFn: () => api.threads(uid, f),
    }),
  rounds: (uid: string) => queryOptions({ queryKey: ["rounds", uid] as const, queryFn: () => api.rounds(uid) }),
  origins: (uid: string) => queryOptions({ queryKey: ["origins", uid] as const, queryFn: () => api.origins(uid) }),
  links: (uid: string) => queryOptions({ queryKey: ["links", uid] as const, queryFn: () => api.listLinks(uid) }),
  /** The assignee pool — single- to double-digit, and the server caches it 30 s too. */
  assignees: (uid: string) => queryOptions({ queryKey: ["assignees", uid] as const, queryFn: () => api.assignees(uid) }),
  members: () => queryOptions({ queryKey: ["members"] as const, queryFn: api.members }),
  /** The pending invites, and whether this instance can mail one. */
  invites: () => queryOptions({ queryKey: ["invites"] as const, queryFn: api.invites }),
  /** Every tracker connection in the studio, and one site's. */
  integrations: () => queryOptions({ queryKey: ["integrations"] as const, queryFn: api.integrations }),
  siteIntegrations: (uid: string) =>
    queryOptions({ queryKey: ["integrations", "site", uid] as const, queryFn: () => api.siteIntegrations(uid) }),
  /** What the instance is connected to. */
  instance: () => queryOptions({ queryKey: ["instance"] as const, queryFn: api.instance }),
  mcpTokens: () => queryOptions({ queryKey: ["mcp-tokens"] as const, queryFn: api.mcpTokens }),
};

/** Everything keyed under a site, for the invalidations that follow a site-level write. */
export const siteKeys = (uid: string) =>
  [["threads", uid], ["rounds", uid], ["origins", uid], ["links", uid], ["assignees", uid]] as const;

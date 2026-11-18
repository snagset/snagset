import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { NotFound } from "@/components/app/NotFound";
import type { QueryClient } from "@tanstack/react-query";

/** What every route can reach: the one query client (lib/query.ts). */
export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  // Signed out, or an address outside the shell: the same page, without the sidebar.
  notFoundComponent: NotFound,
});

import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { queryClient } from "./lib/query";
import { applyTheme, readTheme, watchSystemTheme } from "./lib/theme";
import { Toaster } from "./components/ui/sonner";
import "./index.css";
import { PagePending } from "./components/app/Pending";

/**
 * The dashboard. A React SPA on TanStack Router and Query,
 * served by the same Hono process as the API.
 *
 * `defaultPreload: "intent"` is fourth rule: hovering a site card
 * or a thread row runs its route's loader, so the click paints from a cache
 * that is already warm.
 */
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  // The pending screen appears only when a load is genuinely slow; a cached
  // route never shows it. 300 ms is under the threshold where a flash reads
  // as a fault, and the minimum keeps a slow one from flickering.
  defaultPendingMs: 300,
  defaultPendingMinMs: 200,
  // A page-shaped skeleton inside the shell, not a blank content area.
  // Routes outside the shell (sign-in, setup) name their own.
  defaultPendingComponent: PagePending,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function App() {
  useEffect(() => {
    applyTheme(readTheme());
    return watchSystemTheme();
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

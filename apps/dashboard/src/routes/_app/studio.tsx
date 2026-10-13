import { Outlet, createFileRoute } from "@tanstack/react-router";

/** The studio's own screens: General, Members, Integrations. */
export const Route = createFileRoute("/_app/studio")({
  loader: () => ({ crumb: "Studio" }),
  component: () => <Outlet />,
});

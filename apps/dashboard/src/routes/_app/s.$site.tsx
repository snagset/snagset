import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { rememberSite } from "@/lib/site";

/**
 * A site's own screens: Comments, Reviewers, Settings. The site is resolved
 * once here from the account already in context — a uid that is not one of
 * yours goes back to Sites rather than to an empty screen with a 403 behind it.
 */
export const Route = createFileRoute("/_app/s/$site")({
  beforeLoad: ({ context, params }) => {
    const site = context.me.projects.find((p) => p.uid === params.site);
    if (!site) throw redirect({ to: "/sites", replace: true });
    rememberSite(site.uid);
    return { site };
  },
  loader: ({ context }) => ({ crumb: context.site.name }),
  component: () => <Outlet />,
});

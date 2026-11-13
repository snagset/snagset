import { Link, Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { rememberSite } from "@/lib/site";
import { useMe } from "@/lib/me";

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
  component: SiteLayout,
});

/** An archived or over-plan site says so above every one of its screens. */
function SiteLayout() {
  const { site: uid } = Route.useParams();
  const site = useMe().projects.find((p) => p.uid === uid);
  const why = site?.archived
    ? "This site is archived. Its comments can be read; nothing new comes in and nothing can be changed."
    : site?.locked
      ? "This site is read-only: the studio has more sites than its plan includes. Archive a site, or move to a plan with more."
      : null;
  return (
    <>
      {why && (
        <div role="status" className="mx-7 mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-warn-soft px-4 py-2.5 text-[13px]">
          <span className="flex-1">{why}</span>
          <Link to="/s/$site/settings" params={{ site: uid }} className="font-medium text-foreground underline underline-offset-2">
            {site?.archived ? "Restore it" : "Site settings"}
          </Link>
        </div>
      )}
      <Outlet />
    </>
  );
}

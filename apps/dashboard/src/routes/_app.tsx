import { Outlet, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Gate } from "@/components/app/Gate";
import { Shell } from "@/components/app/Shell";
import { Waiting } from "@/components/app/Waiting";
import { ApiFailure } from "@/lib/api";
import { rememberAuth } from "@/lib/auth";
import { q } from "@/lib/query";
import { can } from "@/lib/roles";

/**
 * Everything signed-in lives under this pathless layout. Its `beforeLoad` is
 * the gate: one `/me`, from the cache when it is warm, and a redirect to the
 * front door — sign-in, or the claim on an instance nobody has claimed —
 * carrying where you were going so a deep link taken while signed out comes
 * back to it.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    try {
      const me = await context.queryClient.ensureQueryData(q.me());
      rememberAuth("in");
      // A studio whose one site has no address yet is a fresh claim: the first
      // run (/welcome) names it and gives it its address before anything else.
      //
      // `/me` says so itself (`addressed`); asking `/origins` here put a
      // second request IN SERIES in front of every screen of a one-site
      // studio — the usual studio. Only a server older than the field is asked.
      // Only for somebody who can answer it: the first run sets the site's
      // name and address, which is an admin's. A member who joins a
      // studio whose site is still bare lands on the work, not a form the
      // server would refuse.
      if (me.projects.length === 1 && can(me.user.role, "settings")) {
        const site = me.projects[0]!;
        const bare =
          site.addressed !== undefined
            ? !site.addressed
            : await context.queryClient
                .ensureQueryData(q.origins(site.uid))
                .then((o) => o.origins.length === 0 && !o.domain)
                .catch(() => false);
        if (bare) throw redirect({ to: "/welcome" });
      }
      return { me };
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) {
        rememberAuth("out");
        // Signed out is two situations wearing one face; only the server
        // knows which. A failure falls back to "claimed" — the sign-in form —
        // because a create-the-owner form on somebody's live instance is the
        // worse thing to show.
        const claimed = await context.queryClient.fetchQuery(q.claimed()).catch(() => true);
        throw redirect({
          to: claimed ? "/sign-in" : "/setup",
          search: claimed ? { redirect: location.pathname === "/" ? undefined : location.href } : {},
        });
      }
      throw err;
    }
  },
  pendingComponent: () => <Waiting what="Signing you in" />,
  errorComponent: ({ error }) => <Failed error={error} />,
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
});

function Failed({ error }: { error: unknown }) {
  const router = useRouter();
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <Gate>
      <div className="flex flex-col items-start gap-3">
        <h1 className="m-0 text-lg font-semibold">Could not load the dashboard</h1>
        <p className="m-0 text-muted-foreground">{message}</p>
        <Button variant="outline" size="sm" onClick={() => void router.invalidate()}>
          Try again
        </Button>
      </div>
    </Gate>
  );
}

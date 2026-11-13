import { useState } from "react";
import { createFileRoute, isRedirect, redirect, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, PartyPopperIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Gate } from "@/components/app/Gate";
import { InstallTag } from "@/components/app/InstallTag";
import { api, ApiFailure } from "@/lib/api";
import { rememberAuth } from "@/lib/auth";
import { q } from "@/lib/query";
import { cn } from "@/lib/utils";
import { Waiting } from "@/components/app/Waiting";

/**
 * The first run: three steps and a finish, one question
 * per screen. The claim already made the studio and one site (the server
 * names it "First project" and gives it no address); this names that site,
 * gives it its address, hands over the tag, and says what to do next.
 *
 * Reached only while the studio's single site has no address — the `_app`
 * gate sends a signed-in browser here in that state, and this route sends
 * everyone else on to Sites. Never shown again.
 */
export const Route = createFileRoute("/welcome")({
  beforeLoad: async ({ context }) => {
    let me;
    try {
      me = await context.queryClient.ensureQueryData(q.me());
    } catch (err) {
      if (isRedirect(err)) throw err;
      if (err instanceof ApiFailure && err.status === 401) {
        rememberAuth("out");
        throw redirect({ to: "/sign-in" });
      }
      throw err;
    }
    const site = me.projects.length === 1 ? me.projects[0]! : null;
    if (!site) throw redirect({ to: "/sites" });
    // The same answer the gate in `_app` reads, from the same place — two
    // sources could disagree and bounce a visit between here and Sites.
    const addressed =
      site.addressed ??
      (await context.queryClient
        .ensureQueryData(q.origins(site.uid))
        .then((where) => where.origins.length > 0 || !!where.domain)
        .catch(() => false));
    if (addressed) throw redirect({ to: "/sites" });
    return { me, site };
  },
  pendingComponent: () => <Waiting what="Loading your studio" />,
  component: Welcome,
});

const STEPS = ["Site", "Address", "Install"] as const;

function Welcome() {
  const { me, site } = Route.useRouteContext();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [name, setName] = useState(site.name === "First project" ? "" : site.name);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  // Which of the two buttons on step one is working: only that one spins, the other waits.
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState("");

  const skip = async () => {
    setBusy(true);
    setSkipping(true);
    setError("");
    try {
      await api.deleteSite(site.uid);
      // Fetched, not merely invalidated: the layout's gate reads /me through
      // the cache and would still see the one unnamed site, and send us back
      // here. Marked stale first, or `fetchQuery` hands back that same cached
      // answer — which went unnoticed while the gate asked /origins as well,
      // and the deleted site's 404 there happened to let us through. The
      // site's own queries go too — there is no site.
      qc.removeQueries({ queryKey: ["origins", site.uid] });
      await qc.invalidateQueries({ queryKey: q.me().queryKey });
      await qc.fetchQuery(q.me());
      void navigate({ to: "/sites", replace: true });
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Something went wrong. Try again.");
      setBusy(false);
      setSkipping(false);
    }
  };

  const save = async (patch: { name?: string; domain?: string }, then: () => void) => {
    setBusy(true);
    setError("");
    try {
      await api.editSite(site.uid, patch);
      // The gate in `_app` reads these from the cache with ensureQueryData,
      // which hands back stale data rather than refetching — so a mere
      // invalidation would send a finished first run straight back here. Set
      // what is known, and fetch what is not.
      if (patch.domain) qc.setQueryData(q.origins(site.uid).queryKey, { domain: patch.domain, origins: [] });
      await qc.invalidateQueries({ queryKey: q.me().queryKey });
      await qc.fetchQuery(q.me());
      then();
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-dvh bg-background">
      <Gate width={600}>
        <div className="absolute right-6 top-5 text-[12.5px] text-muted-foreground">Signed in as {me.user.email}</div>
        {step < 3 && (
          <ol className="m-0 mb-6 flex list-none items-center gap-3.5 p-0" aria-label="Steps">
            {STEPS.map((label, i) => (
              <li key={label} className="flex items-center gap-2.5 text-[13.5px] font-medium">
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full border-[1.5px] text-[12.5px]",
                    i < step && "border-brand bg-brand text-brand-foreground",
                    i === step && "border-brand text-brand ring-[3px] ring-brand-soft",
                    i > step && "border-line-strong text-muted-foreground",
                  )}
                  aria-current={i === step ? "step" : undefined}
                >
                  {i < step ? <CheckIcon className="size-3.5" /> : i + 1}
                </span>
                <span className={i === step ? "text-foreground" : "text-muted-foreground"}>{label}</span>
                {i < STEPS.length - 1 && <span className={cn("h-px w-[90px]", i < step ? "bg-brand" : "bg-border")} />}
              </li>
            ))}
          </ol>
        )}

        {error && (
          <p role="alert" className="m-0 mb-4 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}

        {step === 0 && (
          <Card className="gap-4 p-7">
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim() || busy) return;
                void save({ name: name.trim() }, () => setStep(1));
              }}
            >
              <div>
                <h1 className="m-0 text-[21px] font-semibold leading-tight tracking-tight">What is the site called?</h1>
                <p className="m-0 mt-2 text-muted-foreground">One client website. You can add more from Sites later.</p>
              </div>
              {/* The whole form waits while a save is in flight, not only the
                  button that sent it: a name typed now would be lost,
                  and a Skip would delete the site the save is naming. */}
              <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="first-name">Name</Label>
                  <Input id="first-name" placeholder="Kilnwork" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </div>
                <div className="flex items-center justify-between gap-3">
                  {/* A studio with no client site ready leaves the first
                      run here. The placeholder site the claim made goes with
                      it, so Sites opens empty rather than listing a site that
                      was never a site. */}
                  <Button type="button" variant="ghost" loading={skipping} disabled={busy && !skipping} onClick={() => void skip()}>
                    Skip for now
                  </Button>
                  <Button type="submit" loading={busy && !skipping} disabled={!name.trim() || skipping}>
                    {busy && !skipping ? "Saving…" : "Continue"}
                    <ArrowRightIcon />
                  </Button>
                </div>
              </fieldset>
              <p className="m-0 text-[12px] text-muted-foreground">No site yet? Skip, and add one from Sites when it is ready.</p>
            </form>
          </Card>
        )}

        {step === 1 && (
          <Card className="gap-4 p-7">
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!domain.trim() || busy) return;
                void save({ domain: domain.trim() }, () => setStep(2));
              }}
            >
              <div>
                <h1 className="m-0 text-[21px] font-semibold leading-tight tracking-tight">Where does {name || site.name} live?</h1>
                <p className="m-0 mt-2 text-muted-foreground">
                  Its domain. Every subdomain, scheme and port of it may run the widget — staging, previews, and
                  localhost while you build. Exact addresses elsewhere can be added in the site's settings.
                </p>
              </div>
              {/* Back too: leaving mid-save shows step one while the domain
                  is still being written. */}
              <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="first-domain">Domain</Label>
                  <Input id="first-domain" placeholder="kilnwork.studio" value={domain} onChange={(e) => setDomain(e.target.value)} autoFocus />
                </div>
                <div className="flex items-center">
                  <Button type="button" variant="ghost" onClick={() => setStep(0)}>
                    <ArrowLeftIcon />
                    Back
                  </Button>
                  <div className="flex-1" />
                  <Button type="submit" loading={busy} disabled={!domain.trim()}>
                    {busy ? "Saving…" : "Continue"}
                    <ArrowRightIcon />
                  </Button>
                </div>
              </fieldset>
            </form>
          </Card>
        )}

        {step === 2 && (
          <Card className="gap-4 p-7">
            <div>
              <h1 className="m-0 text-[21px] font-semibold leading-tight tracking-tight">Install the widget</h1>
              <p className="m-0 mt-2 text-muted-foreground">
                Paste this before <code className="font-mono">&lt;/body&gt;</code> on every page you want reviewed, and deploy.
              </p>
            </div>
            <InstallTag uid={site.uid} />
            <div className="flex items-center">
              <Button type="button" variant="ghost" onClick={() => setStep(1)}>
                <ArrowLeftIcon />
                Back
              </Button>
              <div className="flex-1" />
              <Button type="button" onClick={() => setStep(3)}>
                Done
                <ArrowRightIcon />
              </Button>
            </div>
          </Card>
        )}

        {step === 3 && (
          <Card className="items-center gap-4 p-8 text-center">
            <span className="flex size-11 items-center justify-center rounded-[10px] bg-brand-soft text-brand">
              <PartyPopperIcon className="size-5" />
            </span>
            <h1 className="m-0 text-[21px] font-semibold leading-tight tracking-tight">{name || site.name} is set up</h1>
            <p className="m-0 text-muted-foreground">Three things left, in this order.</p>
            <ol className="m-0 flex w-full list-none flex-col gap-2 p-0 text-left">
              {[
                ["Deploy the site with the tag on every page", "Comments start arriving here the moment a page loads it."],
                ["Add a reviewer and send them their link", "Your client gets their own link; you can revoke it without touching the site."],
                ["Start the first round", "A round is one pass of feedback. Starting the next one closes the last."],
              ].map(([title, note], i) => (
                <li key={title} className="flex gap-3 rounded-md border border-border px-3 py-2.5">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong text-[11px] text-muted-foreground">
                    {i + 1}
                  </span>
                  <span>
                    <span className="block text-[13px] font-medium">{title}</span>
                    <span className="block text-[12px] text-muted-foreground">{note}</span>
                  </span>
                </li>
              ))}
            </ol>
            <Button
              size="lg"
              className="mt-2 w-full"
              onClick={() => void navigate({ to: "/s/$site/comments", params: { site: site.uid }, replace: true })}
            >
              Go to Comments
              <ArrowRightIcon />
            </Button>
          </Card>
        )}
      </Gate>
    </div>
  );
}

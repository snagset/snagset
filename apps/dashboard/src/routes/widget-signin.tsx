import { useState, type ReactNode } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { DOM_EVENT_PREFIX } from "@snagset/types/names";
import { Button } from "@/components/ui/button";
import { Gate } from "@/components/app/Gate";
import { Waiting } from "@/components/app/Waiting";
import { api, ApiFailure } from "@/lib/api";
import { rememberAuth } from "@/lib/auth";
import { q } from "@/lib/query";

/**
 * "Sign in with Snagset", the dashboard's half. The widget on a
 * client's site opens this page in a popup:
 *
 *   /widget-signin?project=prj_…&origin=<the page's origin>[&env=…]
 *
 * Outside the app shell, like sign-in and the invite: it is a small window
 * with one question in it. Signed out, it goes through the ordinary sign-in
 * and comes back here (`redirect`, as every deep link does).
 *
 * ONE CLICK, ALWAYS. Any allow-listed page can open this URL, so a page that
 * minted on load would hand a session to whatever opened it the moment a
 * member happened to be signed in. Continue is the member saying yes to the
 * site and the address shown — and it is an owner POST with the CSRF pair,
 * which no other page can make with their cookie.
 *
 * WHERE THE SESSION GOES. `postMessage` to `window.opener`, with the target
 * origin the SERVER returned after checking it is the site's — never `"*"`,
 * and never the query string's value unchecked. A page whose origin is not
 * the one named cannot receive it; the browser drops the message.
 */

/** The message's `type` — composed as the widget composes it (`panels/signin.ts`). */
const SIGNIN_MESSAGE = `${DOM_EVENT_PREFIX}session`;

const search = z.object({
  project: z.string().optional(),
  origin: z.string().optional(),
  env: z.string().optional(),
});

export const Route = createFileRoute("/widget-signin")({
  validateSearch: search,
  beforeLoad: async ({ context, location }) => {
    try {
      const me = await context.queryClient.ensureQueryData(q.me());
      rememberAuth("in");
      return { me };
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) {
        rememberAuth("out");
        throw redirect({ to: "/sign-in", search: { redirect: location.href } });
      }
      throw err;
    }
  },
  pendingComponent: () => <Waiting what="Signing you in" />,
  component: WidgetSignIn,
});

function WidgetSignIn() {
  const { project, origin, env } = Route.useSearch();
  const { me } = Route.useRouteContext();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const site = me.projects.find((p) => p.uid === project);
  const opener = typeof window !== "undefined" ? (window.opener as Window | null) : null;

  const close = () => window.close();

  if (!project || !origin || !opener) {
    return (
      <Shell title="Nothing to sign in to">
        <p className="m-0 text-muted-foreground">
          This window is opened by the comment box on a site you are reviewing. Open it from there — choose{" "}
          <em>Studio member? Sign in</em> — and it will ask you here.
        </p>
      </Shell>
    );
  }
  if (!site) {
    return (
      <Shell title="Not one of this studio's sites">
        <p className="m-0 text-muted-foreground">
          You are signed in to {me.org.name}, and that site is not one of its sites. If it belongs to another studio you
          are in, switch to it in the dashboard and try again.
        </p>
        <Button variant="outline" onClick={close}>
          Close
        </Button>
      </Shell>
    );
  }

  const go = async () => {
    setError("");
    setBusy(true);
    try {
      const s = await api.memberSession(site.uid, origin, env);
      // The server's echo, which IS the checked value — and it must still be
      // the one this page was asked for, or something rewrote it in between.
      if (s.origin !== origin) throw new Error("The address changed while signing in. Try again from the site.");
      const { origin: target, ...session } = s;
      opener.postMessage({ type: SIGNIN_MESSAGE, session }, target);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the server.");
      setBusy(false);
    }
  };

  return (
    <Shell title={`Sign in to ${site.name}`}>
      <p className="m-0 text-muted-foreground">
        Comment on <span className="font-medium text-foreground">{origin}</span> as{" "}
        <span className="font-medium text-foreground">{me.user.name || me.user.email}</span>, from {me.org.name}. Your
        comments there and your replies here will be one author.
      </p>
      {error && (
        <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="lg" className="flex-1" loading={busy} onClick={() => void go()}>
          Continue
        </Button>
        <Button size="lg" variant="outline" onClick={close}>
          Cancel
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Gate>
      <div className="flex flex-col gap-4">
        <h1 className="m-0 text-[22px] font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </Gate>
  );
}

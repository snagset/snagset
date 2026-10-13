import { useState } from "react";
import { createFileRoute, isRedirect, redirect, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Gate } from "@/components/app/Gate";
import { api, ApiFailure } from "@/lib/api";
import { lastAuth, rememberAuth } from "@/lib/auth";
import { q, queryClient } from "@/lib/query";
import { Waiting } from "@/components/app/Waiting";

/**
 * The first-run screen — the claim, the first-visitor-wins.
 *
 * Three things, and only two of them matter. The email and password become
 * the owner account; the studio name is a convenience with a default. The
 * server makes one site alongside; the first run (/welcome) names it and
 * gives it its address, one question per screen.
 */
const search = z.object({ claim: z.string().optional() });

const form = z.object({
  email: z.string().trim().email("An email address"),
  password: z.string().min(12, "At least 12 characters"),
  orgName: z.string().trim().max(120).optional(),
});
type Form = z.infer<typeof form>;

export const Route = createFileRoute("/setup")({
  validateSearch: search,
  beforeLoad: async ({ context }) => {
    // A claimed instance has no claim to make. Asked of the server, because
    // the URL only knows when somebody read a token out of a terminal.
    const claimed = await context.queryClient.fetchQuery(q.claimed()).catch(() => true);
    if (claimed) {
      if (lastAuth() !== "out") {
        try {
          await context.queryClient.ensureQueryData(q.me());
          throw redirect({ to: "/sites" });
        } catch (err) {
          if (isRedirect(err)) throw err;
        }
      }
      throw redirect({ to: "/sign-in" });
    }
  },
  pendingComponent: () => <Waiting what="Loading" />,
  component: Setup,
});

function Setup() {
  const { claim } = Route.useSearch();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const { register, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(form) });

  const submit = handleSubmit(async (v) => {
    setError("");
    try {
      await api.setup({
        token: claim ?? "",
        orgName: v.orgName || "My studio",
        // The server makes one site regardless; the first run names it and
        // gives it its address, one question per screen.
        projectName: "",
        email: v.email,
        password: v.password,
        // The address every link is built from, taken from the one
        // party allowed to say what this instance is called, at the one
        // moment their browser is certainly at it. The server keeps it
        // unless the environment already names one.
        address: location.origin,
      });
      // The response set the session cookies: no second sign-in. The claim
      // was the last unclaimed truth in the cache, so the cache goes.
      rememberAuth("in");
      queryClient.clear();
      void navigate({ to: "/welcome", replace: true });
    } catch (err) {
      // The server's sentence. It distinguishes an already-claimed instance
      // from a short password from a malformed email, and replacing it with
      // "Setup failed" would throw away the only part that says what to do.
      setError(err instanceof ApiFailure ? err.message : "Something went wrong. Try again.");
    }
  });

  return (
    <Gate width={400}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div>
          <h1 className="m-0 text-[22px] font-semibold tracking-tight">Set up Snagset</h1>
          <p className="m-0 mt-1.5 text-muted-foreground">
            This instance has not been claimed yet. The account you make here is the only one, until you add
            another.
          </p>
        </div>
        {error && (
          <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}
        {/* Locked while the claim is in flight. On a database far
            from the server this takes seconds, and an edit made meanwhile is
            silently not the account that gets created. */}
        <fieldset disabled={formState.isSubmitting} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Your email</Label>
            <Input id="email" type="email" autoComplete="username" aria-invalid={!!formState.errors.email} {...register("email")} />
            {formState.errors.email && <p className="m-0 text-[12px] text-destructive">{formState.errors.email.message}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!formState.errors.password} {...register("password")} />
            {/* Said BEFORE the server refuses it. A minimum announced only on
                rejection is a rule you learn by failing. */}
            <p className="m-0 text-[12px] text-muted-foreground">
              At least 12 characters. There is no reset email on a fresh install — keep it.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="orgName">
              Studio name <span className="font-normal text-muted-foreground">optional</span>
            </Label>
            <Input id="orgName" placeholder="My studio" {...register("orgName")} />
          </div>
          <Button type="submit" size="lg" loading={formState.isSubmitting}>
            {formState.isSubmitting ? "Setting up…" : "Create my account"}
          </Button>
        </fieldset>
      </form>
    </Gate>
  );
}

import { useState } from "react";
import { Link, createFileRoute, isRedirect, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Gate } from "@/components/app/Gate";
import { api, ApiFailure } from "@/lib/api";
import { lastAuth, rememberAuth } from "@/lib/auth";
import { q } from "@/lib/query";
import { cn } from "@/lib/utils";
import { Waiting } from "@/components/app/Waiting";

const search = z.object({ redirect: z.string().optional() });

const form = z.object({
  email: z.string().trim().min(1, "Your email"),
  password: z.string().min(1, "Your password"),
});
type Form = z.infer<typeof form>;

export const Route = createFileRoute("/sign-in")({
  validateSearch: search,
  /**
   * The likely truth first. If the last load in this browser ended signed
   * out, the form paints NOW and nothing is asked of the server. Otherwise a
   * signed-in browser landing here is sent on — one `/me`, from the cache
   * when it is warm.
   */
  beforeLoad: async ({ context, search }) => {
    if (lastAuth() === "out") return;
    try {
      await context.queryClient.ensureQueryData(q.me());
    } catch (err) {
      if (isRedirect(err)) throw err;
      return;
    }
    throw redirect({ to: search.redirect ?? "/sites" });
  },
  pendingComponent: () => <Waiting what="Loading" />,
  component: SignIn,
});

function SignIn() {
  const { redirect: back } = Route.useSearch();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [help, setHelp] = useState(false);
  const { register, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(form) });

  /**
   * Signed out is two situations wearing one face: an instance with accounts
   * and an instance with none. Only the server knows which — asked BEHIND
   * the form rather than before it, so a claimed instance (every instance
   * after its first minute) never waits on the answer, and the one unclaimed
   * instance sees the form swap to the claim when the answer arrives.
   */
  const claimed = useQuery({ ...q.claimed(), enabled: true });
  if (claimed.data === false) {
    void navigate({ to: "/setup", replace: true });
  }
  // The other door, drawn only where the instance opens it.
  const state = useQuery(q.setupState());

  const submit = handleSubmit(async ({ email, password }) => {
    setError("");
    try {
      await api.login(email, password);
      rememberAuth("in");
      // A fresh account has no cached truth to keep.
      void navigate({ to: back ?? "/sites", replace: true });
    } catch (err) {
      // The server says one thing for every failure, on purpose.
      // This screen does not improve on it — "no account with that email"
      // would be the enumeration oracle the API refuses.
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server.");
    }
  });

  return (
    <Gate>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div>
          <h1 className="m-0 text-[22px] font-semibold tracking-tight">Sign in</h1>
          {/* One clause, doing one job: turning a reviewer around before they type. */}
          <p className="m-0 mt-1.5 text-muted-foreground">The studio side. Reviewers don't sign in — they open a link.</p>
        </div>
        {error && (
          <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="username" aria-invalid={!!formState.errors.email} {...register("email")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={!!formState.errors.password}
            {...register("password")}
          />
        </div>
        <Button type="submit" size="lg" loading={formState.isSubmitting}>
          {formState.isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
        {/* Behind a disclosure: the person who needs this is the one who has
            just failed to sign in; everybody else needs it out of the way. */}
        <button
          type="button"
          className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-[13px] text-ink-soft"
          aria-expanded={help}
          onClick={() => setHelp(!help)}
        >
          <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform", help && "rotate-90")} />
          Forgot your password?
        </button>
        {state.data?.signup && (
          <p className="m-0 text-center text-[13px] text-muted-foreground">
            New here?{" "}
            <Link to="/sign-up" className="text-foreground underline underline-offset-4">
              Create a studio
            </Link>
          </p>
        )}
        {help && (
          <div className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-muted-foreground">
            <p className="m-0">
              There's no reset email — a fresh install has no mail set up, and whoever has a shell on the server
              already holds more authority than a reset link would grant. From that machine:
            </p>
            <pre className="m-0 overflow-x-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-[12px] text-foreground">
              <code>printf '%s' "$NEW" | snagset passwd you@example.com</code>
            </pre>
            <p className="m-0">Every existing session for that account is signed out when it runs.</p>
          </div>
        )}
      </form>
    </Gate>
  );
}

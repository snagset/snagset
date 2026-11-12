import { useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Gate } from "@/components/app/Gate";
import { Waiting } from "@/components/app/Waiting";
import { api, ApiFailure } from "@/lib/api";
import { q } from "@/lib/query";

/**
 * A forgotten password. Drawn only where the instance can mail; on
 * one that cannot, sign-in's own disclosure still says what there is
 * (`snagset passwd`), and this address goes back there.
 *
 * The answer is ONE sentence for every address, on purpose: "a link is on
 * its way, if there is an account" is all the server will say (it answers
 * 202 either way), and a page that improved on it would be the enumeration
 * oracle the API refuses to be.
 */
const form = z.object({ email: z.string().trim().email("An email address") });
type Form = z.infer<typeof form>;

export const Route = createFileRoute("/forgot")({
  beforeLoad: async ({ context }) => {
    const state = await context.queryClient.fetchQuery(q.setupState()).catch(() => null);
    if (state && !state.claimed) throw redirect({ to: "/setup" });
    if (!state?.mail) throw redirect({ to: "/sign-in" });
  },
  pendingComponent: () => <Waiting what="Loading" />,
  component: Forgot,
});

function Forgot() {
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");
  const { register, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(form) });

  const submit = handleSubmit(async ({ email }) => {
    setError("");
    try {
      await api.requestReset(email);
      setSentTo(email);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server. Try again.");
    }
  });

  if (sentTo) {
    return (
      <Gate>
        <div className="flex flex-col gap-3">
          <h1 className="m-0 text-[22px] font-semibold tracking-tight">Check your mail</h1>
          <p className="m-0 text-muted-foreground">
            If <span className="text-foreground">{sentTo}</span> has an account here, a link is on its way. It works once and expires in an hour.
          </p>
          <p className="m-0 text-[13px] text-muted-foreground">
            Nothing after a minute? Check the spelling and the spam folder, or{" "}
            <button type="button" className="text-foreground underline underline-offset-4" onClick={() => setSentTo("")}>
              try another address
            </button>
            .
          </p>
          <p className="m-0 text-[13px] text-muted-foreground">
            <Link to="/sign-in" className="text-foreground underline underline-offset-4">
              Back to sign in
            </Link>
          </p>
        </div>
      </Gate>
    );
  }

  return (
    <Gate>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div>
          <h1 className="m-0 text-[22px] font-semibold tracking-tight">Forgot your password?</h1>
          <p className="m-0 mt-1.5 text-muted-foreground">Enter your email. A link is sent to it, and the link lets you choose a new password.</p>
        </div>
        {error && (
          <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="username" aria-invalid={!!formState.errors.email} {...register("email")} />
          {formState.errors.email && <p className="m-0 text-[12px] text-destructive">{formState.errors.email.message}</p>}
        </div>
        <Button type="submit" size="lg" loading={formState.isSubmitting}>
          {formState.isSubmitting ? "Sending…" : "Send me the link"}
        </Button>
        <p className="m-0 text-center text-[13px] text-muted-foreground">
          <Link to="/sign-in" className="text-foreground underline underline-offset-4">
            Back to sign in
          </Link>
        </p>
      </form>
    </Gate>
  );
}

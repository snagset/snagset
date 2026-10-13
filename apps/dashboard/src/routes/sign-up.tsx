import { useState } from "react";
import { Link, createFileRoute, isRedirect, redirect, useNavigate } from "@tanstack/react-router";
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
 * A stranger's studio, `POST /auth/register`. Drawn only
 * where the instance opens sign-up (`SNAGSET_SIGNUP_OPEN`): a self-host
 * lands on sign-in, an unclaimed instance on the claim. The shape is the
 * claim's, because it is the same transaction with one more studio on the
 * instance: an account, a studio name, one site made alongside that the
 * first run names.
 */
const form = z.object({
  email: z.string().trim().email("An email address"),
  password: z.string().min(12, "At least 12 characters"),
  name: z.string().trim().max(120).optional(),
  orgName: z.string().trim().max(120).optional(),
});
type Form = z.infer<typeof form>;

export const Route = createFileRoute("/sign-up")({
  beforeLoad: async ({ context }) => {
    const state = await context.queryClient.fetchQuery(q.setupState()).catch(() => ({ claimed: true, signup: false }));
    if (!state.claimed) throw redirect({ to: "/setup" });
    if (!state.signup) throw redirect({ to: "/sign-in" });
    if (lastAuth() !== "out") {
      try {
        await context.queryClient.ensureQueryData(q.me());
        throw redirect({ to: "/sites" });
      } catch (err) {
        if (isRedirect(err)) throw err;
      }
    }
  },
  pendingComponent: () => <Waiting what="Loading" />,
  component: SignUp,
});

function SignUp() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const { register, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(form) });

  const submit = handleSubmit(async (v) => {
    setError("");
    try {
      await api.register({ email: v.email, password: v.password, ...(v.name ? { name: v.name } : {}), orgName: v.orgName || "My studio" });
      // The response set the session cookies: no second sign-in. Nothing
      // cached belongs to this person.
      rememberAuth("in");
      queryClient.clear();
      void navigate({ to: "/welcome", replace: true });
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Something went wrong. Try again.");
    }
  });

  return (
    <Gate width={400}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div>
          <h1 className="m-0 text-[22px] font-semibold tracking-tight">Create a studio</h1>
          <p className="m-0 mt-1.5 text-muted-foreground">Your account, and the studio your sites live in. Reviewers never sign up — they open a link.</p>
        </div>
        {error && (
          <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Your email</Label>
          <Input id="email" type="email" autoComplete="username" aria-invalid={!!formState.errors.email} {...register("email")} />
          {formState.errors.email && <p className="m-0 text-[12px] text-destructive">{formState.errors.email.message}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!formState.errors.password} {...register("password")} />
          <p className="m-0 text-[12px] text-muted-foreground">At least 12 characters. A short phrase of real words is fine.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">
            Your name <span className="font-normal text-muted-foreground">optional</span>
          </Label>
          <Input id="name" autoComplete="name" {...register("name")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="orgName">
            Studio name <span className="font-normal text-muted-foreground">optional</span>
          </Label>
          <Input id="orgName" placeholder="My studio" {...register("orgName")} />
        </div>
        <Button type="submit" size="lg" loading={formState.isSubmitting}>
          {formState.isSubmitting ? "Creating…" : "Create my studio"}
        </Button>
        <p className="m-0 text-center text-[13px] text-muted-foreground">
          Already have an account?{" "}
          <Link to="/sign-in" className="text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </form>
    </Gate>
  );
}

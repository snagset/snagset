import { useEffect, useState } from "react";
import { Link, createFileRoute, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Gate } from "@/components/app/Gate";
import { Waiting } from "@/components/app/Waiting";
import { api, ApiFailure } from "@/lib/api";
import { resetProblem, linkToken, NEXT_LABEL } from "@/lib/resetLink";
import { rememberAuth } from "@/lib/auth";
import { queryClient } from "@/lib/query";

/**
 * The reset link's page. `<address>/reset#<token>`.
 *
 * The invite page's shape, for the invite page's reasons (invite.tsx): the
 * loader reads the token from the fragment and asks the server what it is
 * before anything is drawn, so a link that is spent or an hour old says so
 * as a heading rather than as a form that fails on submit.
 *
 * Setting the password signs the person in, to the studio their account
 * calls home, and signs out every session the old password opened.
 */
type Loaded = ({ ok: true; token: string; email: string } | { ok: false; code: string | null; message: string }) & { hash: string };

const bare = (hash: string): string => hash.replace(/^#/, "").trim();

export const Route = createFileRoute("/reset")({
  loader: async ({ location }): Promise<Loaded> => {
    const hash = bare(location.hash || (typeof window === "undefined" ? "" : window.location.hash));
    const token = linkToken(hash);
    if (!token) {
      return { hash, ok: false, code: null, message: "The link is incomplete. Copy all of it from the mail it came in, or ask for a new one." };
    }
    try {
      return { hash, ok: true, token, email: (await api.lookupReset(token)).email };
    } catch (err) {
      return err instanceof ApiFailure
        ? { hash, ok: false, code: err.code, message: err.message }
        : { hash, ok: false, code: null, message: "Could not reach the server. Reload to try again." };
    }
  },
  // Never cached: the same link is a different answer once it has been used.
  staleTime: 0,
  gcTime: 0,
  pendingComponent: () => <Waiting what="Opening your link" />,
  component: ResetPage,
});

function ResetPage() {
  const loaded = Route.useLoaderData();
  // A second link pasted over the first changes only the fragment, and a
  // fragment alone is not a navigation: the address bar moves and nothing
  // else does. The loader decided from the fragment it saw, so when the one
  // in the bar is a different one, it is asked again.
  const router = useRouter();
  const hash = useLocation({ select: (l) => bare(l.hash) });
  useEffect(() => {
    if (hash !== loaded.hash) void router.invalidate();
  }, [hash, loaded.hash, router]);
  return loaded.ok ? <Choose token={loaded.token} email={loaded.email} /> : <Problem code={loaded.code} message={loaded.message} />;
}

function Problem({ code, message }: { code: string | null; message: string }) {
  const { title, next } = resetProblem(code);
  return (
    <Gate>
      <div className="flex flex-col gap-3">
        <h1 className="m-0 text-[22px] font-semibold tracking-tight">{title}</h1>
        <p role="alert" className="m-0 text-muted-foreground">
          {message}
        </p>
        <p className="m-0 text-[13px] text-muted-foreground">
          <Link to={next === "sign-in" ? "/sign-in" : "/forgot"} className="text-foreground underline underline-offset-4">
            {NEXT_LABEL[next]}
          </Link>
        </p>
      </div>
    </Gate>
  );
}

const form = z.object({ password: z.string().min(12, "At least 12 characters") });
type Form = z.infer<typeof form>;

function Choose({ token, email }: { token: string; email: string }) {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const { register, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(form) });

  const submit = handleSubmit(async ({ password }) => {
    setError("");
    try {
      await api.confirmReset(token, password);
      // The response set the session cookies, as sign-in's does. Whatever
      // this browser had cached belonged to somebody, or to nobody.
      rememberAuth("in");
      queryClient.clear();
      void navigate({ to: "/sites", replace: true });
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server. Try again.");
    }
  });

  return (
    <Gate>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div>
          <h1 className="m-0 text-[22px] font-semibold tracking-tight">Choose a new password</h1>
          <p className="m-0 mt-1.5 text-muted-foreground">Setting it signs you in here, and signs you out everywhere the old one was used.</p>
        </div>
        {error && (
          <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}
        {/* Locked while it is in flight: a second press would find the link spent. */}
        <fieldset disabled={formState.isSubmitting} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            {/* Shown, not asked — and there for the browser's password manager, which files the new password under it. */}
            <Input id="email" type="email" autoComplete="username" readOnly value={email} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">New password</Label>
            <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!formState.errors.password} {...register("password")} />
            {formState.errors.password ? (
              <p className="m-0 text-[12px] text-destructive">{formState.errors.password.message}</p>
            ) : (
              <p className="m-0 text-[12px] text-muted-foreground">At least 12 characters. A short phrase of real words is fine.</p>
            )}
          </div>
          <Button type="submit" size="lg" loading={formState.isSubmitting}>
            {formState.isSubmitting ? "Setting…" : "Set the password and sign in"}
          </Button>
        </fieldset>
      </form>
    </Gate>
  );
}

import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Gate } from "@/components/app/Gate";
import { Waiting } from "@/components/app/Waiting";
import { api, ApiFailure, type InviteLookup } from "@/lib/api";
import { rememberAuth } from "@/lib/auth";
import { asRole, inviteProblem, inviteToken } from "@/lib/invite";
import { queryClient } from "@/lib/query";

/**
 * The invite link's page. `<address>/invite#<token>`.
 *
 * Outside the app shell, like sign-in and the claim: the person opening it
 * has no account yet, so there is nothing to sign in to. The loader reads the
 * token from the fragment and asks the server what it is — which studio,
 * which role, whether the address is fixed — behind the full-screen Waiting
 * ladder those routes use, so a slow database says so rather than showing a
 * blank form for an invite that may already be spent.
 *
 * Expired, used, withdrawn and unknown links each get their own heading and
 * the server's sentence; none of them is a form that fails on submit.
 *
 * Somebody ALREADY signed in here, as the address the invite is for (or as
 * anybody, when the invite names no address), is not asked for a password:
 * being signed in is the proof, and an account made by a provider or a mailed
 * code in front of this server has no password to give. One button, and a way
 * out of it for a person who is in the wrong account.
 */
type Loaded =
  | { ok: true; token: string; invite: InviteLookup; me: string | null }
  | { ok: false; code: string | null; message: string };

export const Route = createFileRoute("/invite")({
  loader: async ({ location }): Promise<Loaded> => {
    // The router keeps the hash on its location; the window is the fallback
    // for a first load where it has not parsed one yet.
    const token = inviteToken(location.hash || (typeof window === "undefined" ? "" : window.location.hash));
    if (!token) {
      return { ok: false, code: null, message: "The link is incomplete. Copy all of it from the message it came in, or ask for a new one." };
    }
    try {
      const [invite, me] = await Promise.all([
        api.lookupInvite(token),
        // Who this browser is signed in as, if anybody. A 401 is the usual answer and not a fault.
        api.me().then((m) => m.user.email, () => null),
      ]);
      return { ok: true, token, invite, me };
    } catch (err) {
      return err instanceof ApiFailure
        ? { ok: false, code: err.code, message: err.message }
        : { ok: false, code: null, message: "Could not reach the server. Reload to try again." };
    }
  },
  // Never cached: the same link is a different answer once it has been used.
  staleTime: 0,
  gcTime: 0,
  pendingComponent: () => <Waiting what="Opening your invite" />,
  component: InvitePage,
});

function InvitePage() {
  const loaded = Route.useLoaderData();
  const [other, setOther] = useState(false);
  if (!loaded.ok) return <Problem code={loaded.code} message={loaded.message} />;
  const mine = !!loaded.me && (!loaded.invite.email || loaded.invite.email.toLowerCase() === loaded.me.toLowerCase());
  return mine && !other ? (
    <AcceptAs token={loaded.token} invite={loaded.invite} me={loaded.me!} onOther={() => setOther(true)} />
  ) : (
    <Accept token={loaded.token} invite={loaded.invite} />
  );
}

/** Signed in already: the session is the proof, so there is nothing to type. */
function AcceptAs({ token, invite, me, onOther }: { token: string; invite: InviteLookup; me: string; onOther: () => void }) {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const studio = invite.org.name || "a studio";
  const join = async () => {
    setError("");
    setBusy(true);
    try {
      await api.acceptInvite({ token, email: me });
      rememberAuth("in");
      queryClient.clear();
      void navigate({ to: "/sites", replace: true });
    } catch (err) {
      // The session ended between the page and the press: the form that can
      // take a password, which says the same thing in its own words.
      if (err instanceof ApiFailure && err.code === "account_exists") return onOther();
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server. Try again.");
      setBusy(false);
    }
  };
  return (
    <Gate width={400}>
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="m-0 text-[22px] font-semibold tracking-tight">Join {studio}</h1>
          <p className="m-0 mt-1.5 text-muted-foreground">
            {invite.invitedBy ? `${invite.invitedBy} invited you` : "You were invited"} to join {studio} as {asRole(invite.role)}. You are signed in as{" "}
            <span className="break-all text-foreground">{me}</span>.
          </p>
        </div>
        {error && (
          <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}
        <Button type="button" size="lg" loading={busy} onClick={join}>
          {busy ? "Joining…" : `Join ${studio}`}
        </Button>
        {!invite.email && (
          <p className="m-0 text-[13px] text-muted-foreground">
            <button type="button" onClick={onOther} className="cursor-pointer border-0 bg-transparent p-0 text-foreground underline underline-offset-4">
              Join with another address
            </button>
          </p>
        )}
      </div>
    </Gate>
  );
}

function Problem({ code, message }: { code: string | null; message: string }) {
  const { title, signIn } = inviteProblem(code);
  return (
    <Gate>
      <div className="flex flex-col gap-3">
        <h1 className="m-0 text-[22px] font-semibold tracking-tight">{title}</h1>
        <p role="alert" className="m-0 text-muted-foreground">
          {message}
        </p>
        {signIn && (
          <p className="m-0 text-[13px] text-muted-foreground">
            <Link to="/sign-in" className="text-foreground underline underline-offset-4">
              Sign in
            </Link>
          </p>
        )}
      </div>
    </Gate>
  );
}

const form = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email("An email address"),
  password: z.string().min(1, "A password"),
});
type Form = z.infer<typeof form>;

function Accept({ token, invite }: { token: string; invite: InviteLookup }) {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  // The server says when the address already has an account here: the same
  // form then takes THAT account's password, and the name is its own.
  const [existing, setExisting] = useState(false);
  const { register, handleSubmit, formState } = useForm<Form>({
    resolver: zodResolver(form),
    defaultValues: { email: invite.email ?? "", name: "" },
  });
  const studio = invite.org.name || "a studio";

  const submit = handleSubmit(async (v) => {
    setError("");
    if (!existing && v.password.length < 12) {
      setError("The password must be at least 12 characters. A short phrase of real words is fine.");
      return;
    }
    try {
      await api.acceptInvite({ token, password: v.password, ...(v.name ? { name: v.name } : {}), ...(invite.email ? {} : { email: v.email }) });
      // The response set the session cookies, as sign-in's does. Whatever
      // this browser had cached belonged to somebody, or to nobody.
      rememberAuth("in");
      queryClient.clear();
      void navigate({ to: "/sites", replace: true });
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "account_exists") setExisting(true);
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server. Try again.");
    }
  });

  return (
    <Gate width={400}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div>
          <h1 className="m-0 text-[22px] font-semibold tracking-tight">Join {studio}</h1>
          <p className="m-0 mt-1.5 text-muted-foreground">
            {invite.invitedBy ? `${invite.invitedBy} invited you` : "You were invited"} to join {studio} as {asRole(invite.role)}.
            {existing ? " Sign in with the account you already have here." : " Choose your password and you're in."}
          </p>
        </div>
        {error && (
          <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}
        {/* Locked while the accept is in flight: it makes an account,
            and an edit made meanwhile is not the account that gets made. */}
        <fieldset disabled={formState.isSubmitting} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            {/* Fixed by the invite: shown, not asked — the server refuses any other. */}
            <Input
              id="email"
              type="email"
              autoComplete="username"
              readOnly={!!invite.email}
              aria-invalid={!!formState.errors.email}
              {...register("email")}
            />
            {formState.errors.email && <p className="m-0 text-[12px] text-destructive">{formState.errors.email.message}</p>}
          </div>
          {!existing && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">
                Your name <span className="font-normal text-muted-foreground">optional</span>
              </Label>
              <Input id="name" autoComplete="name" {...register("name")} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">{existing ? "Your password" : "Choose a password"}</Label>
            <Input
              id="password"
              type="password"
              autoComplete={existing ? "current-password" : "new-password"}
              aria-invalid={!!formState.errors.password}
              {...register("password")}
            />
            {!existing && <p className="m-0 text-[12px] text-muted-foreground">At least 12 characters. A short phrase of real words is fine.</p>}
          </div>
          <Button type="submit" size="lg" loading={formState.isSubmitting}>
            {formState.isSubmitting ? "Joining…" : `Join ${studio}`}
          </Button>
        </fieldset>
      </form>
    </Gate>
  );
}

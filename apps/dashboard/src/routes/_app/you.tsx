import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, SettingsRow } from "@/components/app/parts";
import { SaveState } from "@/components/app/SaveState";
import { ThemeChoice } from "@/components/app/ThemeChoice";
import { useMe } from "@/lib/me";
import { reason } from "@/lib/mutations";
import { useChangePassword, useRenameMe } from "@/lib/studio";

/**
 * You — your name, your sign-in, the password an owner gave you, your theme.
 * It exists because of a flow that had no last step: an owner adds an admin
 * with an initial password and says it out loud; the admin signs in; and
 * this is the first thing they look for.
 */
export const Route = createFileRoute("/_app/you")({
  loader: () => ({ crumb: "You" }),
  component: You,
});

function You() {
  const me = useMe();
  const rename = useRenameMe();
  const [name, setName] = useState(me.user.name);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => setName(me.user.name), [me.user.name]);
  const dirty = name.trim() !== me.user.name;

  return (
    <div className="flex flex-col gap-10 p-7">
      <PageHeader title="You" sub="Your own account on this studio" actions={<SaveState saving={rename.isPending} savedAt={savedAt} />} />
      <SettingsRow title="Profile" description="How you appear on replies and in the members list.">
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) rename.mutate(name.trim(), { onSuccess: () => setSavedAt(Date.now()) });
          }}
        >
          <Label htmlFor="your-name">Name</Label>
          <div className="flex gap-2">
            <Input id="your-name" value={name} onChange={(e) => setName(e.target.value)} />
            {dirty && (
              <Button type="submit" variant="outline">
                Save
              </Button>
            )}
          </div>
        </form>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="your-email">Email</Label>
          <Input id="your-email" value={me.user.email} readOnly className="bg-muted text-ink-soft" />
          <p className="m-0 text-[12px] text-muted-foreground">
            How you sign in, and how the server finds you. An owner changes it with{" "}
            <code className="font-mono">snagset passwd</code>.
          </p>
        </div>
      </SettingsRow>
      <SettingsRow title="Password" description="Changing it keeps this session and ends every other one.">
        <PasswordForm />
      </SettingsRow>
      <SettingsRow title="Appearance" description="Also in your menu at the bottom of the sidebar.">
        <ThemeChoice
          items={[
            { value: "system", label: "System", icon: <MonitorIcon className="size-3.5" /> },
            { value: "light", label: "Light", icon: <SunIcon className="size-3.5" /> },
            { value: "dark", label: "Dark", icon: <MoonIcon className="size-3.5" /> },
          ]}
        />
      </SettingsRow>
    </div>
  );
}

function PasswordForm() {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const ready = current.length > 0 && next.length >= 12 && next === again;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || change.isPending) return;
        setError("");
        try {
          await change.mutateAsync({ current, next });
          setCurrent("");
          setNext("");
          setAgain("");
          setChanged(true);
        } catch (err) {
          setError(reason(err));
        }
      }}
    >
      {error && (
        <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pw-current">Current password</Label>
        <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setChanged(false); }} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pw-next">New password</Label>
        <Input id="pw-next" type="password" autoComplete="new-password" value={next} onChange={(e) => { setNext(e.target.value); setChanged(false); }} />
        <p className="m-0 text-[12px] text-muted-foreground">At least 12 characters. No composition rules — length is what matters.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pw-again">Confirm new password</Label>
        <Input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => { setAgain(e.target.value); setChanged(false); }} />
        {again.length > 0 && next !== again && <p className="m-0 text-[12px] text-muted-foreground">Those do not match yet.</p>}
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={change.isPending} disabled={!ready}>
          {change.isPending ? "Changing…" : changed && !ready ? "Changed" : "Change password"}
        </Button>
      </div>
    </form>
  );
}

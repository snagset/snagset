import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { CopyButton } from "@/components/app/CopyButton";
import { InstallTag } from "@/components/app/InstallTag";
import { RoundsSettings } from "@/components/app/RoundsSettings";
import { Switch } from "@/components/ui/switch";
import { PageHeader, SettingsRow } from "@/components/app/parts";
import { SaveState } from "@/components/app/SaveState";
import { useDeleteSite, useEditSite } from "@/lib/mutations";
import { useMe } from "@/lib/me";
import { q } from "@/lib/query";
import { cn } from "@/lib/utils";

/**
 * Site settings — the site, the widget, its rounds, the danger. Every
 * control saves on its own, optimistically, so the one indicator sits by the
 * title where you are looking. The domain rule and the widget switch arrive
 * until then the addresses are the allow-list the
 * server keeps today.
 */
export const Route = createFileRoute("/_app/s/$site/settings")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(q.origins(context.site.uid));
    void context.queryClient.prefetchQuery(q.rounds(context.site.uid));
    return { crumb: "Settings" };
  },
  component: SiteSettings,
});

/** The two modes a studio actually chooses between (`verified-only` has no UI). */
const AUDIENCES = [
  {
    id: "open",
    title: "Everyone on the site",
    note: "The toolbar appears for every visitor on the addresses above. Simplest for a staging URL nobody else knows.",
  },
  {
    id: "link-required",
    title: "Only reviewers with a link",
    note: "You add a reviewer and send them their link. Use this when staging is publicly reachable, or when one reviewer needs revoking without shutting the whole site.",
  },
] as const;

function SiteSettings() {
  const { site: uid } = Route.useParams();
  const me = useMe();
  const site = me.projects.find((p) => p.uid === uid)!;
  const origins = useQuery(q.origins(uid));
  const edit = useEditSite(uid);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const save = (patch: Parameters<typeof edit.mutate>[0]) =>
    edit.mutate(patch, { onSuccess: () => setSavedAt(Date.now()) });

  return (
    <div className="flex flex-col gap-10 p-7">
      <PageHeader title="Settings" sub={site.name} actions={<SaveState saving={edit.isPending} savedAt={savedAt} />} />

      <SettingsRow title="Site" description="Its name, its ID for the tag, and where the widget may run.">
        <div className="flex flex-col gap-1.5">
          <Label>Site ID</Label>
          <div className="flex items-center gap-2">
            <code className="rounded-md bg-muted px-2.5 py-1.5 font-mono text-[12.5px] text-ink-soft">{site.uid}</code>
            <CopyButton text={site.uid} label="Copy the site ID" />
          </div>
        </div>
        <NameField name={site.name} onSave={(name) => save({ name })} />
        <DomainField domain={origins.data?.domain ?? null} loaded={origins.isSuccess} onSave={(domain) => save({ domain })} />
        <Addresses
          list={origins.data?.origins ?? []}
          loaded={origins.isSuccess}
          hasDomain={!!origins.data?.domain}
          onChange={(next) => save({ origins: next })}
        />
      </SettingsRow>

      <SettingsRow title="Widget" description="Whether it runs, who the toolbar appears for, and the tag itself.">
        <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5">
          <div>
            <Label htmlFor="widget-on" className="text-[13px] font-medium">
              Widget on this site
            </Label>
            <p className="m-0 mt-0.5 text-[12px] leading-normal text-muted-foreground">
              Off hides the toolbar for everyone and refuses new comments. The tag can stay in the site's code.
            </p>
          </div>
          <Switch
            id="widget-on"
            aria-label="Widget on this site"
            checked={site.status !== "paused"}
            onCheckedChange={(on) => save({ status: on ? "active" : "paused" })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Who can comment</Label>
          <RadioGroup value={site.writeMode} onValueChange={(v) => save({ writeMode: String(v) })} className="gap-2">
            {AUDIENCES.map((a) => (
              <label
                key={a.id}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5",
                  site.writeMode === a.id && "border-brand bg-brand-soft",
                )}
              >
                <RadioGroupItem value={a.id} className="mt-0.5" aria-label={a.title} />
                <span>
                  <span className="block text-[13px] font-medium">{a.title}</span>
                  <span className="block text-[12px] leading-normal text-muted-foreground">{a.note}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>The tag</Label>
          <InstallTag uid={site.uid} />
          <p className="m-0 text-[12px] text-muted-foreground">
            Paste it before <code className="font-mono">&lt;/body&gt;</code> on every page you want reviewed.
          </p>
        </div>
      </SettingsRow>

      <RoundsSettings uid={uid} />

      <DangerRow uid={uid} name={site.name} />
    </div>
  );
}

/** A FORM, not a blur handler: Enter saves, and the button appears only once the value differs. */
function NameField({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const [value, setValue] = useState(name);
  // Keyed on the SERVER's name alone: a refetch after some other field saved
  // carries the same name and does not touch a box somebody is typing in;
  // a rollback carries the old name and does.
  useEffect(() => setValue(name), [name]);
  const dirty = value.trim().length > 0 && value.trim() !== name;
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) onSave(value.trim());
      }}
    >
      <Label htmlFor="site-name">Name</Label>
      <div className="flex gap-2">
        <Input id="site-name" value={value} onChange={(e) => setValue(e.target.value)} />
        {dirty && (
          <Button type="submit" variant="outline">
            Save
          </Button>
        )}
      </div>
    </form>
  );
}

/** The one field most sites need. Enter saves; emptying it clears; a refusal comes back as a toast and a rollback. */
function DomainField({
  domain,
  loaded,
  onSave,
}: {
  domain: string | null;
  loaded: boolean;
  onSave: (domain: string | null) => void;
}) {
  const [value, setValue] = useState(domain ?? "");
  useEffect(() => setValue(domain ?? ""), [domain]);
  const dirty = value.trim() !== (domain ?? "");
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) onSave(value.trim() || null);
      }}
    >
      <Label htmlFor="site-domain">Domain</Label>
      <div className="flex gap-2">
        <Input id="site-domain" placeholder="kilnwork.studio" value={value} onChange={(e) => setValue(e.target.value)} disabled={!loaded} />
        {dirty && (
          <Button type="submit" variant="outline">
            {value.trim() ? "Save domain" : "Clear domain"}
          </Button>
        )}
      </div>
      <p className="m-0 text-[12px] text-muted-foreground">
        Every subdomain, scheme and port of it may run the widget — staging, previews, and localhost while you build.
      </p>
    </form>
  );
}

function Addresses({
  list,
  loaded,
  hasDomain,
  onChange,
}: {
  list: string[];
  loaded: boolean;
  /** With a domain set, the last address is not the last way in, so it is not locked. */
  hasDomain: boolean;
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState("");
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="site-origin-add">Also allowed</Label>
      <p className="m-0 text-[12px] text-muted-foreground">
        Exact addresses the domain does not cover — a client's other host, a preview on somebody else's suffix.
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {list.map((o) => (
          <li key={o} className="flex items-center gap-2">
            <code className="rounded-md border border-border px-2 py-1 font-mono text-[12px]">{o}</code>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${o}`}
              // The last one is locked: a site with no address accepts
              // nothing from anywhere, which is how you switch your own
              // widget off by accident.
              disabled={list.length <= 1 && !hasDomain}
              onClick={() => onChange(list.filter((x) => x !== o))}
            >
              <XIcon />
            </Button>
          </li>
        ))}
        {loaded && list.length === 0 && (
          <li className="text-[12.5px] text-muted-foreground">{hasDomain ? "None besides the domain." : "No address yet."}</li>
        )}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = adding.trim();
          if (!v) return;
          onChange([...list, v]);
          setAdding("");
        }}
      >
        <Input id="site-origin-add" placeholder="https://staging.example.com" value={adding} onChange={(e) => setAdding(e.target.value)} />
        <Button type="submit" variant="outline" disabled={!adding.trim()}>
          <PlusIcon />
          Add
        </Button>
      </form>
    </div>
  );
}

function DangerRow({ uid, name }: { uid: string; name: string }) {
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();
  const del = useDeleteSite(uid);
  return (
    <SettingsRow
      danger
      title="Delete this site"
      description={
        <>
          The site stops appearing and its widget stops being served.{" "}
          <b className="font-semibold text-foreground">Nothing your client wrote is destroyed</b> — the comments stay
          in the database, so a mistake here is recoverable.
        </>
      }
    >
      <div className="flex items-center gap-4">
        <p className="m-0 flex-1 text-[13px] text-ink-soft">You will be asked to type the site's name.</p>
        <Button type="button" variant="outline" className="border-destructive text-destructive" onClick={() => setConfirming(true)}>
          Delete {name}…
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${name}?`}
        description="The site stops appearing and its widget stops being served. Nothing your client wrote is destroyed — the comments stay in the database."
        confirmLabel="Delete"
        confirmWord={name}
        busy={del.isPending}
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              setConfirming(false);
              void navigate({ to: "/sites" });
            },
          })
        }
      />
    </SettingsRow>
  );
}

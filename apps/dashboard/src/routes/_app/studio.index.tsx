import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InstanceRows } from "@/components/app/InstanceRows";
import { PageHeader, SettingsRow } from "@/components/app/parts";
import { SaveState } from "@/components/app/SaveState";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { reason } from "@/lib/mutations";
import { q } from "@/lib/query";
import { useRenameOrg } from "@/lib/studio";
import { checkForUpdate, type UpdateResult } from "@/lib/update";
import { Spinner } from "@/components/app/Pending";

/** Studio › General — the name, and what is running. Owners rename; admins see it. */
export const Route = createFileRoute("/_app/studio/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(q.meta());
    void context.queryClient.prefetchQuery(q.members());
    void context.queryClient.prefetchQuery(q.instance());
    return { crumb: "General" };
  },
  component: General,
});

function General() {
  const me = useMe();
  const meta = useQuery(q.meta());
  const members = useQuery(q.members());
  const rename = useRenameOrg();
  const owner = me.user.role === "owner";
  const [name, setName] = useState(me.org.name);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => setName(me.org.name), [me.org.name]);
  const dirty = owner && name.trim().length > 0 && name.trim() !== me.org.name;

  return (
    <div className="flex flex-col gap-10 p-7">
      <PageHeader title="General" sub={me.org.name} actions={<SaveState saving={rename.isPending} savedAt={savedAt} />} />
      <SettingsRow title="Studio" description="The name at the top of every screen.">
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) rename.mutate(name.trim(), { onSuccess: () => setSavedAt(Date.now()) });
          }}
        >
          <Label htmlFor="studio-name">Name</Label>
          <div className="flex gap-2">
            <Input id="studio-name" value={name} readOnly={!owner} onChange={(e) => setName(e.target.value)} />
            {dirty && (
              <Button type="submit" variant="outline">
                Save
              </Button>
            )}
          </div>
          <p className="m-0 text-[12px] text-muted-foreground">
            {owner ? "Shown at the top of the sidebar, above every site." : "Only an owner can change it."}
          </p>
        </form>
      </SettingsRow>
      <SettingsRow title="This instance" description="What is running, and where.">
        <dl className="m-0 grid grid-cols-[130px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="m-0">
            {meta.data?.version ?? "—"} <UpdateLine version={meta.data?.version ?? ""} />
          </dd>
          <dt className="text-muted-foreground">Address</dt>
          <dd className="m-0">
            <AddressField owner={owner} />
          </dd>
          {meta.data?.commit && (
            <>
              <dt className="text-muted-foreground">Commit</dt>
              <dd className="m-0 font-mono text-[12px] text-ink-soft">
                {meta.data.commit.slice(0, 12)}
                {meta.data.modified ? " · modified" : ""}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Sites · members</dt>
          <dd className="m-0">
            {me.projects.length} · {members.data?.data.length ?? "—"}
          </dd>
        </dl>
      </SettingsRow>
      <InstanceRows owner={owner} />
    </div>
  );
}

/** Asked of npm by the operator's browser, on the operator's click. Never by the server. */
function UpdateLine({ version }: { version: string }) {
  const [state, setState] = useState<{ s: "idle" | "checking" | "done" | "failed"; r?: UpdateResult }>({ s: "idle" });
  if (state.s === "idle") {
    return (
      <>
        ·{" "}
        <button
          type="button"
          className="text-brand hover:underline"
          onClick={() => {
            setState({ s: "checking" });
            checkForUpdate(version).then((r) => setState({ s: "done", r })).catch(() => setState({ s: "failed" }));
          }}
        >
          Check for updates
        </button>{" "}
        <span className="text-[12px] text-muted-foreground">— from your browser, never from the server</span>
      </>
    );
  }
  if (state.s === "checking") return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        · <Spinner className="size-3" /> checking…
      </span>
    );
  if (state.s === "failed") return <span className="text-muted-foreground">· could not reach npm</span>;
  return (
    <span className="text-muted-foreground">
      {state.r?.newer ? `· ${state.r.latest} is out` : "· up to date"}
    </span>
  );
}

/**
 * The address every link is built from. Set at claim from the
 * owner's own browser, kept as an instance setting, editable here by an
 * owner; the environment (or the platform's own variable) wins and
 * locks it, and the row says so rather than offering a field that would be
 * refused.
 */
function AddressField({ owner }: { owner: boolean }) {
  const qc = useQueryClient();
  const instance = useQuery(q.instance());
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: (url: string) => api.setAddress(url),
    onSuccess: (next) => {
      qc.setQueryData(q.instance().queryKey, next);
      setDraft(null);
      setError("");
      toast.success("Address saved — every new link is built from it");
    },
    onError: (e) => setError(reason(e)),
  });
  const a = instance.data?.address;
  if (!a) return <span className="font-mono text-[12px] text-ink-soft">{location.origin}</span>;
  const managed = a.source === "env";
  if (draft === null || !owner || managed) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] text-ink-soft">{a.url}</span>
        <span className="text-[12px] text-muted-foreground">
          {managed ? "· set by the environment (SNAGSET_BASE_URL)" : a.source === "stored" ? "· set at claim; every link is built from it" : "· this machine's default"}
        </span>
        {owner && !managed && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(a.url)}>
            Change…
          </Button>
        )}
      </span>
    );
  }
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(draft.trim());
      }}
    >
      <span className="flex items-center gap-2">
        <Input aria-label="Address" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 max-w-[360px] font-mono text-[12px]" autoFocus />
        <Button type="submit" size="sm" loading={save.isPending} disabled={!draft.trim()}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </span>
      {error && <span className="text-[12px] text-destructive">{error}</span>}
      <span className="text-[12px] text-muted-foreground">https:// unless it is this machine; the origin only. Review links, issues and emails are built from it.</span>
    </form>
  );
}

import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ImageOffIcon, LayoutGridIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader } from "@/components/app/parts";
import { api, ApiFailure } from "@/lib/api";
import { ago } from "@/lib/labels";
import { useMe } from "@/lib/me";

/**
 * Sites — the home. A card per site with its newest screenshot as its face,
 * and "Add a site" as a dialog, which navigates into the new site so
 * the tag is the next thing on screen.
 */
export const Route = createFileRoute("/_app/sites")({
  validateSearch: z.object({ add: z.boolean().optional() }),
  loader: () => ({ crumb: "Sites" }),
  component: Sites,
});

function Sites() {
  const me = useMe();
  const { add } = Route.useSearch();
  const [adding, setAdding] = useState(!!add);
  useEffect(() => {
    if (add) setAdding(true);
  }, [add]);
  const open = me.projects.reduce((n, p) => n + p.unresolved, 0);
  // The count against the number, where one exists.
  const cap = me.limits.projects.limit;
  const full = cap !== null && me.projects.length >= cap;

  return (
    <div className="p-7">
      <PageHeader
        title="Sites"
        sub={
          me.projects.length
            ? `${me.projects.length}${cap !== null ? ` of ${cap}` : ""} site${me.projects.length === 1 && cap === null ? "" : "s"} · ${open} open`
            : cap !== null
              ? `0 of ${cap} sites`
              : undefined
        }
        actions={
          <Button onClick={() => setAdding(true)} disabled={full} title={full ? `This studio's plan allows ${cap} sites.` : undefined}>
            <PlusIcon />
            Add a site
          </Button>
        }
      />
      {me.projects.length === 0 ? (
        <Card className="max-w-[1100px]">
          <EmptyState
            icon={<LayoutGridIcon className="size-5" />}
            title="No sites yet"
            action={
              <Button onClick={() => setAdding(true)}>
                <PlusIcon />
                Add a site
              </Button>
            }
          >
            A site is one client website. Add it, paste the tag, and comments start arriving here.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid max-w-[1100px] grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {me.projects.map((p) => (
            <Link
              key={p.uid}
              to="/s/$site/comments"
              params={{ site: p.uid }}
              className="block overflow-hidden rounded-lg border border-border bg-card text-foreground transition-shadow hover:shadow-[0_1px_2px_rgb(24_23_22/.06),0_8px_24px_rgb(24_23_22/.08)]"
            >
              <div className="flex h-[150px] items-center justify-center border-b border-border bg-background">
                {p.previewUrl ? (
                  <img src={p.previewUrl} alt="" className="size-full object-cover object-top" />
                ) : (
                  <div className="flex flex-col items-center gap-1 text-[12px] text-muted-foreground">
                    <span className="flex size-8 items-center justify-center rounded-md bg-muted">
                      <ImageOffIcon className="size-4" />
                    </span>
                    No screenshot yet
                  </div>
                )}
              </div>
              <div className="px-3.5 pb-3.5 pt-3">
                <div className="flex items-center gap-2 text-[14px] font-semibold">
                  <span className="truncate">{p.name}</span>
                  {p.status === "paused" && (
                    <span className="rounded-sm bg-muted px-1.5 py-px text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                      Paused
                    </span>
                  )}
                </div>
                {p.domain && <div className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">{p.domain}</div>}
                <div className="mt-2 text-[12.5px] text-ink-soft">
                  {p.threads === 0
                    ? "Nothing filed yet"
                    : `${p.unresolved} open of ${p.threads}${p.lastActivityAt ? ` · ${ago(p.lastActivityAt)}` : ""}`}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
      <AddSite open={adding} onOpenChange={setAdding} />
    </div>
  );
}

const form = z.object({
  name: z.string().trim().min(1, "A name"),
  // The question, which the first run and Site settings have asked since
  // that decision and this dialog did not: a DOMAIN, not one exact address.
  // The one place a site is born was the last place still asking for an
  // origin, so a site added here started life without the rule every other
  // route assumes and with a single address that has to be widened by hand.
  domain: z.string().trim().min(1, "Its domain"),
});
type Form = z.infer<typeof form>;

function AddSite({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const { register, handleSubmit, formState, reset } = useForm<Form>({ resolver: zodResolver(form) });

  const submit = handleSubmit(async (v) => {
    setError("");
    try {
      const made = await api.createProject(v.name, "", v.domain);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      reset();
      onOpenChange(false);
      void navigate({ to: "/s/$site/comments", params: { site: made.uid } });
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not add the site.");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Add a site</DialogTitle>
            <DialogDescription>One client website. The tag it needs is shown right after.</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-name">Name</Label>
            <Input id="site-name" placeholder="Kilnwork" aria-invalid={!!formState.errors.name} {...register("name")} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-domain">Domain</Label>
            <Input id="site-domain" placeholder="kilnwork.studio" aria-invalid={!!formState.errors.domain} {...register("domain")} />
            <p className="m-0 text-[12px] text-muted-foreground">
              Every subdomain, scheme and port of it may run the widget — staging, previews, and localhost while you build.
              Exact addresses elsewhere can be added in Settings.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={formState.isSubmitting}>
              {formState.isSubmitting ? "Adding…" : "Add site"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

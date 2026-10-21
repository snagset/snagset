import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CheckIcon, PlusIcon, UsersIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { CopyButton } from "@/components/app/CopyButton";
import { EmptyState, PageHeader } from "@/components/app/parts";
import { type MintedLink, type ReviewLink } from "@/lib/api";
import { ago } from "@/lib/labels";
import { reason, useMintLink, useRevokeLink } from "@/lib/mutations";
import { useMe } from "@/lib/me";
import { can } from "@/lib/roles";
import { q } from "@/lib/query";
import { cn } from "@/lib/utils";

/**
 * Reviewers — the person, not the link. Under the link IS the
 * access-control system; this screen is where the studio ends a client's
 * access, which is why revoke asks once and names the 10 s bound
 * rather than promising instant.
 *
 * THE TOKEN EXISTS ONCE (`reviewLinks.ts`): the mint response is the only
 * place it is ever visible. The banner below is state that lives ONLY in this
 * component, never persisted, never refetched — the list route this screen
 * otherwise reads does not carry a token at all, by design.
 */
export const Route = createFileRoute("/_app/s/$site/reviewers")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(q.links(context.site.uid));
    void context.queryClient.prefetchQuery(q.origins(context.site.uid));
    return { crumb: "Reviewers" };
  },
  component: Reviewers,
});

function Reviewers() {
  const { site: uid } = Route.useParams();
  const { site } = Route.useRouteContext();
  const links = useQuery(q.links(uid));
  const origins = useQuery(q.origins(uid));
  const [adding, setAdding] = useState(false);
  const [minted, setMinted] = useState<MintedLink | null>(null);
  // The once-only box belongs to the mint that just happened on THIS site.
  useEffect(() => setMinted(null), [uid]);

  const rows = links.data?.data ?? [];
  const base = origins.data?.origins[0]?.replace(/\/+$/, "") ?? "";
  const shareUrl = minted ? `${base}/${minted.fragment}` : "";
  const addButton = (
    <Button onClick={() => setAdding(true)}>
      <PlusIcon />
      Add reviewer
    </Button>
  );

  return (
    <div className="p-7">
      <PageHeader title="Reviewers" sub={`Each reviewer gets their own link to ${site.name}`} actions={addButton} />

      {minted && (
        <div
          className="mb-4 flex max-w-[1040px] items-center gap-3 rounded-lg border border-ok bg-ok-soft px-3.5 py-3"
          role="status"
        >
          <CheckIcon className="size-4 shrink-0 text-ok" />
          <div className="shrink-0">
            <b className="font-semibold">{minted.name} added.</b>{" "}
            <span className="text-ink-soft">Share this link — it is shown once.</span>
          </div>
          <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[12.5px]">
            {shareUrl}
          </code>
          <CopyButton text={shareUrl} label="Copy link" withText />
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => setMinted(null)}>
            <XIcon />
          </Button>
        </div>
      )}

      {links.isSuccess && rows.length === 0 ? (
        <Card className="max-w-[1040px]">
          <EmptyState icon={<UsersIcon className="size-5" />} title="No reviewers yet" action={addButton}>
            Add your client and send them their link. They never need an account.
          </EmptyState>
        </Card>
      ) : (
        <Card className="max-w-[1040px] overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((l) => (
                <ReviewerRow key={l.id} link={l} uid={uid} onRevoked={() => setMinted((m) => (m?.id === l.id ? null : m))} />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <p className="m-0 mt-3 max-w-[1040px] text-[12.5px] text-muted-foreground">
        Revoking ends every session minted from the link within 10 seconds. The comments a reviewer left stay.
      </p>

      <AddReviewer uid={uid} open={adding} onOpenChange={setAdding} onMinted={setMinted} />
    </div>
  );
}

function ReviewerRow({ link, uid, onRevoked }: { link: ReviewLink; uid: string; onRevoked: () => void }) {
  const revoke = useRevokeLink(uid);
  // Revoking signs every widget reviewer on the site out, so it is an admin's.
  const mayRevoke = can(useMe().user.role, "settings");
  const [confirming, setConfirming] = useState(false);
  const revoked = !!link.revokedAt;
  const expired = !revoked && new Date(link.expiresAt).getTime() <= Date.now();
  const dead = revoked || expired;
  const days = Math.max(0, Math.ceil((new Date(link.expiresAt).getTime() - Date.now()) / 86_400_000));
  return (
    <TableRow className={cn(dead && "text-muted-foreground")}>
      <TableCell className="font-medium">{link.name}</TableCell>
      <TableCell>
        {revoked ? (
          <span>Revoked {ago(link.revokedAt)}</span>
        ) : expired ? (
          <span>Expired</span>
        ) : (
          <span>
            <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11.5px] font-medium text-ok">Active</span>
            <span className="ml-2 text-[12px] text-muted-foreground">
              expires in {days} day{days === 1 ? "" : "s"}
            </span>
          </span>
        )}
      </TableCell>
      <TableCell>{link.useCount}</TableCell>
      <TableCell className="text-muted-foreground">{link.lastUsedAt ? ago(link.lastUsedAt) : "never"}</TableCell>
      <TableCell className="text-right">
        {!revoked && mayRevoke && (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Revoke ${link.name}'s link?`}
          description={`Every session minted from it ends within 10 seconds. The comments ${link.name} left stay. This cannot be undone — adding them again makes a new link.`}
          confirmLabel="Revoke"
          busy={revoke.isPending}
          onConfirm={() => {
            setConfirming(false);
            onRevoked();
            revoke.mutate(link.id);
          }}
        />
      </TableCell>
    </TableRow>
  );
}

const form = z.object({
  name: z.string().trim().min(1, "Their name"),
  days: z.string(),
  roundId: z.string().optional(),
});
type Form = z.infer<typeof form>;

function AddReviewer({
  uid,
  open,
  onOpenChange,
  onMinted,
}: {
  uid: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onMinted: (m: MintedLink) => void;
}) {
  const mint = useMintLink(uid);
  const rounds = useQuery({ ...q.rounds(uid), enabled: open });
  const [error, setError] = useState("");
  const { register, handleSubmit, formState, reset } = useForm<Form>({
    resolver: zodResolver(form),
    defaultValues: { days: "14", roundId: "" },
  });
  const submit = handleSubmit(async (v) => {
    setError("");
    const n = Number(v.days);
    try {
      const made = await mint.mutateAsync({
        name: v.name,
        ...(Number.isFinite(n) && n > 0 ? { expiresAt: new Date(Date.now() + n * 86_400_000).toISOString() } : {}),
        ...(v.roundId ? { roundId: v.roundId } : {}),
      });
      onMinted(made);
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(reason(err));
    }
  });
  const selectClass =
    "h-8 w-full rounded-md border border-input bg-card px-2.5 text-[13.5px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>New reviewer</DialogTitle>
            <DialogDescription>
              Your client's name, as you will see it on their comments. A link is generated once and shown to you once.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reviewer-name">Name</Label>
            <Input id="reviewer-name" placeholder="Marta, Kilnwork" aria-invalid={!!formState.errors.name} {...register("name")} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reviewer-days">Link expires in</Label>
            <select id="reviewer-days" className={selectClass} {...register("days")}>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
            <p className="m-0 text-[12px] text-muted-foreground">You can revoke it at any time before that.</p>
          </div>
          {rounds.data && rounds.data.data.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reviewer-round">Pin to a round</Label>
              <select id="reviewer-round" className={selectClass} {...register("roundId")}>
                <option value="">Any round</option>
                {rounds.data.data.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={formState.isSubmitting}>
              {formState.isSubmitting ? "Adding…" : "Add reviewer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { MailIcon, PlusIcon, XIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { CopyButton } from "@/components/app/CopyButton";
import { NativeSelect } from "@/components/app/NativeSelect";
import { AdminsOnly, PageHeader, SectionTitle } from "@/components/app/parts";
import type { Invite, Member, MintedInvite } from "@/lib/api";
import { asRole } from "@/lib/invite";
import { ASSIGNABLE_ROLES } from "@snagset/types/roles";
import { can, invitable, ROLE_SUMMARY, type AssignableRole } from "@/lib/roles";
import { initials } from "@/lib/labels";
import { useMe } from "@/lib/me";
import { reason } from "@/lib/mutations";
import { q } from "@/lib/query";
import { useCreateInvite, useRemoveMember, useRevokeInvite, useSendInvite, useSetMemberRole } from "@/lib/studio";

/**
 * Members — who is in the studio. Owners change the list; admins
 * it and invite members; a member is not shown this page at all. The
 * controls somebody cannot use are not drawn disabled, they are not drawn —
 * a greyed-out "Invite" is a question with no answer on the screen.
 *
 * People join through an invite link: the owner picks a role and,
 * optionally, the address; the link is shown once, to copy or to mail; the
 * person who opens it chooses their own password. Pending invites are listed
 * under the members, so a link sent and never opened is visible and can be
 * withdrawn.
 */
export const Route = createFileRoute("/_app/studio/members")({
  loader: ({ context }) => {
    // Not asked for a member: the page is not theirs, and the invites answer 403.
    if (can(context.queryClient.getQueryData(q.me().queryKey)?.user.role, "settings")) {
      void context.queryClient.prefetchQuery(q.members());
      void context.queryClient.prefetchQuery(q.invites());
    }
    return { crumb: "Members" };
  },
  component: () => (can(useMe().user.role, "settings") ? <Members /> : <AdminsOnly title="Members" />),
});

function Members() {
  const me = useMe();
  // Changing a role and removing somebody: an owner's. Inviting: an owner's
  // any role, an admin's a member.
  const owner = can(me.user.role, "people");
  const roles = invitable(me.user.role);
  const members = useQuery(q.members());
  const invites = useQuery(q.invites());
  const [inviting, setInviting] = useState(false);
  // The count against the number, where one exists.
  const cap = me.limits.members.limit;
  const full = cap !== null && me.limits.members.used >= cap;
  return (
    <div className="p-7">
      <PageHeader
        title="Members"
        sub={`${owner ? "Only owners change roles or remove people." : "Admins invite members. Ask an owner to change a role or remove someone."}${cap !== null ? ` ${me.limits.members.used} of ${cap} members.` : ""}`}
        actions={
          roles.length ? (
            <Button onClick={() => setInviting(true)} disabled={full} title={full ? `This studio's plan allows ${cap} members.` : undefined}>
              <PlusIcon />
              Invite
            </Button>
          ) : undefined
        }
      />
      <Card className="max-w-[1040px] overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              {owner && <TableHead className="w-0" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(members.data?.data ?? []).map((m) => (
              <MemberRow key={m.email} m={m} owner={owner} />
            ))}
          </TableBody>
        </Table>
      </Card>
      <RoleLegend />
      {(invites.data?.data.length ?? 0) > 0 && <PendingInvites invites={invites.data!.data} roles={roles} />}
      <p className="m-0 mt-3 max-w-[1040px] text-[12.5px] text-muted-foreground">
        People join through an invite link and choose their own password. A forgotten one is reset on the server
        with <code className="font-mono text-[12px]">snagset passwd</code>.
      </p>
      {roles.length > 0 && <InviteDialog open={inviting} onOpenChange={setInviting} mail={invites.data?.mail ?? false} roles={roles} />}
    </div>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

const ROLE_LABEL: Record<AssignableRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** What each role is, in a line — under the list, where the role column is read. */
function RoleLegend() {
  return (
    <dl className="m-0 mt-3 grid max-w-[1040px] grid-cols-[70px_1fr] gap-x-3 gap-y-1 text-[12.5px]" aria-label="Roles">
      {ASSIGNABLE_ROLES.map((r) => (
        <div key={r} className="contents">
          <dt className="font-medium">{ROLE_LABEL[r]}</dt>
          <dd className="m-0 text-muted-foreground">{ROLE_SUMMARY[r]}</dd>
        </div>
      ))}
    </dl>
  );
}

/** `roles`: what the viewer may invite, and so which invites they may withdraw — an admin a member's. */
function PendingInvites({ invites, roles }: { invites: Invite[]; roles: AssignableRole[] }) {
  const revoke = useRevokeInvite();
  const owner = roles.length > 0;
  return (
    <section className="mt-6 max-w-[1040px]" aria-labelledby="pending-invites">
      <div id="pending-invites" className="mb-2">
        <SectionTitle>Pending invites</SectionTitle>
      </div>
      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>For</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Invited by</TableHead>
              <TableHead>Expires</TableHead>
              {owner && <TableHead className="w-0" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {invites.map((i) => (
              <TableRow key={i.id}>
                <TableCell className={i.email ? "" : "text-muted-foreground"}>{i.email ?? "Anyone with the link"}</TableCell>
                <TableCell className="capitalize">{i.role}</TableCell>
                <TableCell className="text-muted-foreground">{i.createdBy ? i.createdBy.name || i.createdBy.email : "—"}</TableCell>
                <TableCell className="text-muted-foreground">{day(i.expiresAt)}</TableCell>
                {owner && (
                  <TableCell className="text-right">
                    {(roles as string[]).includes(i.role) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Revoke the invite for ${i.email ?? "anyone with the link"}`}
                      disabled={revoke.isPending && revoke.variables === i.id}
                      onClick={() => revoke.mutate(i.id)}
                    >
                      Revoke
                    </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </section>
  );
}

function MemberRow({ m, owner }: { m: Member; owner: boolean }) {
  const setRole = useSetMemberRole();
  const remove = useRemoveMember();
  const [confirming, setConfirming] = useState(false);
  return (
    <TableRow>
      <TableCell>
        <span className="flex items-center gap-2.5">
          <Avatar className="size-6">
            <AvatarFallback className="bg-brand-soft text-[10px] font-semibold text-brand">{initials(m.name, m.email)}</AvatarFallback>
          </Avatar>
          <span className="font-medium">{m.name || m.email}</span>
          {m.you && (
            <Badge variant="outline" className="text-[11px]">
              you
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">{m.email}</TableCell>
      <TableCell>
        {owner ? (
          <NativeSelect
            aria-label={`Role for ${m.email}`}
            value={m.role}
            onChange={(e) => setRole.mutate({ email: m.email, role: e.target.value as AssignableRole })}
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <span className="capitalize">{m.role}</span>
        )}
      </TableCell>
      {owner && (
        <TableCell className="text-right">
          {!m.you && (
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.email}`} onClick={() => setConfirming(true)}>
              <XIcon />
            </Button>
          )}
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Remove ${m.name || m.email}?`}
            description="Every session of theirs ends now. Nothing they wrote is destroyed."
            confirmLabel="Remove"
            busy={remove.isPending}
            onConfirm={() => {
              setConfirming(false);
              remove.mutate(m.email);
            }}
          />
        </TableCell>
      )}
    </TableRow>
  );
}

const form = z.object({
  // Optional: blank means the link is for whoever opens it.
  email: z.union([z.literal(""), z.string().trim().email("An email address, or leave it empty")]),
  role: z.enum(ASSIGNABLE_ROLES),
});
type Form = z.infer<typeof form>;

/**
 * Two steps in one dialog: what to invite, then the link. The link is shown
 * HERE and nowhere else — the server keeps only its hash — so the dialog
 * says so, and closing it is the end of it; a lost link is revoked and
 * minted again.
 */
function InviteDialog({
  open,
  onOpenChange,
  mail,
  roles,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mail: boolean;
  /** What this person may invite: all three for an owner, member for an admin. */
  roles: AssignableRole[];
}) {
  const create = useCreateInvite();
  const send = useSendInvite();
  const [error, setError] = useState("");
  const [made, setMade] = useState<MintedInvite | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  // Member first: the designer's seat is the invite a studio sends most.
  const { register, handleSubmit, formState, reset, watch } = useForm<Form>({ resolver: zodResolver(form), defaultValues: { role: "member", email: "" } });
  const picked = watch("role");
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      // Forgotten on close, deliberately: the link is a credential, and the
      // next open is a new invite rather than this one again.
      setMade(null);
      setSent(null);
      setError("");
      send.reset();
      reset();
    }
  };
  const submit = handleSubmit(async (v) => {
    setError("");
    try {
      setMade(await create.mutateAsync({ role: v.role, ...(v.email ? { email: v.email } : {}) }));
    } catch (err) {
      setError(reason(err));
    }
  });
  const mailIt = async () => {
    if (!made) return;
    setError("");
    try {
      setSent((await send.mutateAsync({ id: made.invite.id, token: made.token })).to);
    } catch (err) {
      setError(reason(err));
    }
  };
  // The transport is asked again by the create, so a mail row connected a
  // second ago counts; the list's answer covers the moment before.
  const canMail = (made?.mail ?? mail) && !!made?.invite.email;
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {!made ? (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>Invite someone</DialogTitle>
              <DialogDescription>
                You get a link to send them. Whoever opens it chooses their own name and password, and is signed in. It
                works once and lasts seven days.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
                {error}
              </p>
            )}
            {/* Locked while the invite is minted: an edit made meanwhile would not be the invite you get. */}
            <fieldset disabled={formState.isSubmitting} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <NativeSelect id="invite-role" className="w-full" {...register("role")}>
                  {(["member", "admin", "owner"] as const)
                    .filter((r) => roles.includes(r))
                    .map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                </NativeSelect>
                <p className="m-0 text-[12px] text-muted-foreground" data-testid="invite-role-summary">
                  {ROLE_SUMMARY[picked] ?? ""}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-email">
                  Email <span className="font-normal text-muted-foreground">optional</span>
                </Label>
                <Input id="invite-email" type="email" autoComplete="off" aria-invalid={!!formState.errors.email} {...register("email")} />
                <p className="m-0 text-[12px] text-muted-foreground">
                  {formState.errors.email?.message ??
                    (mail
                      ? "Given, only that address can use the link, and you can mail it to them."
                      : "Given, only that address can use the link.")}
                </p>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => close(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={formState.isSubmitting}>
                  {formState.isSubmitting ? "Creating…" : "Create invite"}
                </Button>
              </DialogFooter>
            </fieldset>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Invite link</DialogTitle>
              <DialogDescription>
                {made.invite.email ? `${made.invite.email} can` : "Anyone with this link can"} join as {asRole(made.invite.role)}{" "}
                until {day(made.invite.expiresAt)}. It works once, and this is the only time it is shown.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
                {error}
              </p>
            )}
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-[12px]" data-testid="invite-url">
                {made.url}
              </code>
              <CopyButton text={made.url} label="Copy link" withText />
            </div>
            {canMail &&
              (sent ? (
                <p role="status" className="m-0 text-[13px] text-muted-foreground">
                  Sent to {sent}.
                </p>
              ) : (
                <Button type="button" variant="outline" className="self-start" loading={send.isPending} onClick={() => void mailIt()}>
                  <MailIcon />
                  {send.isPending ? "Sending…" : `Send by email to ${made.invite.email}`}
                </Button>
              ))}
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

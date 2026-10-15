import { useState } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  ImageOffIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
  UserPlusIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "./ConfirmDialog";
import { SectionTitle, StatusPill } from "./parts";
import { param } from "@snagset/types/names";
import { ApiFailure, REF_KIND, TRACKER_NAME, type Assignee, type Comment, type Reviewer, type Round, type Thread, type Tracker } from "@/lib/api";
import { MoveToRound } from "@/components/app/RoundMenu";
import { briefMarkdown } from "@/lib/brief";
import { canEditComment } from "@/lib/merge";
import { STATUSES, STATUS_LABEL, ago, initials, type Status } from "@/lib/labels";
import { cn } from "@/lib/utils";

/**
 * The thread as a BRIEF: the thread and the composer first, then the
 * screenshot, the element, the environment, and breadcrumbs behind a
 * disclosure. We capture more than any competitor shows — this is where it
 * is finally shown. Every section renders HONESTLY: an empty one
 * is not rendered, and a degraded capture says which word it was.
 */
export function Brief({
  thread,
  site,
  onStatus,
  onReply,
  replying,
  onClose,
  pool,
  onAssign,
  onAddPerson,
  trackers,
  onCreateIssue,
  creatingIssue,
  onEditComment,
  onDeleteComment,
  onDeleteThread,
  move,
}: {
  thread: Thread;
  site: { name: string; origin?: string };
  onStatus: (status: Status) => void;
  onReply: (body: string) => Promise<unknown>;
  replying: boolean;
  onClose: () => void;
  /** The assignee pool: the studio, then everyone who commented. */
  pool: Reviewer[];
  onAssign: (assignee: Assignee | null) => void;
  onAddPerson: (input: { name: string; email?: string }) => Promise<Reviewer>;
  /** The trackers this site is connected to, and the action for each. */
  trackers?: Tracker[];
  onCreateIssue?: (provider: Tracker) => void;
  /** The provider whose issue is being made right now, if any. */
  creatingIssue?: Tracker | undefined;
  /**
   * Moderation. Each resolves when the server has answered and rejects with
   * its refusal, so the control that sent it can stay locked until then
   * and stay open on a failure. Absent ⇒ the control is not drawn.
   */
  onEditComment?: (commentId: string, body: string) => Promise<unknown>;
  onDeleteComment?: (commentId: string) => Promise<unknown>;
  onDeleteThread?: () => Promise<unknown>;
  /** The rounds this thread may be moved to, and the move. Absent ⇒ not drawn (a member or viewer). */
  move?: { rounds: Round[]; onMove: (round: number) => void; busy: boolean };
}) {
  const anchor = (thread.anchor ?? {}) as Record<string, any>;
  const ctx = (thread.context ?? {}) as Record<string, any>;
  const label = typeof anchor.label === "string" ? anchor.label : "";
  const page = anchor.page as { origin?: string; pathname?: string; route?: string } | undefined;
  const route = page?.route ?? thread.route ?? "/";
  const origin = page?.origin ?? site.origin;
  const permalink = origin ? `${origin}${page?.pathname ?? route}?${param("t")}=${encodeURIComponent(thread.key)}` : "";
  const shot = thread.attachments?.find((a) => a.kind === "screenshot") ?? thread.attachments?.[0];
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [deletingThread, setDeletingThread] = useState(false);
  const [busyThread, setBusyThread] = useState(false);
  // Whose replies are "mine": the pool's own row on this site, the id a
  // dashboard reply is written under (the `isMe`).
  const myId = pool.find((r) => r.isMe)?.id;

  const copy = () => {
    void navigator.clipboard?.writeText(briefMarkdown(thread, { name: site.name, ...(origin ? { origin } : {}), dashboardOrigin: location.origin }));
    toast.success("Copied as a brief");
  };

  return (
    <article className="flex min-h-0 flex-1 flex-col" aria-label={`${thread.key} — ${label || "a comment"}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <span className="font-mono text-[12px] text-muted-foreground">{thread.key}</span>
        <StatusMenu status={thread.status} onStatus={onStatus} />
        <AssigneeMenu assignee={thread.assignee ?? null} pool={pool} onAssign={onAssign} onAddPerson={onAddPerson} />
        {(trackers ?? []).map((provider) => {
          const issue = thread.refs?.find((r) => r.provider === provider && r.kind === REF_KIND[provider] && r.status !== "detached");
          if (issue) {
            // GitHub's id is the number; Jira's is the key; Linear's is a uuid, and its key sits in the URL; Slack's is a message.
            const label =
              provider === "github"
                ? `Issue #${issue.externalId}`
                : provider === "jira"
                  ? issue.externalId
                  : provider === "slack"
                    ? "Slack message"
                    : (/\/issue\/([A-Z][A-Z0-9]*-\d+)/.exec(issue.url)?.[1] ?? `${TRACKER_NAME[provider]} issue`);
            return (
              <Button key={provider} variant="ghost" size="sm" render={<a href={issue.url} target="_blank" rel="noreferrer" />}>
                <ExternalLinkIcon />
                {label}
              </Button>
            );
          }
          if (!onCreateIssue) return null;
          return (
            <Button key={provider} variant="ghost" size="sm" disabled={!!creatingIssue} onClick={() => onCreateIssue(provider)}>
              {creatingIssue === provider ? (provider === "slack" ? "Posting…" : "Creating…") : provider === "slack" ? "Post to Slack" : `Create ${TRACKER_NAME[provider]} issue`}
            </Button>
          );
        })}
        <div className="flex-1" />
        {move && <MoveToRound rounds={move.rounds} onMove={move.onMove} busy={move.busy} />}
        <Button variant="ghost" size="sm" onClick={copy}>
          <CopyIcon />
          Copy as brief
        </Button>
        {onDeleteThread && (
          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${thread.key}`} title="Delete this thread" onClick={() => setDeletingThread(true)}>
            <Trash2Icon />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 py-4">
        <div>
          <h1 className="m-0 text-[16px] font-semibold leading-snug tracking-tight">{label || "A comment on this page"}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
            <span className="font-mono">{route}</span>
            {origin && (
              <>
                <span>·</span>
                <a href={`${origin}${page?.pathname ?? route}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
                  {origin.replace(/^https?:\/\//, "")}
                  <ExternalLinkIcon className="size-3" />
                </a>
              </>
            )}
            {permalink && (
              <>
                <span>·</span>
                <a href={permalink} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                  Open on the page
                </a>
              </>
            )}
          </div>
        </div>

        <section className="flex flex-col gap-3">
          {thread.comments.length === 0 && <p className="m-0 text-muted-foreground">A pin with no words — the element says what it is about.</p>}
          {thread.comments.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              mine={canEditComment(c, myId)}
              {...(onEditComment ? { onEdit: (next: string) => onEditComment(c.id, next) } : {})}
              {...(onDeleteComment ? { onDelete: () => onDeleteComment(c.id) } : {})}
            />
          ))}
          <form
            className="flex gap-2.5"
            onSubmit={async (e) => {
              e.preventDefault();
              const text = body.trim();
              if (!text || replying) return;
              setError("");
              try {
                await onReply(text);
                setBody("");
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not send that reply.");
              }
            }}
          >
            <Avatar className="size-6 shrink-0">
              <AvatarFallback className="bg-primary text-[10px] font-semibold text-primary-foreground">you</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-md border border-input bg-card p-2">
              <Textarea
                aria-label="Reply"
                placeholder={`Reply to ${thread.createdBy.name || "the reviewer"}…`}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={2}
                className="min-h-0 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
              />
              {error && (
                <p role="alert" className="m-0 text-[12px] text-destructive">
                  {error}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                {thread.status === "resolved" ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => onStatus("open")}>
                    Reopen
                  </Button>
                ) : (
                  <>
                    {thread.status !== "review" && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => onStatus("review")}>
                        Mark in review
                      </Button>
                    )}
                    <Button type="button" variant="ghost" size="sm" onClick={() => onStatus("resolved")}>
                      Mark resolved
                    </Button>
                  </>
                )}
                <Button type="submit" size="sm" disabled={!body.trim() || replying}>
                  {replying ? "Sending…" : "Reply"}
                </Button>
              </div>
            </div>
          </form>
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>Screenshot</SectionTitle>
          {shot ? (
            <>
              <a href={shot.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-border bg-background">
                <img src={shot.url} alt={`The page when ${thread.key} was left`} width={shot.width} height={shot.height} loading="lazy" className="block h-auto w-full" />
              </a>
              <p className="m-0 text-[12px] text-muted-foreground">
                {shot.width ?? "?"} × {shot.height ?? "?"}
                {ctx.prefersColorScheme ? ` · ${ctx.prefersColorScheme}` : ""} · taken at the click, {ago(thread.createdAt)} ·{" "}
                <a href={shot.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                  open full size
                </a>
              </p>
            </>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-3 text-[12.5px] text-muted-foreground">
              <ImageOffIcon className="size-4 shrink-0" />
              <span>
                No screenshot for this one — either no bucket was connected when it was left, or the reviewer turned the
                picture off. The element and the environment below are unaffected.
              </span>
            </div>
          )}
          <CaptureNotes ctx={ctx} />
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>Element</SectionTitle>
          <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            {label && (
              <>
                <dt className="text-muted-foreground">Label</dt>
                <dd className="m-0">{label}</dd>
              </>
            )}
            {typeof anchor.css === "string" && (
              <>
                <dt className="text-muted-foreground">Selector</dt>
                <dd className="m-0 break-all font-mono text-[12px] text-ink-soft">{anchor.css}</dd>
              </>
            )}
            {typeof anchor.domid === "string" && (
              <>
                <dt className="text-muted-foreground">DOM id</dt>
                <dd className="m-0 font-mono text-[12px] text-ink-soft">#{anchor.domid}</dd>
              </>
            )}
            {typeof anchor.role === "string" && (
              <>
                <dt className="text-muted-foreground">Role</dt>
                <dd className="m-0">
                  {anchor.role}
                  {typeof anchor.accessibleName === "string" ? ` “${anchor.accessibleName}”` : ""}
                </dd>
              </>
            )}
            {anchor.text?.exact && (
              <>
                <dt className="text-muted-foreground">Text</dt>
                <dd className="m-0">“{String(anchor.text.exact)}”</dd>
              </>
            )}
            <dt className="text-muted-foreground">Anchor</dt>
            <dd className="m-0">
              <AnchorState state={thread.anchorState} />
            </dd>
          </dl>
        </section>

        <Environment ctx={ctx} />
        <Breadcrumbs ctx={ctx} />
      </div>
      {onDeleteThread && (
        <ConfirmDialog
          open={deletingThread}
          onOpenChange={setDeletingThread}
          title={`Delete ${thread.key}?`}
          description="Removes this comment thread and its screenshot for everyone. Linked issues in your tracker are not deleted."
          confirmLabel="Delete thread"
          busy={busyThread}
          onConfirm={async () => {
            setBusyThread(true);
            try {
              // On success the row has left the list, and the page closes
              // this panel; there is nothing left to un-busy.
              await onDeleteThread();
              setDeletingThread(false);
            } catch {
              // The hook has already said why, in a toast. The dialog stays
              // open so the person can try again or cancel.
            } finally {
              setBusyThread(false);
            }
          }}
        />
      )}
    </article>
  );
}

/**
 * One comment in the brief, with the studio's two moderation actions behind
 * an ellipsis — the widget's idiom, for the widget's reason: two
 * destructive words beside every line is noise, and a control that appears
 * only on hover does not exist on a touch screen.
 *
 *   · **Edit** only on the person's own live comments (`mine`). The server
 *     refuses an owner rewriting anybody else's words, and a menu item that
 *     can only fail should not be in the menu.
 *   · **Delete** on every live comment: the studio may remove anything said
 *     on its site, behind a confirm that says what survives.
 *
 * A tombstone (`body: null`) keeps its author's name and its place in
 * the conversation, and says what happened instead of what was said. It has
 * no menu — there is nothing left to edit or delete.
 */
function CommentItem({
  comment: c,
  mine,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  mine: boolean;
  onEdit?: (body: string) => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dead = c.body === null;
  const canEdit = mine && !!onEdit;
  const canDelete = !dead && !!onDelete;

  const save = async () => {
    const next = draft.trim();
    if (!next || saving || !onEdit) return;
    if (next === c.body) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onEdit(next);
      setEditing(false);
    } catch {
      // The hook toasted the server's sentence. The field stays open with
      // the draft in it, so the fix is one change and one Save away.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex gap-2.5">
      <Avatar className="size-6 shrink-0">
        <AvatarFallback
          className={cn("text-[10px] font-semibold", dead || c.author.kind === "agent" ? "bg-muted text-ink-soft" : "bg-brand-soft text-brand")}
        >
          {initials(c.author.name, "?")}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[12px] text-muted-foreground">
          <b className={cn("text-[13px] font-semibold", dead ? "text-muted-foreground" : "text-foreground")}>{c.author.name || "Anonymous"}</b>
          {c.author.kind === "agent" && <span className="rounded-sm bg-muted px-1 text-[10.5px] font-medium uppercase tracking-wide">agent</span>}
          <span>{ago(c.createdAt)}</span>
          {(canEdit || canDelete) && !editing && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto self-center text-muted-foreground"
                    aria-label={`Actions for ${c.author.name || "Anonymous"}’s comment`}
                  />
                }
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-36">
                {canEdit && (
                  <DropdownMenuItem
                    onClick={() => {
                      setDraft(c.body ?? "");
                      setEditing(true);
                    }}
                  >
                    <PencilIcon />
                    Edit
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                    <Trash2Icon />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {dead ? (
          // A tombstone is `body: null` and says so.
          <p className="m-0 text-[13.5px] italic leading-normal text-muted-foreground">Comment deleted</p>
        ) : editing ? (
          <form
            className="mt-1 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Textarea
              aria-label="Edit your comment"
              value={draft}
              autoFocus
              rows={3}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void save();
                }
                // Leaves the edit and keeps the original — it does not save a
                // half-typed replacement over words that were already there.
                if (e.key === "Escape" && !saving) {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={saving} disabled={!draft.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        ) : (
          <p className="m-0 whitespace-pre-wrap text-[13.5px] leading-normal">{c.body}</p>
        )}
      </div>
      {canDelete && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Delete this comment?"
          description="Its author's name stays; the text is removed."
          confirmLabel="Delete comment"
          busy={deleting}
          onConfirm={async () => {
            setDeleting(true);
            try {
              await onDelete!();
              setConfirming(false);
            } catch {
              // Toasted by the hook; the dialog stays for a retry or a cancel.
            } finally {
              setDeleting(false);
            }
          }}
        />
      )}
    </div>
  );
}

function StatusMenu({ status, onStatus }: { status: string; onStatus: (s: Status) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" className="inline-flex items-center rounded-full" aria-label="Status" />}>
        <StatusPill status={status} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[180px]">
        <DropdownMenuRadioGroup value={status} onValueChange={(v) => onStatus(v as Status)}>
          {STATUSES.map((s) => (
            <DropdownMenuRadioItem key={s} value={s}>
              {STATUS_LABEL[s]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AnchorState({ state }: { state: string }) {
  const tone =
    state === "anchored"
      ? "bg-ok-soft text-ok"
      : state === "approximate"
        ? "bg-muted text-ink-soft"
        : "bg-warn-soft text-destructive";
  const word = state === "anchored" ? "Anchored" : state === "approximate" ? "Approximate" : state === "orphaned" ? "Orphaned" : state;
  return <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-medium", tone)}>{word}</span>;
}

/** The capture's honest rows: a degraded category says which word, blind spots each get a line. */
function CaptureNotes({ ctx }: { ctx: Record<string, any> }) {
  const cap = ctx.capture as { screenshot?: string; breadcrumbs?: string; reasons?: string[]; blindSpots?: string[]; droppedCategories?: string[] } | undefined;
  if (!cap) return null;
  const notes: string[] = [];
  if (cap.screenshot && cap.screenshot !== "ok") notes.push(`Screenshot ${cap.screenshot}${cap.reasons?.length ? ` — ${cap.reasons.join("; ")}` : ""}`);
  if (cap.breadcrumbs && cap.breadcrumbs !== "ok") notes.push(`Breadcrumbs ${cap.breadcrumbs}`);
  if (cap.blindSpots?.length) notes.push(`${cap.blindSpots.length} blind spot${cap.blindSpots.length === 1 ? "" : "s"}: ${cap.blindSpots.join("; ")}`);
  if (cap.droppedCategories?.length) notes.push(`Dropped: ${cap.droppedCategories.join(", ")}`);
  if (!notes.length) return null;
  return (
    <ul className="m-0 list-none p-0 text-[12px] text-caution">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

function Environment({ ctx }: { ctx: Record<string, any> }) {
  const d = ctx.derived as { browser?: string; os?: string; device?: string } | undefined;
  const vp = ctx.viewport as { w?: number; h?: number; dpr?: number } | undefined;
  const build = ctx.build as Record<string, unknown> | undefined;
  const rows: [string, string][] = [];
  if (d?.browser || d?.os) rows.push(["Browser", [d.browser, d.os, d.device].filter(Boolean).join(" · ")]);
  else if (ctx.ua) rows.push(["User agent", String(ctx.ua)]);
  if (vp?.w) rows.push(["Viewport", `${vp.w} × ${vp.h}${vp.dpr ? ` @${Math.round(vp.dpr * 10) / 10}x` : ""}`]);
  if (ctx.language) rows.push(["Language", String(ctx.language)]);
  if (build && Object.keys(build).length) rows.push(["Build", Object.entries(build).map(([k, v]) => `${k} ${String(v)}`).join(" · ")]);
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionTitle>Environment</SectionTitle>
        <button
          type="button"
          className="text-[11.5px] text-brand hover:underline"
          onClick={() => {
            void navigator.clipboard?.writeText(JSON.stringify(ctx, null, 2));
            toast.success("Copied the environment");
          }}
        >
          copy as JSON
        </button>
      </div>
      <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        {rows.map(([k, v]) => (
          <span key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className={cn("m-0", k === "Build" && "font-mono text-[12px] text-ink-soft")}>{v}</dd>
          </span>
        ))}
      </dl>
    </section>
  );
}

function Breadcrumbs({ ctx }: { ctx: Record<string, any> }) {
  const crumbs = ctx.breadcrumbs as { t: string; type: string; level?: string; message: string }[] | undefined;
  const [open, setOpen] = useState(false);
  if (!crumbs?.length) return null;
  const errors = crumbs.filter((b) => b.level === "error" || b.type === "error").length;
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-[13px] text-ink-soft"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        {crumbs.length} breadcrumb{crumbs.length === 1 ? "" : "s"}
        {errors > 0 ? ` · ${errors} error${errors === 1 ? "" : "s"} before the click` : ""}
        <span className="ml-auto text-[12px] text-muted-foreground">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <ol className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[11.5px]">
          {crumbs.map((b, i) => (
            <li key={i} className={cn("flex gap-2", (b.level === "error" || b.type === "error") && "text-destructive")}>
              <span className="shrink-0 text-muted-foreground">{b.t.slice(11, 19)}</span>
              <span className="shrink-0 w-14 text-muted-foreground">{b.type}{b.level ? `/${b.level}` : ""}</span>
              <span className="min-w-0 break-words">{b.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Who holds it — the pool as a menu: yourself first, then the studio,
 * then the people who commented, then a name for somebody who has not yet
 * (the "assigned to the client to answer" before the client has spoken).
 */
function AssigneeMenu({
  assignee,
  pool,
  onAssign,
  onAddPerson,
}: {
  assignee: Assignee | null;
  pool: Reviewer[];
  onAssign: (assignee: Assignee | null) => void;
  onAddPerson: (input: { name: string; email?: string }) => Promise<Reviewer>;
}) {
  const [adding, setAdding] = useState(false);
  const me = pool.find((r) => r.isMe);
  const team = pool.filter((r) => r.isTeam);
  const others = pool.filter((r) => !r.isTeam);
  const pick = (r: Reviewer) => onAssign({ id: r.id, name: r.name, kind: r.kind, isTeam: r.isTeam });
  const person = (r: Reviewer) => (
    <DropdownMenuItem key={r.id} onClick={() => pick(r)}>
      <Avatar className="size-4">
        <AvatarFallback className={cn("text-[8px] font-semibold", r.isTeam ? "bg-brand-soft text-brand" : "bg-muted text-ink-soft")}>
          {initials(r.name, r.email)}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{r.isMe ? `${r.name} (you)` : r.name}</span>
      {assignee?.id === r.id && <CheckIcon className="ml-auto size-3.5" />}
    </DropdownMenuItem>
  );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" aria-label={assignee ? `Assignee: ${assignee.name}` : "Assignee"} />}
        >
          {assignee ? (
            <>
              <Avatar className="size-4">
                <AvatarFallback className={cn("text-[8px] font-semibold", assignee.isTeam ? "bg-brand-soft text-brand" : "bg-muted text-ink-soft")}>
                  {initials(assignee.name)}
                </AvatarFallback>
              </Avatar>
              <span className="max-w-[150px] truncate">{assignee.name}</span>
            </>
          ) : (
            <>
              <UserRoundIcon />
              Assign
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          {(me && assignee?.id !== me.id) || assignee ? (
            <DropdownMenuGroup>
              {me && assignee?.id !== me.id && <DropdownMenuItem onClick={() => pick(me)}>Assign to me</DropdownMenuItem>}
              {assignee && <DropdownMenuItem onClick={() => onAssign(null)}>Unassign</DropdownMenuItem>}
            </DropdownMenuGroup>
          ) : null}
          {team.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>The studio</DropdownMenuLabel>
              {team.map(person)}
            </DropdownMenuGroup>
          )}
          {others.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>People who commented</DropdownMenuLabel>
              {others.map(person)}
            </DropdownMenuGroup>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setAdding(true)}>
              <UserPlusIcon />
              Add a person…
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddPerson
        open={adding}
        onOpenChange={setAdding}
        onAdd={async (input) => {
          const made = await onAddPerson(input);
          pick(made);
        }}
      />
    </>
  );
}

/** A name to assign to before they have written — a placeholder, not an invitation. */
function AddPerson({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdd: (input: { name: string; email?: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onAdd({ name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}) });
      setName("");
      setEmail("");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not add the person.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Add a person</DialogTitle>
            <DialogDescription>
              Somebody to assign comments to who has not commented yet — your client, before they have said anything. If
              they later open a review link with this email, their comments join up.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="person-name">Name</Label>
            <Input id="person-name" placeholder="Sofia" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="person-email">Email (optional)</Label>
            <Input id="person-email" type="email" placeholder="sofia@acme.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              {busy ? "Adding…" : "Add and assign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

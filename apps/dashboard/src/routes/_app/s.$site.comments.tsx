import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ArrowLeftIcon, ChevronDownIcon, ColumnsIcon, InboxIcon, ListIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Brief } from "@/components/app/Brief";
import { InstallTag } from "@/components/app/InstallTag";
import { EmptyState, StatusPill } from "@/components/app/parts";
import { MoveToRound, RoundMenu } from "@/components/app/RoundMenu";
import type { Reviewer, Round, Thread } from "@/lib/api";
import { STATUSES, STATUS_LABEL, ago, initials, isStatus, type Status } from "@/lib/labels";
import { useMe } from "@/lib/me";
import { q } from "@/lib/query";
import {
  threadsQuery,
  useAddAssignee,
  useAddComment,
  useCreateIssue,
  useCreateRound,
  useMoveThreads,
  useDeleteComment,
  useDeleteThread,
  useEditComment,
  useSetAssignee,
  useSetStatus,
} from "@/lib/threads";
import { cn } from "@/lib/utils";

/**
 * Comments — the list, GROUPED BY PAGE, with the brief beside it. Every
 * piece of view state is a search param, so any view is a link. The round
 * governs the list and lives at its top; status chips carry whole-round
 * counts; page and search go to the server.
 */
const search = z.object({
  thread: z.string().optional(),
  status: z.string().optional(),
  page: z.string().optional(),
  q: z.string().optional(),
  sort: z.enum(["newest", "oldest"]).optional(),
  round: z.number().int().positive().optional(),
  /** `unassigned`, `me`, or a reviewer id — client-side, like status. */
  assignee: z.string().optional(),
  /** The board is a VIEW, never the default ("not taken"). */
  view: z.enum(["board"]).optional(),
});
type Search = z.infer<typeof search>;

export const Route = createFileRoute("/_app/s/$site/comments")({
  validateSearch: search,
  loaderDeps: ({ search }) => ({ round: search.round, page: search.page, q: search.q }),
  /**
   * Everything the screen reads, asked for AT ONCE. The list waited for the
   * rounds (to know which round to ask for), and the pool, the trackers and
   * the addresses waited for the component to mount — three requests in
   * series where one round trip does. The round is the URL's, else the one `/me` already
   * named (`landingRound`); the rounds still decide, and on the rare load
   * where they disagree (a round started elsewhere a moment ago) the right
   * list is asked for once they arrive.
   */
  loader: async ({ context, deps }) => {
    const { queryClient: qc, site } = context;
    const list = (round: number | undefined) =>
      void qc.prefetchQuery(
        threadsQuery(site.uid, {
          ...(round !== undefined ? { round } : {}),
          ...(deps.page ? { route: deps.page } : {}),
          ...(deps.q ? { q: deps.q } : {}),
        }),
      );
    void qc.prefetchQuery(q.assignees(site.uid));
    void qc.prefetchQuery(q.siteIntegrations(site.uid));
    void qc.prefetchQuery(q.origins(site.uid));
    const early = deps.round ?? site.landingRound ?? undefined;
    if (early !== undefined) list(early);
    const rounds = await qc.ensureQueryData(q.rounds(site.uid));
    const round = deps.round ?? landing(rounds.data);
    if (early === undefined || round !== early) list(round);
    return { crumb: "Comments" };
  },
  component: Comments,
});

/**
 * The round a fresh visit lands in: the newest OPEN, unarchived one — where
 * the widget's reviewers are and where new comments go — else the
 * newest unarchived, else the newest of all.
 */
function landing(rounds: Round[]): number | undefined {
  const live = rounds.filter((r) => !r.archived);
  return (live.find((r) => !r.closed) ?? live[0] ?? rounds[0])?.number;
}

const DOT: Record<Status, string> = {
  open: "bg-status-open",
  progress: "bg-status-progress",
  review: "bg-status-review",
  resolved: "bg-status-resolved",
};

function Comments() {
  const { site: uid } = Route.useParams();
  const s = Route.useSearch();
  const navigate = useNavigate();
  const me = useMe();
  const site = me.projects.find((p) => p.uid === uid)!;
  const origins = useQuery(q.origins(uid));
  const rounds = useQuery(q.rounds(uid));
  const pool = useQuery(q.assignees(uid));
  const trackers = useQuery(q.siteIntegrations(uid));
  const people = pool.data?.data ?? [];
  const myId = people.find((r) => r.isMe)?.id;
  const activeRound = s.round ?? (rounds.data ? landing(rounds.data.data) : undefined);
  // Archived rounds are put away: out of the menu and the banners,
  // unless it is the one in the address bar.
  const menuRounds = (rounds.data?.data ?? []).filter((r) => !r.archived || r.number === activeRound);
  const filters = useMemo(
    () => ({
      ...(activeRound !== undefined ? { round: activeRound } : {}),
      ...(s.page ? { route: s.page } : {}),
      ...(s.q ? { q: s.q } : {}),
    }),
    [activeRound, s.page, s.q],
  );
  const list = useQuery({ ...threadsQuery(uid, filters), enabled: rounds.isSuccess });
  const key = threadsQuery(uid, filters).queryKey;
  const setStatus = useSetStatus(uid, key);
  const addComment = useAddComment(key);
  const setAssignee = useSetAssignee(uid, key);
  const addPerson = useAddAssignee(uid);
  const createIssue = useCreateIssue(uid, key);
  const createRound = useCreateRound(uid);
  const moveThreads = useMoveThreads(uid);
  const editComment = useEditComment(key);
  const deleteComment = useDeleteComment(key);
  const deleteThread = useDeleteThread(uid, key);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const go = (next: Partial<Search>) =>
    void navigate({ to: "/s/$site/comments", params: { site: uid }, search: (prev) => ({ ...prev, ...next }), replace: true });

  const rows = list.data?.data ?? [];
  const statusSet = useMemo(() => new Set((s.status ?? "").split(",").filter(Boolean)), [s.status]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of rows) m.set(t.status, (m.get(t.status) ?? 0) + 1);
    return m;
  }, [rows]);
  const pages = useMemo(() => [...new Set(rows.map((t) => pageOf(t)))].sort(), [rows]);
  const visible = useMemo(() => {
    let v = statusSet.size ? rows.filter((t) => statusSet.has(t.status)) : rows;
    // The assignee filters client-side like status does, so the chips keep
    // their whole-round counts and "Unassigned" needs no second query.
    if (s.assignee === "unassigned") v = v.filter((t) => !t.assignee);
    else if (s.assignee === "me") v = v.filter((t) => !!myId && t.assignee?.id === myId);
    else if (s.assignee) v = v.filter((t) => t.assignee?.id === s.assignee);
    if (s.sort === "oldest") v = [...v].reverse();
    return v;
  }, [rows, statusSet, s.sort, s.assignee, myId]);
  const groups = useMemo(() => {
    const g = new Map<string, Thread[]>();
    for (const t of visible) {
      const p = pageOf(t);
      if (!g.has(p)) g.set(p, []);
      g.get(p)!.push(t);
    }
    return [...g.entries()];
  }, [visible]);
  const selected = s.thread ? rows.find((t) => t.key === s.thread) ?? null : null;
  const filtered = statusSet.size > 0 || !!s.page || !!s.q || !!s.assignee;
  const others = menuRounds.filter((r) => r.number !== activeRound && r.unresolved > 0);
  // Where a comment may be filed — open or closed, never archived, never
  // the round on screen. Owners and admins only; the server says the same.
  const canMove = me.user.role === "owner" || me.user.role === "admin";
  const moveTargets = canMove ? menuRounds.filter((r) => !r.archived && r.number !== activeRound) : [];
  const moveTo = (ids: string[], round: number) =>
    moveThreads.mutate(
      { ids, round },
      {
        onSuccess: () => {
          setPicked(new Set());
          if (s.thread && ids.includes(selected?.id ?? "")) go({ thread: undefined });
        },
      },
    );

  const toggleStatus = (st: string) => {
    const next = new Set(statusSet);
    if (next.has(st)) next.delete(st);
    else next.add(st);
    go({ status: [...next].join(",") || undefined });
  };
  const bulk = async (status: Status) => {
    const ids = [...picked];
    setPicked(new Set());
    for (const id of ids) await setStatus.mutateAsync({ id, status }).catch(() => {});
  };

  /**
   * j / k / e, and the reason this screen exists at all: triage is a
   * list you go down. `j` and `k` move through what is VISIBLE, in the order
   * on screen, so a filter or the board's columns change what they mean and
   * that is correct. `e` ends the one you are on — resolved, or back to open
   * if it already is, which is the same toggle the brief's own button makes.
   *
   * Never while typing, never with a modifier: the same rule the widget's
   * pointer net applies, for the same reason — a single letter is not ours
   * inside a text field, and ⌘K belongs to the palette.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input,textarea,select,[contenteditable]") || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k !== "j" && k !== "k" && k !== "e") return;
      if (visible.length === 0) return;
      e.preventDefault();
      if (k === "e") {
        if (!selected) return;
        setStatus.mutate({ id: selected.id, status: selected.status === "resolved" ? "open" : "resolved" });
        return;
      }
      const at = selected ? visible.findIndex((x) => x.id === selected.id) : -1;
      const next = k === "j" ? Math.min(at + 1, visible.length - 1) : Math.max(at - 1, 0);
      const to = visible[at === -1 ? 0 : next];
      if (to) go({ thread: to.key });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const board = s.view === "board";
  const columns = useMemo(
    () => STATUSES.map((st) => ({ status: st, items: visible.filter((t) => t.status === st) })),
    [visible],
  );

  return (
    <div className="flex h-[calc(100dvh-3rem)] min-h-0 flex-col">
      {/* The bar: the round first, then the filters — or the bulk actions once something is ticked. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
        {picked.size > 0 ? (
          <>
            <span className="text-[13px] font-medium">{picked.size} selected</span>
            <span className="text-[12px] text-muted-foreground">Move to</span>
            {STATUSES.map((st) => (
              <Button key={st} variant="outline" size="sm" onClick={() => void bulk(st)}>
                {STATUS_LABEL[st]}
              </Button>
            ))}
            <MoveToRound rounds={moveTargets} busy={moveThreads.isPending} onMove={(n) => moveTo([...picked], n)} />
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
          </>
        ) : (
          <>
            {menuRounds.length > 0 && activeRound !== undefined && (
              <RoundMenu
                rounds={menuRounds}
                active={activeRound}
                onPick={(n) => go({ round: n, thread: undefined })}
                onStart={(name) =>
                  createRound.mutate(name, {
                    onSuccess: (made) => go({ round: made.number, thread: undefined, status: undefined }),
                  })
                }
                starting={createRound.isPending}
              />
            )}
            <span className="mx-1 h-[18px] w-px bg-border" />
            <Chip on={statusSet.size === 0} onClick={() => go({ status: undefined })}>
              All <span className="text-muted-foreground">{rows.length}</span>
            </Chip>
            {STATUSES.map((st) => (
              <Chip key={st} on={statusSet.has(st)} onClick={() => toggleStatus(st)}>
                <span className={cn("size-[7px] rounded-full", DOT[st])} />
                {STATUS_LABEL[st]} <span className="text-muted-foreground">{counts.get(st) ?? 0}</span>
              </Chip>
            ))}
            <div className="flex-1" />
            <Chip on={board} onClick={() => go({ view: board ? undefined : "board" })}>
              {board ? <ListIcon className="size-3.5" /> : <ColumnsIcon className="size-3.5" />}
              {board ? "List" : "Board"}
            </Chip>
            <SearchBox value={s.q ?? ""} onChange={(v) => go({ q: v || undefined })} />
            {pages.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<button type="button" className={chipClass(!!s.page)} />}>
                  {s.page ?? "All pages"}
                  <ChevronDownIcon className="size-3 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => go({ page: undefined })}>All pages</DropdownMenuItem>
                  {pages.map((p) => (
                    <DropdownMenuItem key={p} onClick={() => go({ page: p })}>
                      <span className="font-mono text-[12px]">{p}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<button type="button" className={chipClass(!!s.assignee)} aria-label="Filter by assignee" />}>
                {assigneeLabel(s.assignee, people)}
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={s.assignee ?? "any"} onValueChange={(v) => go({ assignee: v === "any" ? undefined : v })}>
                  <DropdownMenuRadioItem value="any">Anyone</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="unassigned">Unassigned</DropdownMenuRadioItem>
                  {myId && <DropdownMenuRadioItem value="me">Me</DropdownMenuRadioItem>}
                  {people
                    .filter((r) => !r.isMe)
                    .map((r) => (
                      <DropdownMenuRadioItem key={r.id} value={r.id}>
                        {r.name}
                      </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger render={<button type="button" className={chipClass(false)} />}>
                {s.sort === "oldest" ? "Oldest" : "Newest"}
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={s.sort ?? "newest"} onValueChange={(v) => go({ sort: v === "oldest" ? "oldest" : undefined })}>
                  <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="oldest">Oldest first</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {/* The safeguard: what is unfinished in the rounds you are not looking at, never dismissible. */}
      {others.map((r) => (
        <button
          key={r.id}
          type="button"
          className="shrink-0 border-b border-border/60 bg-brand-soft px-4 py-1.5 text-left text-[12.5px] text-foreground"
          onClick={() => go({ round: r.number, thread: undefined })}
        >
          <b className="font-semibold">{r.unresolved} unresolved</b> in {r.name} — still open, not carried over.{" "}
          <span className="text-brand">Go there</span>
        </button>
      ))}

      <div className={cn("grid min-h-0 flex-1", selected ? "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_520px]" : "grid-cols-1")}>
        <div className={cn("min-h-0 overflow-auto lg:border-r lg:border-border", selected && "hidden lg:block")}>
          {list.isPending && <ListSkeleton />}
          {list.isError && <EmptyState title="Could not load the comments">{list.error.message}</EmptyState>}
          {list.isSuccess && rows.length === 0 && !filtered && (
            <div className="mx-auto max-w-[560px] py-8">
              <EmptyState icon={<InboxIcon className="size-5" />} title="No comments yet">
                <p className="m-0">When someone leaves a comment on {site.name} it appears here, grouped by page.</p>
                <div className="mt-4 text-left">
                  <InstallTag uid={uid} />
                </div>
              </EmptyState>
            </div>
          )}
          {list.isSuccess && rows.length > 0 && visible.length === 0 && (
            <EmptyState
              title="Nothing matches"
              action={
                <Button variant="outline" size="sm" onClick={() => go({ status: undefined, page: undefined, q: undefined, assignee: undefined })}>
                  Show all
                </Button>
              }
            >
              No comment matches that filter.
            </EmptyState>
          )}
          {board && list.isSuccess && visible.length > 0 && (
            <Board columns={columns} uid={uid} selectedId={selected?.id ?? null} onMove={(id, status) => setStatus.mutate({ id, status })} />
          )}
          {!board &&
            groups.map(([page, items]) => (
            <div key={page}>
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-background px-4 py-2 font-mono text-[12px] text-ink-soft">
                {page} <span className="font-sans text-muted-foreground">· {items.length}</span>
              </div>
              {items.map((t) => (
                <Row
                  key={t.id}
                  t={t}
                  uid={uid}
                  on={selected?.id === t.id}
                  picked={picked.has(t.id)}
                  picking={picked.size > 0}
                  onPick={(v) =>
                    setPicked((cur) => {
                      const next = new Set(cur);
                      if (v) next.add(t.id);
                      else next.delete(t.id);
                      return next;
                    })
                  }
                />
              ))}
            </div>
            ))}
        </div>
        {selected && (
          // A COLUMN, so the brief below is handed this cell's height and its
          // own body scrolls. As a plain block the brief grew to its full
          // length and overflow-hidden cut the bottom off — the screenshot,
          // the element and the breadcrumbs could not be reached.
          <div className="flex min-h-0 flex-col overflow-hidden bg-card">
            <div className="lg:hidden">
              <Button variant="ghost" size="sm" className="m-2" onClick={() => go({ thread: undefined })}>
                <ArrowLeftIcon />
                Back to the list
              </Button>
            </div>
            <Brief
              thread={selected}
              site={{ name: site.name, ...(origins.data?.origins[0] ? { origin: origins.data.origins[0] } : {}) }}
              onStatus={(status) => setStatus.mutate({ id: selected.id, status })}
              onReply={(body) => addComment.mutateAsync({ id: selected.id, body })}
              replying={addComment.isPending}
              pool={people}
              onAssign={(assignee) => setAssignee.mutate({ id: selected.id, assignee })}
              onAddPerson={(input) => addPerson.mutateAsync(input)}
              trackers={(trackers.data?.data ?? []).map((t) => t.provider)}
              onCreateIssue={(provider) => createIssue.mutate({ id: selected.id, provider })}
              creatingIssue={createIssue.isPending ? createIssue.variables?.provider : undefined}
              onEditComment={(commentId, body) => editComment.mutateAsync({ threadId: selected.id, commentId, body })}
              onDeleteComment={(commentId) => deleteComment.mutateAsync({ threadId: selected.id, commentId })}
              // The matrix: everyone in the studio but a viewer. The server
              // enforces it; this only keeps a control that would fail out of
              // the header.
              {...(me.user.role !== "viewer"
                ? {
                    onDeleteThread: async () => {
                      await deleteThread.mutateAsync(selected.id);
                      // The row has left the list, so `selected` is about to
                      // be null anyway; dropping the key from the URL keeps a
                      // reload or a copied link from pointing at nothing.
                      go({ thread: undefined });
                    },
                  }
                : {})}
              {...(moveTargets.length
                ? { move: { rounds: moveTargets, busy: moveThreads.isPending, onMove: (n: number) => moveTo([selected.id], n) } }
                : {})}
              onClose={() => go({ thread: undefined })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** What the assignee chip says: the filter in a word, or the person's name. */
function assigneeLabel(sel: string | undefined, people: Reviewer[]): string {
  if (!sel) return "Assignee";
  if (sel === "unassigned") return "Unassigned";
  if (sel === "me") return "Me";
  return people.find((r) => r.id === sel)?.name ?? "Assignee";
}

function pageOf(t: Thread): string {
  const page = t.anchor?.page as { route?: string } | undefined;
  return page?.route ?? t.route ?? "/";
}

function chipClass(on: boolean): string {
  return cn(
    "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-2.5 text-[12.5px] font-medium text-ink-soft",
    on && "border-line-strong bg-muted text-foreground",
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={chipClass(on)} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [local, setLocal] = useState(value);
  return (
    <form
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        onChange(local.trim());
      }}
    >
      <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        aria-label="Search comments"
        placeholder="Search"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => local.trim() !== value && onChange(local.trim())}
        className="h-7 w-[170px] pl-7 text-[12.5px]"
      />
    </form>
  );
}

function Row({
  t,
  uid,
  on,
  picked,
  picking,
  onPick,
}: {
  t: Thread;
  uid: string;
  on: boolean;
  picked: boolean;
  picking: boolean;
  onPick: (v: boolean) => void;
}) {
  const body = t.comments[0]?.body ?? (typeof t.anchor?.label === "string" ? t.anchor.label : "(no comment)");
  const label = t.comments[0]?.body && typeof t.anchor?.label === "string" ? t.anchor.label : "";
  return (
    <div
      className={cn(
        "group grid h-12 grid-cols-[22px_56px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border/60 bg-card px-4 hover:bg-accent/60",
        on && "bg-brand-soft hover:bg-brand-soft",
      )}
    >
      <span className={cn("flex items-center", !picking && "opacity-0 group-hover:opacity-100 focus-within:opacity-100")}>
        <Checkbox checked={picked} onCheckedChange={(v) => onPick(!!v)} aria-label={`Select ${t.key}`} />
      </span>
      <Link to="/s/$site/comments" params={{ site: uid }} search={(prev) => ({ ...prev, thread: t.key })} className="contents text-foreground">
        <span className="font-mono text-[11.5px] text-muted-foreground">{t.key}</span>
        <span className="truncate text-[13.5px]">
          {body}
          {label && <small className="ml-2 text-[12px] text-muted-foreground">{label}</small>}
        </span>
        <span className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
          <span className="hidden sm:inline">{t.createdBy.name || "someone"}</span>
          {t.assignee && (
            <Avatar className="size-5" title={`Assigned to ${t.assignee.name}`}>
              <AvatarFallback className={cn("text-[9px] font-semibold", t.assignee.isTeam ? "bg-brand-soft text-brand" : "bg-muted text-ink-soft")}>
                {initials(t.assignee.name)}
              </AvatarFallback>
            </Avatar>
          )}
          <StatusPill status={t.status} />
          <span className="w-11 whitespace-nowrap text-right">{ago(t.updatedAt)}</span>
        </span>
      </Link>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col">
      <div className="flex items-center border-b border-border/60 bg-background px-4 py-2">
        <Skeleton className="h-3 w-16" />
      </div>
      {[70, 55, 80, 62].map((w, i) => (
        <div key={i} className="grid h-12 grid-cols-[22px_56px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border/60 px-4">
          <span />
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3" style={{ width: `${w}%` }} />
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-3 w-11" />
            <Skeleton className="h-[18px] w-16 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export { isStatus };

/**
 * The board, and "not taken: the kanban as the DEFAULT".
 * A view, reached from a chip, remembered in the URL like every other piece
 * of view state on this screen, and off unless asked for.
 *
 * A card is dragged between columns to change its status, and the drag is
 * the browser's own — `draggable` plus three handlers, no library, because
 * a kanban is the one interaction HTML5 drag-and-drop was actually designed
 * for. Dragging is never the only way: a card is also a link to the brief,
 * where the status menu has always been, so a keyboard or a screen reader
 * loses nothing. `j`/`k`/`e` work here exactly as they do in the list.
 */
function Board({
  columns,
  uid,
  selectedId,
  onMove,
}: {
  columns: { status: Status; items: Thread[] }[];
  uid: string;
  selectedId: string | null;
  onMove: (id: string, status: Status) => void;
}) {
  const [over, setOver] = useState<Status | null>(null);
  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-3">
      {columns.map(({ status, items }) => (
        <section
          key={status}
          aria-label={STATUS_LABEL[status]}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(status);
          }}
          onDragLeave={() => setOver((c) => (c === status ? null : c))}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            const id = e.dataTransfer.getData("text/plain");
            if (id) onMove(id, status);
          }}
          className={cn(
            "flex w-[280px] shrink-0 flex-col rounded-lg border border-border bg-muted/40",
            over === status && "border-brand bg-brand-soft",
          )}
        >
          <h3 className="m-0 flex items-center gap-2 px-3 py-2 text-[12px] font-medium">
            <span className={cn("size-[7px] rounded-full", DOT[status])} />
            {STATUS_LABEL[status]}
            <span className="text-muted-foreground">{items.length}</span>
          </h3>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2 pt-0">
            {items.length === 0 && <p className="m-0 px-1 py-3 text-[12px] text-muted-foreground">Nothing here.</p>}
            {items.map((t) => (
              <Link
                key={t.id}
                to="/s/$site/comments"
                params={{ site: uid }}
                search={(prev) => ({ ...prev, thread: t.key })}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", t.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                className={cn(
                  "flex cursor-grab flex-col gap-1.5 rounded-md border border-border bg-card p-2.5 text-foreground no-underline active:cursor-grabbing",
                  selectedId === t.id && "border-brand ring-1 ring-brand",
                )}
              >
                <span className="line-clamp-3 text-[13px]">{t.comments[0]?.body ?? (typeof t.anchor?.label === "string" ? t.anchor.label : "(no comment)")}</span>
                <span className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                  <span className="font-mono">{t.key}</span>
                  <span className="truncate">{pageOf(t)}</span>
                  <span className="flex-1" />
                  {t.assignee && (
                    <Avatar className="size-4" title={`Assigned to ${t.assignee.name}`}>
                      <AvatarFallback className={cn("text-[8px] font-semibold", t.assignee.isTeam ? "bg-brand-soft text-brand" : "bg-muted text-ink-soft")}>
                        {initials(t.assignee.name)}
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <span>{ago(t.updatedAt)}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ActivityIcon, BlocksIcon, Building2Icon, LayoutGridIcon, MessageSquareIcon, SearchIcon, UserIcon, UsersIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, isStatus } from "@/lib/labels";
import { useMe } from "@/lib/me";
import { Spinner } from "./Pending";

/**
 * ⌘K. One field that goes anywhere.
 *
 * The dashboard has six screens and a site switcher, and the thing a studio
 * actually wants at nine in the morning is *"the comment about the price
 * table"* — which lives on a site they would have to remember first. So the
 * palette does two things at once: it lists the screens and the sites, and
 * the moment you type it also SEARCHES COMMENTS ACROSS EVERY SITE
 * (`GET /api/v1/activity?q=`, the same three columns a site's own search
 * box uses, so the two can never disagree about what matches).
 *
 * Written rather than installed. `cmdk` is 12 kB for a list, a filter and
 * arrow keys, and the one thing it would have given us for free — the
 * filtering — is not what is hard here; the remote half is.
 */

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  go: () => void;
}

export function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const me = useMe();
  const navigate = useNavigate();
  const [term, setTerm] = useState("");
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const q = term.trim();

  // The remote half. Debounced, and only once there is something to look
  // for: a palette that queries on every keystroke of "p" is a palette that
  // makes the server work for a letter.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 180);
    return () => clearTimeout(t);
  }, [q]);
  const hits = useQuery({
    queryKey: ["activity", "search", debounced] as const,
    queryFn: () => api.activity({ q: debounced, status: "all", limit: 8 }),
    enabled: open && debounced.length >= 2,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open) {
      setTerm("");
      setAt(0);
    }
  }, [open]);

  const screens: Item[] = useMemo(
    () => [
      { id: "s:sites", label: "Sites", icon: <LayoutGridIcon className="size-4" />, go: () => void navigate({ to: "/sites" }) },
      { id: "s:activity", label: "Activity", hint: "every site, newest first", icon: <ActivityIcon className="size-4" />, go: () => void navigate({ to: "/activity" }) },
      { id: "s:members", label: "Members", icon: <UsersIcon className="size-4" />, go: () => void navigate({ to: "/studio/members" }) },
      { id: "s:integrations", label: "Integrations", icon: <BlocksIcon className="size-4" />, go: () => void navigate({ to: "/studio/integrations" }) },
      { id: "s:studio", label: "Studio settings", icon: <Building2Icon className="size-4" />, go: () => void navigate({ to: "/studio" }) },
      { id: "s:you", label: "You", icon: <UserIcon className="size-4" />, go: () => void navigate({ to: "/you" }) },
    ],
    [navigate],
  );

  const sites: Item[] = useMemo(
    () =>
      me.projects.map((p) => ({
        id: `p:${p.uid}`,
        label: p.name,
        hint: p.unresolved > 0 ? `${p.unresolved} open` : "nothing open",
        icon: <MessageSquareIcon className="size-4" />,
        go: () => void navigate({ to: "/s/$site/comments", params: { site: p.uid } }),
      })),
    [me.projects, navigate],
  );

  const matches = (label: string) => !q || label.toLowerCase().includes(q.toLowerCase());
  const groups: { title: string; items: Item[] }[] = [];
  const localSites = sites.filter((i) => matches(i.label));
  const localScreens = screens.filter((i) => matches(i.label));
  if (localSites.length) groups.push({ title: "Sites", items: localSites });
  if (localScreens.length) groups.push({ title: "Go to", items: localScreens });
  const found = (hits.data?.data ?? []).map<Item>((r) => ({
    id: `t:${r.id}`,
    label: r.latest?.body?.trim() || r.route,
    hint: `${r.site.name} · ${isStatus(r.status) ? STATUS_LABEL[r.status] : r.status} · ${r.key}`,
    icon: <MessageSquareIcon className="size-4" />,
    go: () => void navigate({ to: "/s/$site/comments", params: { site: r.site.uid }, search: { thread: r.key } }),
  }));
  if (found.length) groups.push({ title: "Comments", items: found });

  const flat = groups.flatMap((g) => g.items);
  const cursor = Math.min(at, Math.max(0, flat.length - 1));
  const run = (item: Item | undefined) => {
    if (!item) return;
    onOpenChange(false);
    item.go();
  };

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-at="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[15%] max-h-[70dvh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">Search and go</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAt((n) => Math.min(n + 1, flat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setAt((n) => Math.max(n - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(flat[cursor]);
              }
            }}
            placeholder="Go to a site or a screen, or search every comment…"
            aria-label="Search and go"
            className="h-11 w-full bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1.5">
          {flat.length === 0 && (
            <p className="m-0 px-3 py-6 text-center text-[13px] text-muted-foreground">
              {hits.isFetching ? "Looking…" : q ? `Nothing matches “${q}”.` : "Nothing here."}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.title}>
              <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g.title}</div>
              {g.items.map((item) => {
                const i = flat.indexOf(item);
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-at={i}
                    onMouseMove={() => setAt(i)}
                    onClick={() => run(item)}
                    className={cn(
                      "flex w-full items-center gap-2.5 border-0 bg-transparent px-3 py-2 text-left text-[13px] text-foreground",
                      i === cursor && "bg-muted",
                    )}
                  >
                    <span className="shrink-0 text-muted-foreground">{item.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.hint && <span className="shrink-0 text-[12px] text-muted-foreground">{item.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {hits.isFetching && flat.length > 0 && <p className="m-0 flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-muted-foreground">
              <Spinner className="size-3" />
              Searching every site…
            </p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** ⌘K anywhere — and never while the reviewer is typing into something. */
export function usePalette(): [boolean, (o: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return [open, setOpen];
}

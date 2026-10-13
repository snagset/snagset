import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { PageHeader, StatusPill } from "@/components/app/parts";
import { api, type ActivityRow } from "@/lib/api";
import { ago, STATUSES, STATUS_LABEL } from "@/lib/labels";
import { useMe } from "@/lib/me";
import { RowsPending } from "@/components/app/Pending";

/**
 * Activity, the last thing the maintainer named that had no screen:
 * *"new activity across all projects, archive etc"*.
 *
 * Sites answers "how many are open", which is a number. This answers "what
 * happened", which is the question you have at nine in the morning with six
 * clients. Newest change first, every site in one column, each line saying
 * which site it belongs to and carrying the words that were actually written.
 *
 * There is no archive column: `Resolved` IS the archive (the status set)
 * so the desk and the archive are one filter apart and nothing new had
 * to be invented to hold a thread that is done.
 */

const search = z.object({
  status: z.string().optional(),
  site: z.string().optional(),
});

export const Route = createFileRoute("/_app/activity")({
  validateSearch: search,
  loader: () => ({ crumb: "Activity" }),
  component: Activity,
});

const FILTERS: { value: string; label: string }[] = [
  { value: "unresolved", label: "Needs attention" },
  ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
  { value: "all", label: "Everything" },
];

/** Today, Yesterday, then the date — a feed is read by when, not by page. */
function dayOf(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

function Activity() {
  const me = useMe();
  const { status = "unresolved", site } = Route.useSearch();
  const navigate = useNavigate({ from: "/activity" });
  const go = (patch: { status?: string; site?: string | undefined }) =>
    void navigate({ search: (s) => ({ ...s, ...patch }), replace: true });

  const feed = useInfiniteQuery({
    queryKey: ["activity", status, site ?? null] as const,
    queryFn: ({ pageParam }) => api.activity({ status, ...(site ? { site } : {}), ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "" as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // A feed is stale the moment someone comments; refetch when the tab
    // comes back rather than on a timer nobody asked for.
    refetchOnWindowFocus: true,
  });

  const rows = feed.data?.pages.flatMap((p) => p.data) ?? [];
  const days: { day: string; rows: ActivityRow[] }[] = [];
  for (const r of rows) {
    const day = dayOf(r.updatedAt);
    const last = days[days.length - 1];
    if (last?.day === day) last.rows.push(r);
    else days.push({ day, rows: [r] });
  }

  return (
    <div className="flex flex-col gap-5 p-7">
      <PageHeader title="Activity" sub={`Every site, newest first${site ? "" : " — all of them"}`} />

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button key={f.value} size="sm" variant={status === f.value ? "default" : "outline"} onClick={() => go({ status: f.value })}>
            {f.label}
          </Button>
        ))}
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          Site
          <select
            aria-label="Site"
            value={site ?? ""}
            onChange={(e) => go({ site: e.target.value || undefined })}
            className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] text-foreground"
          >
            <option value="">All sites</option>
            {me.projects.map((p) => (
              <option key={p.uid} value={p.uid}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {feed.isPending && <RowsPending rows={4} />}
      {feed.isError && <p className="m-0 text-[13px] text-destructive">Could not read the feed. Reload to try again.</p>}
      {feed.isSuccess && rows.length === 0 && (
        <p className="m-0 text-[13px] text-muted-foreground">
          {status === "resolved"
            ? "Nothing has been resolved yet — this is where finished comments go."
            : status === "unresolved"
              ? "Nothing needs attention. Every comment on every site is resolved."
              : "No comments yet on any site."}
        </p>
      )}

      {days.map(({ day, rows: ofDay }) => (
        <section key={day} className="flex flex-col gap-2">
          <h2 className="m-0 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{day}</h2>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {ofDay.map((r) => (
              <li key={r.id}>
                <Link
                  to="/s/$site/comments"
                  params={{ site: r.site.uid }}
                  search={{ thread: r.key }}
                  className="flex flex-col gap-1 rounded-md border border-border px-3 py-2.5 no-underline transition-colors hover:bg-muted/60"
                >
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                    <StatusPill status={r.status} />
                    <span className="font-medium text-foreground">{r.site.name}</span>
                    <code className="font-mono text-[12px] text-muted-foreground">{r.route}</code>
                    <span className="flex-1" />
                    <span className="text-[12px] text-muted-foreground">{ago(r.updatedAt)}</span>
                  </span>
                  {r.latest?.body && (
                    <span className="line-clamp-2 text-[13px] text-foreground">
                      <span className="text-muted-foreground">{r.latest.author ?? r.createdBy.name}: </span>
                      {r.latest.body}
                    </span>
                  )}
                  <span className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
                    <span className="font-mono">{r.key}</span>
                    <span>·</span>
                    <span>
                      {r.commentCount} {r.commentCount === 1 ? "comment" : "comments"}
                    </span>
                    {r.assignee && (
                      <>
                        <span>·</span>
                        <span>{r.assignee}</span>
                      </>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {feed.hasNextPage && (
        <div>
          <Button variant="outline" size="sm" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
            {feed.isFetchingNextPage ? "Reading…" : "Show older"}
          </Button>
        </div>
      )}
    </div>
  );
}

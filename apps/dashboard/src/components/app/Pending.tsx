import { LoaderCircleIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * What a page looks like while its data is on the way: the router's default
 * pending screen inside the app shell. Before this, a slow loader left the
 * content area blank beside a live sidebar — on a database a continent away
 * that blank lasts seconds and reads as broken. The shape is every page's
 * own: a header line, then rows, at the padding pages use.
 */
export function PagePending() {
  return (
    <div className="flex flex-col gap-5 p-7" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <div className="flex items-center gap-3">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-24" />
      </div>
      <RowsPending rows={4} />
    </div>
  );
}

/**
 * Rows standing in for a list that is still being read — where a page said
 * "Reading…" in grey. Widths vary so it reads as content, not as a stripe.
 */
export function RowsPending({ rows = 3, className }: { rows?: number; className?: string }) {
  const widths = [72, 54, 64, 46, 58];
  return (
    <div className={cn("flex flex-col gap-1.5", className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-3 rounded-md border border-border px-3">
          <Skeleton className="h-3" style={{ width: `${widths[i % widths.length]}%` }} />
          <div className="flex-1" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/** The spinner the buttons already use, for a status written as a line of text. */
export function Spinner({ className }: { className?: string }) {
  return <LoaderCircleIcon className={cn("size-4 shrink-0 animate-spin", className)} aria-hidden="true" />;
}

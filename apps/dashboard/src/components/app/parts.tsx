import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { STATUS_COLOR, STATUS_LABEL, isStatus } from "@/lib/labels";

/**
 * The vocabulary every screen is composed from: a page
 * header, the settings row, the empty state, the status pill. One file,
 * because their sameness across screens is the whole point of the rebuild.
 */

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <h1 className="m-0 text-xl font-semibold tracking-tight">{title}</h1>
      {sub && <p className="m-0 text-muted-foreground">{sub}</p>}
      <div className="flex-1" />
      {actions}
    </div>
  );
}

/** Title and description on the left, the card on the right. */
export function SettingsRow({
  title,
  description,
  children,
  danger,
  cardClassName,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  danger?: boolean;
  cardClassName?: string;
}) {
  return (
    <section className="grid max-w-[1040px] grid-cols-1 gap-4 lg:grid-cols-[minmax(220px,1fr)_2fr] lg:gap-8">
      <div>
        <h2 className={cn("m-0 mb-1.5 text-[15.5px] font-semibold tracking-tight", danger && "text-destructive")}>{title}</h2>
        {description && <p className="m-0 text-[13px] leading-normal text-muted-foreground">{description}</p>}
      </div>
      <Card className={cn("flex max-w-[640px] flex-col gap-4 p-5", danger && "border-destructive", cardClassName)}>
        {children}
      </Card>
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-6 py-16 text-center", className)}>
      {icon && (
        <div className="mb-1.5 flex size-11 items-center justify-center rounded-[10px] bg-muted text-ink-soft">{icon}</div>
      )}
      <h3 className="m-0 text-[15px] font-semibold">{title}</h3>
      {children && <div className="m-0 max-w-[360px] text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Status as TEXT — an outlined pill in the status's own hue. */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const known = isStatus(status);
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium leading-none",
        known ? STATUS_COLOR[status] : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {known ? STATUS_LABEL[status] : status}
    </span>
  );
}

/** A section's small uppercase title inside a brief or a card. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

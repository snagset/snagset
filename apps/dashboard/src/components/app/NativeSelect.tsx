import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** The platform's select in the kit's clothes — for the short lists where a menu would be ceremony. */
export function NativeSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-8 rounded-md border border-input bg-card px-2.5 text-[13.5px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

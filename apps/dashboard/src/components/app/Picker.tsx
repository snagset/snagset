import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * The menu picker the rest of the dashboard uses, for a value chosen from a
 * short list — sites, expiry. An empty string is a real choice here ("All
 * sites", "Never"), so it is carried as a sentinel the menu can hold.
 */
const EMPTY = "__none__";

export function Picker({
  id,
  value,
  onChange,
  options,
  className,
  size = "default",
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  size?: "sm" | "default";
  "aria-label"?: string;
}) {
  const items = options.map((o) => ({ value: o.value === "" ? EMPTY : o.value, label: o.label }));
  return (
    <Select items={items} value={value === "" ? EMPTY : value} onValueChange={(v) => v != null && onChange(v === EMPTY ? "" : String(v))}>
      <SelectTrigger id={id} size={size} aria-label={ariaLabel} className={cn("w-full bg-card", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

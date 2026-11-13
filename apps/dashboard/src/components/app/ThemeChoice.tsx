import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { readTheme, setTheme, type Theme } from "@/lib/theme";

/** System / Light / Dark as a chip row — the You screen's version of the menu's radio. */
export function ThemeChoice({ items }: { items: { value: Theme; label: string; icon: ReactNode }[] }) {
  const [theme, set] = useState<Theme>(readTheme);
  return (
    <div className="flex gap-2" role="radiogroup" aria-label="Theme">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="radio"
          aria-checked={theme === it.value}
          onClick={() => {
            setTheme(it.value);
            set(it.value);
          }}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12.5px] font-medium text-ink-soft",
            theme === it.value && "border-line-strong bg-muted text-foreground",
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

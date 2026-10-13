import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useEffect, useState } from "react";
import { readTheme, resolveTheme } from "@/lib/theme";

/**
 * Toasts follow the page's resolved theme — lib/theme.ts, not next-themes,
 * which shadcn's copy of this file assumed. Success and optimistic rollback
 * only; errors stay in the form.
 */
export function Toaster(props: ToasterProps) {
  const [theme, setTheme] = useState<"light" | "dark">(() => resolveTheme(readTheme()));
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setTheme(el.classList.contains("dark") ? "dark" : "light");
    const mo = new MutationObserver(sync);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="bottom-right"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

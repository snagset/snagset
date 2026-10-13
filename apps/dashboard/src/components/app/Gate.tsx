import type { ReactNode } from "react";
import { Mark } from "./Mark";

/**
 * The chrome the entry screens share — the mark and the name in the corner,
 * one centred column, no card: the page is the form. Sign-in, the claim and
 * the waiting ladder all sit in it, so a browser arriving from any of the
 * three outcomes paints the same frame first.
 */
export function Gate({ children, width = 360 }: { children: ReactNode; width?: number }) {
  return (
    <div className="relative min-h-dvh bg-background">
      <div className="absolute left-6 top-5 flex items-center gap-2 text-sm font-semibold" aria-hidden="true">
        <Mark size={18} />
        <span>Snagset</span>
      </div>
      <div className="flex min-h-dvh items-center justify-center px-6 py-20">
        <div className="w-full" style={{ maxWidth: width }}>
          {children}
        </div>
      </div>
    </div>
  );
}

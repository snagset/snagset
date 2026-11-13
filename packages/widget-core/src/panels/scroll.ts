import type { Snag } from "../storage/types.ts";

/**
 * Scrolling a comment into view, around the dock (DESIGN.md Q6).
 *
 * In the PANELS chunk, not the runtime, for a reason that is not only budget:
 * the geometry it computes is the dock's own box, so it is dock behaviour that
 * happens to move the page. Every call site has the chunk loaded anyway — a
 * scroll is only ever triggered by a row in the dock, or by the handoff, which
 * awaits the dock before it scrolls.
 */

/**
 * How close to the strip's edge a pin may sit and still count as "you are
 * already looking at it". Without a margin, a pin one pixel inside the fold
 * counts as visible and the page stays put with the thing you asked for pressed
 * against the bottom edge.
 */
const MARGIN = 24;

export interface Strip {
  top: number;
  bottom: number;
}

/**
 * The **visible strip** — the viewport minus the dock.
 *
 * Measured off the dock itself rather than assumed from a breakpoint, because
 * the dock is two different shapes: a full-height right rail on desktop, which
 * costs width and no height, and a 72 vh bottom sheet on a coarse pointer,
 * which costs the bottom three-quarters of the screen. Centring a pin in the
 * viewport on mobile puts it underneath the sheet that was asking about it.
 */
export function visibleStrip(win: Window, root: ShadowRoot): Strip {
  const h = win.innerHeight;
  const dock = root.querySelector(".snag-dk") as HTMLElement | null;
  if (!dock) return { top: 0, bottom: h };
  const r = dock.getBoundingClientRect();
  // A rail spans the full height, so it narrows nothing vertically.
  if (r.height >= h - 1) return { top: 0, bottom: h };
  return { top: 0, bottom: Math.max(0, r.top) };
}

/**
 * Scroll a snag into the visible strip — but only if it is not already there.
 *
 * The two load-bearing rules: opening a detail from the LIST or the
 * walker scrolls only when the pin is outside the strip, centred in what the
 * reviewer can actually see; opening one from a PIN never scrolls, because they
 * are demonstrably already looking at it. Smooth, and instant under reduced
 * motion.
 *
 * Aimed at the PIN's point rather than the element's box: a full-bleed hero is
 * never fully inside any strip, so centring its box would scroll the page every
 * single time. The point is what the reviewer is hunting for anyway.
 */
export function scrollToSnag(win: Window, root: ShadowRoot, snag: Snag): void {
  const r = snag.anchor.rect;
  if (!r) return; // an orphan with no fallback point — nothing to aim at
  const o = snag.anchor.offset ?? { fx: 0.5, fy: 0.5 };
  const docY = r.y + r.h * o.fy; // document coords, exactly where the pin draws

  const strip = visibleStrip(win, root);
  const y = docY - win.scrollY;
  if (y >= strip.top + MARGIN && y <= strip.bottom - MARGIN) return;

  const reduce = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  win.scrollTo({
    top: Math.max(0, docY - (strip.top + strip.bottom) / 2),
    behavior: reduce ? "auto" : "smooth",
  });
}

import { widgetAttr } from "@snagset/types/names";
import { isRendered } from "../anchor/geometry.ts";

/**
 * The widen/narrow primitive — ONE operation with three faces (14):
 * `[` / `]` on the keyboard, ▲/▼ in the composer sheet's header
 * ("the pointer equivalent from v0.1"), and the virtual
 * cursor. Shared here so the three can never disagree about what "parent"
 * means.
 *
 * Eligibility is the pin's own rule: rendered (the predicate — the
 * same one that decides placement) and never our own UI. Widening stops at
 * `<body>`: a pin on the whole page is a pin on nothing.
 */
const OURS = `[${widgetAttr("root")}]`;

export function widen(el: Element): Element | null {
  const p = el.parentElement;
  if (!p || p === el.ownerDocument.body || p === el.ownerDocument.documentElement) return null;
  if (p.closest(OURS)) return null;
  return p;
}

export function narrow(el: Element): Element | null {
  for (const c of el.children) {
    if (c.closest(OURS)) continue;
    if (!isRendered(c)) continue;
    return c;
  }
  return null;
}

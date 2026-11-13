import { adopt, LAYER, t } from "../runtime/theme.ts";
import { format } from "../strings/capture.ts";
import { rectOf } from "../anchor/geometry.ts";
import { createCursor } from "./cursor.ts";
import { accessibleNameOf } from "../anchor/record.ts";

/**
 * Add mode's redundant signals: the hover highlight, its label chip,
 * and the hint pill.
 *
 * IN THE CAPTURE CHUNK, not the eager runtime, for the same reason
 * `createElementAnchor` is: this is creation-side. F-04 says that with
 * the panels chunk blocked the `+` control is DISABLED — "arming a picker that
 * cannot open a composer is a trap" — so add mode is unreachable unless a
 * composer is coming, and a reviewer who activates only to read a round never
 * needs a pixel of it. Entering `add` already preloads this chunk, so the
 * chrome arrives with the mode rather than after it.
 *
 * They live in ONE module because the design requires that leaving `add` tears
 * down the shield, the highlight and the hint **in the same task** — three
 * modules with three teardowns is how one of them survives a mode change and
 * leaves a dead outline on the page (counts nodes for exactly this).
 *
 * The highlight is a box of OUR OWN, absolutely positioned over the element's
 * rect. A3 forbids adding a class, an attribute or a style to a host element —
 * not even transiently, not even to measure. The scrim is painted by the same
 * box's outward `box-shadow`, so the candidate reads as lifted out of a dimmed
 * page rather than merely outlined, and it costs one node rather than four.
 */

const CSS = `
.snag-hl-layer{position:fixed;inset:0;pointer-events:none;z-index:${LAYER.highlight};
  contain:layout style;overflow:hidden}
.snag-hl{position:absolute;box-sizing:border-box;border:2px solid ${t.accent};
  border-radius:3px;background:color-mix(in srgb, ${t.accent} 12%, transparent);
  /* The 4% page scrim, painted OUTWARDS from the candidate — one node, and the
     hole is always exactly the element. */
  box-shadow:0 0 0 100vmax color-mix(in srgb, #000 4%, transparent);
  transition:top ${t.motion},left ${t.motion},width ${t.motion},height ${t.motion}}
.snag-hl-chip{position:absolute;background:${t.accent};color:${t.onAccent};
  font:600 11px/1.5 ${t.font};padding:2px 7px;border-radius:4px;white-space:nowrap;
  max-width:min(48ch,90vw);overflow:hidden;text-overflow:ellipsis}
.snag-hint{position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;
  transform:translateX(-50%);z-index:${LAYER.chip};pointer-events:none;
  background:${t.bg};color:${t.fg};border:1px solid ${t.border};box-shadow:${t.shadow};
  border-radius:999px;padding:7px 14px;font:500 12px/1 ${t.font};white-space:nowrap;
  max-width:calc(100vw - 24px);overflow:hidden;text-overflow:ellipsis}
`;

export interface AddChrome {
  /** Draw over an element. Rect comes from the helper — never a second read. */
  show(el: Element): void;
  /** Clear the outline without tearing the layer down (pointer left the page). */
  clear(): void;
  /** Enter or leave add mode: shows the hint, and clears on the way out. */
  setActive(on: boolean): void;
  destroy(): void;
}

export function createAddChrome(
  root: ShadowRoot,
  coarse: boolean,
  /** The virtual cursor rides WITH the chrome it draws through, so
   *  `setActive` drives both and the runtime keeps no second handle. */
  cursorDeps?: Omit<import("./cursor.ts").CursorDeps, "show">,
): AddChrome {
  const doc = root.ownerDocument ?? document;
  adopt(root, "highlight", CSS);

  const layer = doc.createElement("div");
  layer.className = "snag-hl-layer";
  layer.hidden = true;

  const box = doc.createElement("div");
  box.className = "snag-hl";
  const chip = doc.createElement("div");
  chip.className = "snag-hl-chip";
  layer.append(box, chip);

  // `role="status"` and pointer-events:none. It also carries
  // the polite announcement for signal 5, so entering add mode is spoken once
  // rather than on every hover.
  const hint = doc.createElement("div");
  hint.className = "snag-hint";
  hint.setAttribute("role", "status");
  hint.hidden = true;
  hint.textContent = format(coarse ? "hint.coarse" : "hint.fine");

  // NOT appended here. `setActive` owns attachment, so a chrome built while the
  // reviewer is already in `comments` — which happens now that this module
  // arrives with the capture chunk — does not put two nodes into the page for a
  // mode it is not in.

  let flash: ReturnType<typeof setTimeout> | undefined;

  function show(el: Element): void {
    const r = rectOf(el);
    if (r.width <= 0 && r.height <= 0) return clear();

    layer.hidden = false;
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;

    const name = accessibleNameOf(el);
    const tag = el.tagName.toLowerCase();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    chip.textContent = name
      ? format("highlight.chip", { tag, name, w, h })
      : format("highlight.chip.unnamed", { tag, w, h });

    // Above the box, flipped below when there is no room — the same rule the
    // composer uses, for the same reason.
    const above = r.top >= 22;
    chip.style.top = above ? `${r.top - 20}px` : `${r.bottom + 4}px`;
    chip.style.left = `${Math.max(2, r.left)}px`;

    // Coarse pointers have no hover, so the highlight is a 400 ms confirmation
    // flash on touch instead.
    if (coarse) {
      clearTimeout(flash);
      flash = setTimeout(clear, 400);
    }
  }

  function clear(): void {
    layer.hidden = true;
  }

  // The keyboard's equivalent of pointing. Built lazily on first
  // activation so a pointer-only session never pays for it.
  let cursor: import("./cursor.ts").VirtualCursor | null = null;

  return {
    show,
    clear,
    setActive(on: boolean): void {
      if (cursorDeps) {
        cursor ??= createCursor(root, { ...cursorDeps, show });
        if (on) cursor.engage();
        else cursor.release();
      }
      // Same rule as the shield: the hint and the highlight layer are
      // attached for `add` and detached for everything else, rather than left
      // in the tree with `hidden` on them. `clear()` first, so the outline goes
      // in the SAME task the mode changes in rather than surviving as
      // a detached node holding a stale rect.
      if (!on) clear();
      if (on) {
        root.append(layer, hint);
      } else {
        layer.remove();
        hint.remove();
      }
      hint.hidden = !on;
    },
    destroy(): void {
      clearTimeout(flash);
      cursor?.destroy();
      layer.remove();
      hint.remove();
    },
  };
}

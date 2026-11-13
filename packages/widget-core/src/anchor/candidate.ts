import { rectOf } from "./geometry.ts";

/**
 * Which element a pointer at (x, y) is actually offering to pin.
 *
 * The topmost hit is usually the wrong answer. Point at a button's label and
 * `elementFromPoint` hands back the `<span>` inside it — so the highlight
 * outlines two words, and the anchor records a wrapper the next deploy will
 * delete while the button survives. The UX contract is:
 *
 *   (a) the DEEPEST element with a box of at least 8 × 8 px,
 *   (b) that is not a bare inline formatting wrapper with no distinct box,
 *   (c) unless an interactive ancestor sits within 3 levels — then that one.
 *
 * (c) exists because a reviewer pointing anywhere inside a button means the
 * button. It is capped at 3 levels so that pointing at a paragraph deep inside
 * a giant wrapping `<a>` does not silently offer the whole card.
 */

/** What counts as an affordance a reviewer means to point at. */
const INTERACTIVE =
  "button,a[href],[role=button],[role=link],[role=tab],[role=menuitem],label,input,select,textarea,summary";

/** Levels of ancestry (c) is allowed to climb. */
const INTERACTIVE_REACH = 3;

const MIN_BOX = 8;

/**
 * REPLACED ELEMENTS ARE `display: inline` AND HAVE A BOX ANYWAY.
 *
 * The UA stylesheet gives `<canvas>`, `<img>`, `<svg>`, `<iframe>` and `<video>`
 * `display: inline`, and every one of them has intrinsic dimensions — the rule
 * below was written about NON-replaced inlines and caught these by accident.
 *
 * The cost was total: a click on the canvas escalated past it to the 1032×329
 * card that contained it, so the thing under the crosshair could not be pinned
 * at all. `<img>` had the same defect and it is the far more common case — it
 * went unnoticed only because most design systems ship `img{display:block}` in
 * their reset, so the bug needed a page that does not. Found by pointing at a
 * canvas on /lab/overlays and being handed the whole card.
 *
 * The design is explicit that these are terminal: *"`<canvas>`, `<video>`, `<img>`:
 * hit test returns the element itself; there is no sub-element structure. The
 * pin anchors to the element with a fractional `offset`, which is exactly right
 * for 'the button in this hero image is misaligned'."*
 *
 * Form controls are in the list for completeness rather than need — most UAs
 * make them `inline-block`, but that is a UA convention and not a guarantee,
 * and a `<select>` that escalated to its form would be the same bug wearing a
 * different tag.
 */
const REPLACED = new Set([
  "img", "picture", "canvas", "video", "audio", "iframe", "embed", "object",
  "svg", "math", "input", "select", "textarea", "button", "progress", "meter",
]);

/**
 * A bare inline wrapper — `<span>`, `<em>` — has no box of its own to outline:
 * its rect is whatever the text happens to occupy, and it fragments across line
 * breaks. `inline-block`, `inline-flex` and `inline-grid` DO have a distinct
 * box and are deliberately not excluded.
 */
function isBareInline(el: Element, win: Window): boolean {
  // `tagName` is lower-case for HTML and case-exact for SVG/MathML, where the
  // names we care about ("svg", "math") are already lower-case.
  if (REPLACED.has(el.tagName.toLowerCase())) return false;
  return win.getComputedStyle(el).display === "inline";
}

export function candidateFor(hit: Element): Element {
  const win = hit.ownerDocument?.defaultView;
  if (!win) return hit;

  // (a) + (b): climb until the box is real.
  let base: Element = hit;
  for (let el: Element | null = hit; el; el = el.parentElement) {
    const r = rectOf(el);
    if (r.width >= MIN_BOX && r.height >= MIN_BOX && !isBareInline(el, win)) {
      base = el;
      break;
    }
    base = el; // nothing qualified yet — keep the deepest seen as the fallback
  }

  // (c): an interactive ancestor within reach wins, because that is the thing
  // the reviewer means. Checked from `base` so the reach is measured from the
  // element we would otherwise have offered.
  let level = 0;
  for (let el: Element | null = base; el && level <= INTERACTIVE_REACH; el = el.parentElement) {
    if (el.matches(INTERACTIVE)) return el;
    level++;
  }
  return base;
}

/**
 * The one place an element's box is measured (the geometry helper).
 *
 * *"the geometry helper is the, and this spec does not name a
 * DOM method. A highlight drawn from a different call than the anchor is placed
 * from is a highlight that lies."* Two callers measuring independently is how
 * you get a highlight that sits 1px off the pin it promised, on the one page
 * where a sticky header shifts between the two reads.
 *
 * A3 applies here more than anywhere: measuring must never mutate a host
 * element. No `scrollIntoView`, no forced style, no temporary class — the rect
 * is read and nothing else.
 */

/** Viewport-relative box. The single measurement call in the codebase. */
export function rectOf(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

export interface DocRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Document-relative box — what an anchor stores and what the document-coordinate
 * pin layer draws from, so pins survive scrolling with zero JavaScript.
 */
export function docRectOf(el: Element, win: Window | null | undefined): DocRect {
  const r = rectOf(el);
  return {
    x: r.left + (win?.scrollX ?? 0),
    y: r.top + (win?.scrollY ?? 0),
    w: r.width,
    h: r.height,
  };
}

/**
 * Does this element render at all?
 *
 * `display:none`, a collapsed ancestor and an empty inline all measure 0×0.
 * Used by the cascade to cap a resolution's confidence, and by the candidate
 * heuristic to skip boxes nobody can point at.
 */
export function isRendered(el: Element): boolean {
  // The behavioural requirement on THIS predicate ("the same
  // predicate must decide 'is this anchor resolvable' and 'should this pin
  // be placed'", so the additions land here and never as a second check in
  // pins.ts or the dock): an `[inert]` or `aria-hidden="true"` subtree is
  // hidden even though checkVisibility answers for neither — inert content
  // is laid out and painted, and aria-hidden is a pure semantics veil, but
  // both mean "this is not part of the page right now" (a closed drawer, an
  // off-screen wizard step), and a pin on either points at something the
  // reviewer cannot reach.
  if (el.closest('[inert],[aria-hidden="true"]')) return false;
  // `checkVisibility` FIRST, because a rect is not enough. Content inside a
  // closed `<details>` gets `content-visibility: hidden`, which keeps the box —
  // the element still measures 152×41 while being completely unpainted — so the
  // rect test says "rendered" and a pin gets drawn on top of the collapsed
  // section, over whatever is there instead. Found by dogfooding a page with a
  // `<details>` on it.
  //
  // `contentVisibilityAuto: true` is what makes it answer for that case;
  // `opacityProperty: false` because opacity:0 is still laid out and a reviewer
  // pointing at a fading element means it; `visibilityProperty: true` because
  // `visibility: hidden` is not.
  //
  // The design requires the geometry fallback below for Safari 16.4–17.3, which
  // is inside the support floor and does not have the method.
  const check = (el as Element & {
    checkVisibility?: (o: {
      contentVisibilityAuto?: boolean;
      opacityProperty?: boolean;
      visibilityProperty?: boolean;
    }) => boolean;
  }).checkVisibility;
  if (typeof check === "function") {
    return check.call(el, {
      contentVisibilityAuto: true,
      opacityProperty: false,
      visibilityProperty: true,
    });
  }
  /**
   * The Safari 16.4–17.3 fallback, and it must answer the SAME QUESTION as the
   * branch above it — prints it in full:
   *
   *   (r.width !== 0 || r.height !== 0 || el.getClientRects().length !== 0)
   *   && getComputedStyle(el).visibility !== 'hidden'
   *
   * This was `r.width > 0 || r.height > 0` and dropped both of the other
   * clauses. The visibility one is the serious omission: the modern branch
   * passes `visibilityProperty: true` precisely so that `visibility: hidden`
   * counts as not-rendered, so on the two Safari versions inside the
   * support floor the widget answered a materially different question from
   * every other engine. A tabbed panel or an off-canvas menu that hides its
   * inactive pane with `visibility: hidden` — the standard technique when a CSS
   * transition has to run — kept full-size boxes, so its pins stayed drawn over
   * whatever replaced them, on Safari alone.
   *
   * `getClientRects().length` catches the inline element whose bounding box
   * collapses to zero because its content wrapped across a line break, which is
   * a real rendered element with a real position.
   */
  const r = rectOf(el);
  const boxed = r.width > 0 || r.height > 0 || el.getClientRects().length > 0;
  if (!boxed) return false;
  const win = el.ownerDocument?.defaultView;
  // No view means a detached document — nothing is rendered there, but the box
  // test above is the honest answer we have, so keep it rather than guess.
  return win ? win.getComputedStyle(el).visibility !== "hidden" : true;
}

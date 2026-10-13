import { CSS_VAR } from "@snagset/types/names";
import { count, format } from "../strings/runtime.ts";
import { adopt, LAYER, t } from "./theme.ts";
import type { PointerMode } from "./pointer.ts";

/**
 * The toolbar IS the resting surface — there is no launcher dot
 * Draft 4's sleeping dot expanded into a toolbar, which made the
 * resting affordance and the working affordance two different objects in two
 * different places. The prototype collapsed them: `browse` is what "asleep"
 * looks like — a page with no markup on it and a small pill in the corner.
 *
 * Vanilla, and it lives in `snag.runtime.js` rather than the Preact panels
 * chunk, because it must be on screen BEFORE that chunk exists. A toolbar that
 * waits for a second fetch shows an activated widget with nothing in it.
 *
 * Deliberately absent: any wordmark, logo or brand glyph. The design makes
 * the product name swappable; a mark baked into the chrome would turn a rename
 * into a design job. The accessible name carries the product; the pixels do not.
 */

export interface Toolbar {
  readonly el: HTMLElement;
  setState(state: PointerMode): void;
  /** `null` means there is no count to show at all — F-01, not "zero". */
  setCount(n: number | null): void;
  /**
   * The comment UI is not coming (F-04). The `+` is DISABLED — not
   * hidden: a control that vanishes reads as "I imagined it", while a disabled
   * one with an explanation reads as "not now, and here is why". It keeps its
   * accessible name either way.
   */
  setDegraded(on: boolean): void;
  /** ≥1.2× pinch collapses the bar to one 44 px puck. */
  setPuck(on: boolean): void;
  /** Hidden while a sheet's scrim is up — and the height
   *  var republishes as 0 so the sheets drop flush to the safe area. */
  setConcealed(on: boolean): void;
  /**
   * F-12 — unsent words are waiting somewhere in the round.
   *
   * On the `+` and not in a toast, because a toast is gone by the time it would
   * matter: the reviewer who needs to know is the one arriving on the page an
   * hour later wondering whether they finished that sentence. It belongs to the
   * control that reopens it, and it is the only thing on the toolbar that
   * refers to a state on ANOTHER page.
   *
   * The decision made it the accessible NAME and nothing else. The spec used to ask for
   * a small pencil badge as well; a second glyph on the corner of the `+` made
   * a one-verb control look like two.
   */
  setDraft(on: boolean): void;
  destroy(): void;
}

export interface ToolbarOptions {
  onState(state: PointerMode): void;
  onPanel(): void;
  /** The ◻/T sub-segment, and the `t` key that mirrors it. */
  /** The ▲▼ navigator — same handler as the n/p keys. */
  onNav?(dir: 1 | -1): void;
  coarsePointer?: boolean;
  /** The chrome layer the toolbar mounts into. */
  parent?: Element;
}

// Inline SVG, never an icon font: a font is a network request, a FOUT
// and a a11y hazard for two glyphs.
/**
 * THE ICONS ARE BUILT, NOT PARSED — and this is not a style preference.
 *
 * They were three SVG strings assigned through `element.innerHTML`, which is a
 * Trusted Types injection sink: under `require-trusted-types-for 'script'` the
 * assignment throws a TypeError, and it throws while the toolbar is being
 * constructed — so a client with that header got no toolbar at all rather than
 * a toolbar with no icons. Reserves a strict-CSP route precisely
 * because that policy is one we intend to survive.
 *
 * This task definition of done already said the build must fail on `.innerHTML =`
 * in `dist/*.js`. It never checked, so this shipped. Both halves are fixed
 * together: the construct is gone from here and `verify-dist` now looks for it.
 *
 * The panels chunk reached the same conclusion by a different route — it emits
 * Preact `h()` nodes, so there is no HTML string and therefore no sanitiser to
 * get wrong. This is the vanilla equivalent of that argument.
 */
const SVG_NS = "http://www.w3.org/2000/svg";

type Attrs = Record<string, string>;

function svg(doc: Document, tag: string, attrs: Attrs, kids: SVGElement[] = []): SVGElement {
  const el = doc.createElementNS(SVG_NS, tag) as SVGElement;
  for (const k in attrs) el.setAttribute(k, attrs[k]!);
  for (const kid of kids) el.appendChild(kid);
  return el;
}

/** A 16×16 icon frame — the three attributes every one of ours shares. */
const frame = (doc: Document, w = "16", h = "16", box = "0 0 16 16"): Attrs => ({
  width: w,
  height: h,
  viewBox: box,
  fill: "none",
  "aria-hidden": "true",
});

const iconPlus = (doc: Document): SVGElement =>
  svg(doc, "svg", frame(doc), [
    svg(doc, "path", {
      d: "M8 3v10M3 8h10",
      stroke: "currentColor",
      "stroke-width": "1.75",
      "stroke-linecap": "round",
    }),
  ]);

const iconPanel = (doc: Document): SVGElement =>
  svg(doc, "svg", frame(doc), [
    svg(doc, "rect", {
      x: "2.25", y: "3.25", width: "11.5", height: "9.5", rx: "1.75",
      stroke: "currentColor", "stroke-width": "1.5",
    }),
    svg(doc, "path", { d: "M9.5 3.5v9", stroke: "currentColor", "stroke-width": "1.5" }),
  ]);

const iconGrip = (doc: Document): SVGElement =>
  svg(doc, "svg", { ...frame(doc, "10", "16", "0 0 10 16"), fill: "currentColor" }, [
    svg(
      doc,
      "g",
      { fill: "currentColor" },
      [4, 8, 12].flatMap((cy) =>
        [3, 7].map((cx) => svg(doc, "circle", { cx: String(cx), cy: String(cy), r: "1" })),
      ),
    ),
  ]);

// `:host{all:initial}` is deliberately NOT here — theme.ts owns it as its own
// first rule. A second `all:initial` in a sheet installed after the token block
// would reset every custom property the tokens define, which is precisely the
// trap documents. theme.test.ts asserts no component sheet declares it.
const CSS = `
.snag-tb{position:fixed;z-index:${LAYER.toolbar};display:flex;align-items:center;gap:2px;
  padding:4px;border-radius:calc(${t.radius} + 4px);background:${t.bg};color:${t.fg};
  box-shadow:${t.shadow};font:500 13px/1 ${t.font};
  pointer-events:auto;user-select:none;border:1px solid ${t.border}}
/* --snag-dock-w is published by the dock while it is open. Without it the
   toolbar's default corner is underneath the dock, floating over the export
   buttons — invisible to every DOM assertion and obvious on a screenshot. */
/* inset-inline-end, so the toolbar follows the dock to the other side under RTL
   rather than colliding with it. The safe-area term stays PHYSICAL
   because CSS has no logical safe-area env(); on a notched device in RTL that
   costs a few px of inset on the wrong edge, which is the whole of the residue
   and is worth naming rather than pretending away. */
/* Transitioned, because this value changes when the dock opens and the
   toolbar steps aside for it. Untransitioned it jumped, which is the
   "clicking browse to comments is not smooth" from the dogfood: the button
   state animated and the whole bar did not.

   No media query here: --snag-motion is already 0ms under
   prefers-reduced-motion (theme.ts), and the repo's rule -- with a test
   behind it -- is that reduced motion is carried by that ONE token rather
   than by per-component queries that drift apart. */
.snag-tb{transition:inset-inline-end ${t.motion}}
.snag-tb--fine{inset-inline-end:calc(20px + env(safe-area-inset-right) + var(${CSS_VAR.dockW},0px));
  inset-block-end:calc(20px + env(safe-area-inset-bottom));transition:inset-inline-end ${t.motion}}
.snag-tb--coarse{inset-inline:0;inset-block-end:0;border-radius:14px 14px 0 0;padding:6px 10px calc(6px + env(safe-area-inset-bottom));
  justify-content:center;gap:4px;flex-direction:column}
.snag-grabber{width:36px;height:4px;border-radius:2px;background:${t.muted};margin:2px auto 6px}
.snag-row{display:flex;align-items:center;gap:2px}
.snag-grip{display:flex;align-items:center;padding:0 4px;color:${t.muted};cursor:grab;touch-action:none}
.snag-grip:active{cursor:grabbing}
/* A TOGGLE, not two buttons that happen to touch (dogfood round 2: "perhaps
   slides so its more like a toggle the browse/comments"). The pressed state
   used to be a background on whichever button carried aria-pressed, so the
   highlight teleported between them. It is now ONE element that moves.

   THE THUMB IS MEASURED, and the two cheaper routes were tried and rejected
   against a live page rather than in the head:

     - width:50% on equal halves needs equal halves, and it does not get them.
       grid-auto-columns:1fr AND grid-template-columns:1fr 1fr both size their
       tracks to each cell's own content in an intrinsically-sized container:
       measured 67.5px / 88.9px for Browse / Comments, so a half-width thumb
       lands off the button either way.
     - offsetLeft arithmetic is wrong the moment the segment is positioned:
       the button's offsetLeft is measured from the segment, the segment's from
       the row, and subtracting them put the thumb 22px outside the segment.

   So: bounding rects, and the offset is INLINE-START rather than left, because
   inset-inline-start flips with the writing mode and a distance measured from
   the left would land on the wrong button in RTL. */
.snag-seg{display:flex;background:${t.surface};border-radius:${t.radius};padding:2px;position:relative}
.snag-seg::before{content:"";position:absolute;inset-block:2px;
  inset-inline-start:var(${CSS_VAR.thumbX},0);width:var(${CSS_VAR.thumbW},0);
  background:${t.accent};border-radius:calc(${t.radius} - 2px);pointer-events:none;
  transition:inset-inline-start ${t.motion}, width ${t.motion}}
/* The thumb IS the pressed background now, so the button must not paint its
   own -- two of them would show during the slide. The colour still flips,
   because that is the part the thumb cannot do. */
.snag-seg>.snag-b[aria-pressed="true"]{background:transparent;color:${t.onAccent}}
/* Above the thumb. The buttons are already position:relative for the draft
   mark; this is the z-index that goes with it. */
.snag-seg>.snag-b{z-index:1}
/* No reduced-motion media query here: --snag-motion IS the reduced-motion
   token (theme.ts), so a transition written against it is already honest under
   the preference, and a second mechanism would be a second thing to get wrong.
   The theme test asserts this repo-wide. */
.snag-b{appearance:none;border:0;background:transparent;color:inherit;font:inherit;
  padding:6px 11px;border-radius:calc(${t.radius} - 2px);cursor:pointer;display:flex;align-items:center;gap:6px;
  /* Positioned, for the draft mark that sits absolutely inside it. */
  position:relative;min-height:32px;transition:background ${t.motion}}
/* Tinted with the button's OWN text colour over whatever is beneath it, not
   with the global --snag-hover token. That token is mixed from the page
   background, and these buttons sit on the surface token -- which is lighter
   than the background in dark mode, so hovering made a button DARKER than its
   own container. Reported from the dogfood as "the hover on comments and
   browse is too dark", and it was. currentColor over transparent is
   container-independent: it lightens on a dark ground and darkens on a light
   one, without needing to know which. */
.snag-b:hover:not(:disabled){background:color-mix(in srgb, currentColor 12%, transparent)}
/* Disabled, not hidden (F-04) — still there, still named, visibly not
   available. A control that vanishes reads as "I imagined it". */
.snag-b:disabled{opacity:.4;cursor:not-allowed}
.snag-b[aria-pressed="true"]{background:${t.accent};color:${t.onAccent}}
.snag-b:focus-visible{outline:2px solid ${t.focus};outline-offset:2px}
.snag-icon{padding:6px 9px}
/* 44 × 44 ON A COARSE POINTER — (v0) states it as an assertion:
   "its controls are ≥ 44 × 44 on coarse pointers", and the table says the
   same. Nothing implemented it: the buttons were 32 px tall and the two icon
   buttons 34 px wide, so a thumb on a real phone was aiming at two-thirds of
   Apple's and Google's own minimum while the bottom bar sat in the hardest part
   of the screen to hit accurately.

   Keyed on the MEDIA QUERY rather than on the coarse variant class, because it
   is a property of the input device rather than of the layout we chose for it
   (NOTE: no backticks in this comment — it is inside a template literal, and one
   backtick closes the string; that has now happened three times) — a
   desktop browser in touch-emulation and a tablet with a trackpad both get the
   right answer, and the rule survives any future variant of the bar.

   min-width as well as min-height: the icon buttons are square-ish and it is
   the horizontal axis that was worst. The segmented control's own padding is
   left alone — its buttons grow from the same rule. */
@media (pointer:coarse){
  .snag-b{min-height:44px;min-width:44px;padding:6px 14px}
  .snag-icon{padding:6px 14px}
}
/* The draft mark's pencil glyph USED TO BE HERE, badged on the corner of the +
   "we dont need the double icon, just the plus in the + button" — and
   the plus is the whole point of that control. F-12's information is not lost:
   it is the button's accessible name, exactly where put the unresolved
   count for the same reason. */
/* The puck: past 1.2× zoom the bar is ONE 44px control (state+panel). */
.snag-puck .snag-row>:not([aria-expanded]){display:none}
.snag-puck{padding:4px;border-radius:50%}
.snag-puck [aria-expanded]{min-width:44px;min-height:44px;border-radius:50%}
`;

export function createToolbar(root: ShadowRoot, opts: ToolbarOptions): Toolbar {
  const doc = root.ownerDocument ?? document;
  const coarse =
    opts.coarsePointer ?? (doc.defaultView?.matchMedia?.("(pointer: coarse)").matches ?? false);

  adopt(root, "toolbar", CSS);

  const el = doc.createElement("div");
  el.className = `snag-tb ${coarse ? "snag-tb--coarse" : "snag-tb--fine"}`;
  el.setAttribute("role", "toolbar");
  el.setAttribute("aria-label", format("toolbar.aria"));

  // On a coarse pointer a draggable pill fights the scroll gesture, so the
  // toolbar is a fixed bottom sheet with a grabber and no grip.
  const grabber = doc.createElement("div");
  grabber.className = "snag-grabber";
  grabber.setAttribute("aria-hidden", "true");

  const row = doc.createElement("div");
  row.className = "snag-row";

  const grip = doc.createElement("span");
  grip.className = "snag-grip";
  grip.setAttribute("aria-hidden", "true"); // keyboard users get the corner picker instead
  grip.appendChild(iconGrip(doc));

  const seg = doc.createElement("div");
  seg.className = "snag-seg";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", format("toolbar.group"));

  /** `content` is TEXT or a built node — never a string of markup. */
  const mk = (cls: string, label: string, content: string | SVGElement): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = `snag-b ${cls}`;
    b.setAttribute("aria-label", label);
    if (typeof content === "string") b.textContent = content;
    else b.appendChild(content);
    return b;
  };

  const browseBtn = mk("", format("toolbar.browse"), format("toolbar.browse"));
  /**
   * The unresolved count lives in this button's ACCESSIBLE NAME and nowhere
   * else (dogfood, round 1).
   *
   * "we dont need the number of comments in the comments button" — and the
   * badge was the least useful thing on it: a reviewer opening the list is
   * about to see the count anyway, and the pill spent toolbar width telling
   * them something one click away.
   *
   * What the pill was really carrying, though, was F-the distinction
   * `null` means UNKNOWABLE, not zero — and that survives here, where it is
   * arguably better placed: "Comments, 3 unresolved" is a sentence, and the
   * absence of the clause is the honest rendering of "we cannot know". A
   * sighted reviewer loses a number they were about to read anyway; a screen
   * reader user loses nothing at all.
   */
  const commentsBtn = mk("", format("toolbar.comments"), format("toolbar.comments"));

  const addBtn = mk("snag-icon", format("toolbar.add"), iconPlus(doc));
  // The one [aria-expanded] carrier in the bar — the puck CSS keys off that.
  const panelBtn = mk("snag-icon", format("toolbar.panel"), iconPanel(doc));
  panelBtn.setAttribute("aria-expanded", "false");

  // ── The pin navigator is KEYBOARD-ONLY (dogfood round 1)
  // `n`/`p` still walk the pins and each step still announces "Comment 3
  // on <label>, 3 of 11" into the live region — that is the path and it
  // is unchanged. What went is the ▲▼ pair and its "–/11" counter, which took
  // a third of a bar that has to sit on somebody else's site without asking
  // for the room.
  //
  // The rejected alternative still stands and is NOT what this reopens:
  // edge-gutter indicators degenerate into a solid stripe on any real page. A
  // counted walker is still the model; it is now driven by keys and read out
  // rather than drawn.

  // ── The picker sub-segment (◻ element / T text) USED TO BE HERE, and
  // deleted it. It appeared when `+` was pressed, which grew the bar by two
  // controls and shifted everything after them — on somebody else's site. `+`
  // now means one thing, and text anchors come from selecting text in
  // `comments`. Nothing about the bar changes when it is used.

  seg.append(browseBtn, commentsBtn);
  if (!coarse) row.appendChild(grip);
  row.append(seg, addBtn, panelBtn);
  if (coarse) el.appendChild(grabber);
  el.appendChild(row);
  (opts.parent ?? root).appendChild(el);

  /**
   * Publish the toolbar's height as `--snag-tb-h` on the shadow host.
   *
   * On a coarse pointer the toolbar is a fixed bottom bar and the dock is a
   * bottom sheet, so they occupy the same corner: without this the sheet's
   * footer — the export buttons — sits underneath the toolbar and cannot be
   * reached at all. Measured rather than hard-coded because the height includes
   * `env(safe-area-inset-bottom)`, which differs per device and changes on
   * rotation. Re-published on resize for exactly that reason.
   */
  const publishHeight = (): void => {
    (root.host as HTMLElement).style.setProperty(CSS_VAR.tbH, `${el.offsetHeight}px`);
  };
  publishHeight();

  /**
   * Where a drag has put the toolbar, or null while it still sits in its
   * default corner. Kept because the clamp has to be re-applied later, not just
   * while the pointer is down.
   */
  let placed: { left: number; top: number } | null = null;

  function place(left: number, top: number): void {
    const view = doc.defaultView!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // Math.max guards a viewport NARROWER than the toolbar: without it the
    // upper bound goes negative, clamp() returns it, and the toolbar is pinned
    // off the left edge — further out of reach than where it started.
    const l = clamp(left, 8, Math.max(8, view.innerWidth - w - 8));
    const t = clamp(top, 8, Math.max(8, view.innerHeight - h - 8));
    placed = { left: l, top: t };
    el.style.left = `${l}px`;
    el.style.top = `${t}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  }

  /**
   * Re-clamp after a resize ("after a resize to 375 px it is still fully
   * on screen").
   *
   * Found by dogfooding, not by a test: drag the toolbar, then make the window
   * smaller, and it is simply gone — the drag clamps against the viewport it
   * had at the time and nothing revisits that. Losing the toolbar means losing
   * every way back to `browse`, so the whole widget becomes unremovable without
   * a reload.
   */
  const onResize = (): void => {
    publishHeight();
    if (placed) place(placed.left, placed.top);
  };
  const win = doc.defaultView;
  win?.addEventListener("resize", onResize);

  browseBtn.addEventListener("click", () => opts.onState("browse"));
  commentsBtn.addEventListener("click", () => opts.onState("comments"));
  addBtn.addEventListener("click", () => opts.onState(current === "add" ? "comments" : "add"));
  panelBtn.addEventListener("click", () => opts.onPanel());

  // Drag, fine pointers only. Every site with an Intercom/Crisp bubble collides
  // with the default corner and we cannot reliably detect those, so moving the
  // toolbar has to be possible (proven necessary in practice).
  if (!coarse) {
    let start: { x: number; y: number; r: DOMRect } | null = null;
    // `setPointerCapture`, so the gesture survives the pointer leaving the grip
    // — including leaving the window and coming back, which window-level
    // listeners do not handle (a pointerup outside never arrives, and the drag
    // sticks to the cursor).
    grip.addEventListener("pointerdown", (e) => {
      start = { x: e.clientX, y: e.clientY, r: el.getBoundingClientRect() };
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (!start) return;
      // Clamped ≥ 8px inside the viewport on all four sides, so it can never be
      // dragged somewhere it cannot be dragged back from — and `place()` owns
      // that rule so the resize path applies exactly the same one.
      place(start.r.left + (e.clientX - start.x), start.r.top + (e.clientY - start.y));
    });
    const end = (e: PointerEvent) => {
      start = null;
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  let current: PointerMode = "browse";

  function setState(state: PointerMode): void {
    current = state;
    browseBtn.setAttribute("aria-pressed", String(state === "browse"));
    commentsBtn.setAttribute("aria-pressed", String(state !== "browse"));
    addBtn.setAttribute("aria-pressed", String(state === "add"));
    syncThumb();
  }

  /**
   * Put the thumb under whichever of the two carries `aria-pressed`.
   *
   * Re-measured on every state change rather than cached once: the labels are
   * fixed at construction but their WIDTHS are not — a host font arriving late
   * restyles them — and the segment reports zero while the bar is in puck mode
   * (display:none) or concealed behind a bottom sheet (hidden), so a cached
   * value would come back collapsed. Two rects on a control the reviewer just
   * clicked is not a cost worth caching against. Zero width when it measures
   * zero is correct: nothing is on screen to put a thumb under.
   */
  function syncThumb(): void {
    const on = seg.querySelector<HTMLElement>('.snag-b[aria-pressed="true"]');
    const segR = seg.getBoundingClientRect();
    const onR = on?.getBoundingClientRect();
    if (!on || !onR?.width) {
      seg.style.setProperty(CSS_VAR.thumbW, "0px");
      return;
    }
    const cs = doc.defaultView?.getComputedStyle(seg);
    const rtl = cs?.direction === "rtl";
    // inset-inline-start:0 is the PADDING box edge, so that side's padding has
    // to come out of the distance or every position is off by it.
    const pad = parseFloat((rtl ? cs?.paddingRight : cs?.paddingLeft) ?? "0") || 0;
    const x = (rtl ? segR.right - onR.right : onR.left - segR.left) - pad;
    seg.style.setProperty(CSS_VAR.thumbW, `${Math.round(onR.width)}px`);
    seg.style.setProperty(CSS_VAR.thumbX, `${Math.max(0, Math.round(x))}px`);
  }



  function setDegraded(on: boolean): void {
    addBtn.disabled = on;
    // The name stays "Add a comment" so the control is still findable by it;
    // the reason rides along as the description rather than replacing it.
    if (on) addBtn.title = format("error.panels.add");
    else addBtn.removeAttribute("title");
    // Browse/Comments must keep working with the chunk blocked — pins
    // are the runtime's, not the panels chunk's.
  }

  /**
   * F-12, as a NAME rather than a glyph.
   *
   * The pencil badge is gone; this is the whole of what is left, and it is the
   * half that was already doing the work. A screen reader never saw the glyph —
   * it read this string — so nothing is lost there. A sighted reviewer loses a
   * 9px mark on the corner of a 16px plus, and gains a button that means one
   * thing. The draft itself is untouched: it is still saved, still restored,
   * and opening the composer still finds the words where they were left.
   */
  function setDraft(on: boolean): void {
    addBtn.setAttribute(
      "aria-label",
      on ? format("toolbar.add.draft") : format("toolbar.add"),
    );
  }

  /**
   * The unresolved count, as the Comments button's accessible name.
   *
   * THREE states, and the third is the one that matters: `null` is not zero.
   * F-01 asks for the distinction by name — when storage is unavailable
   * the count is UNKNOWABLE, and claiming a number the next page load cannot
   * honour is worse than claiming none. Both `null` and `0` therefore render
   * the bare "Comment"; only a positive count adds its clause. The count
   * itself is locale-formatted; there is no "9+" cap any more,
   * because a cap is a property of a badge 20 px wide and a sentence has room.
   */
  function setCount(n: number | null): void {
    commentsBtn.setAttribute(
      "aria-label",
      n !== null && n > 0
        ? format("toolbar.comments.unresolved", { n: count(n) })
        : format("toolbar.comments"),
    );
  }

  setState("browse");
  setCount(0);

  function setPuck(on: boolean): void {
    el.classList.toggle("snag-puck", on);
    if (!on) syncThumb(); // puck is display:none, so it measured zero
  }

  function setConcealed(on: boolean): void {
    el.hidden = on;
    if (!on) syncThumb(); // same reason as setPuck: hidden measures zero

    publishHeight(); // hidden ⇒ offsetHeight 0 ⇒ --snag-tb-h: 0px (C7)
  }

  return {
    el,
    setState,
    setCount,
    setDegraded,
    setDraft,
    setPuck,
    setConcealed,
    destroy() {
      win?.removeEventListener("resize", onResize);
      (root.host as HTMLElement).style.removeProperty(CSS_VAR.tbH);
      el.remove();
    },
  };
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

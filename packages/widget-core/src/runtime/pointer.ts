import { widgetAttr } from "@snagset/types/names";
import { LAYER, t } from "./theme.ts";
import { candidateFor } from "../anchor/candidate.ts";
import { MAX_SHADOW_DEPTH } from "../anchor/shadow.ts";

/**
 * Pointer isolation in review mode — shield + capture net.
 *
 * A5 asks for capture-phase interception. Capture alone has a hole: a host
 * listener registered on `window` in the capture phase BEFORE we activate runs
 * first, and `stopImmediatePropagation()` cannot un-run it. So there are two
 * mechanisms, and the split is deliberate:
 *
 *   · SHIELD — a full-viewport element inside our shadow root. For mouse/pen the
 *     host app is never the event target, so no host listener at any phase can
 *     fire. Structural, not a race with listener-registration order.
 *   · CAPTURE NET — window capture listeners for keyboard, ALL touch, and any
 *     pointer event that bypassed the shield (synthetic events; the ~1 frame
 *     between pointerdown and shield insertion if review mode is entered
 *     mid-gesture).
 */

/**
 * The three states. Draft 4 had two pointer modes and no
 * way to say "show me the site with nothing on it" — the state a client spends
 * most of their time in. The prototype added it.
 *
 *   browse   — nothing rendered at all. Pins are ABSENT from the DOM, not hidden.
 *   comments — pins visible, shield DOWN. Reading must not cost interactivity:
 *              in `comments` the page under review still behaves like the page.
 *   add      — shield up, crosshair. Picking a target.
 */
export type PointerMode = "browse" | "comments" | "add";

/** Events the net owns. `passive` is part of the contract, not a tuning knob. */
const NET: [type: string, passive: boolean][] = [
  ["click", false],
  ["auxclick", false],
  ["dblclick", false],
  ["pointerdown", false],
  ["pointerup", false],
  ["mousedown", false],
  ["mouseup", false],
  ["contextmenu", false],
  ["dragstart", false],
  // Wheel must be non-passive: with the shield up we sometimes have to scroll a
  // host element ourselves and cancel the default (see forwardWheel).
  ["wheel", false],
  // ALWAYS passive (A5 corrigendum). Registering these passive makes
  // preventDefault() IMPOSSIBLE by construction rather than merely forbidden —
  // it converts a rule a later edit could break into one the platform enforces.
  // Calling preventDefault() on touchstart is *the* documented way to disable
  // scrolling; doing it here would make review mode unscrollable on every touch
  // device and kill the mobile story outright.
  ["touchstart", true],
  ["touchmove", true],
  ["touchend", true],
  // Passive for the same reason as touch, and it matters more here: cancelling
  // `selectstart` is the documented way to make text UNSELECTABLE, which is
  // the exact opposite of what it is registered for.
  ["selectstart", true],
  // The allowlist. Non-passive because rule 2 has to be able to cancel a
  // host's single-letter hotkey — which is the entire point of the rung.
  ["keydown", false],
  ["keyup", false],
];

/**
 * The nearest ancestor that can actually scroll in the wheel's direction.
 * `overflow:auto` on an element that does not overflow is not scrollable, which
 * is why the size comparison is part of the test rather than the style alone.
 */
function scrollableAncestor(el: Element | null, dy: number, dx: number): Element | null {
  let n: Element | null = el;
  while (n && n !== n.ownerDocument.documentElement && n !== n.ownerDocument.body) {
    const cs = getComputedStyle(n);
    const canY =
      (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
      n.scrollHeight > n.clientHeight &&
      ((dy > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1) || (dy < 0 && n.scrollTop > 0));
    const canX =
      (cs.overflowX === "auto" || cs.overflowX === "scroll") &&
      n.scrollWidth > n.clientWidth &&
      ((dx > 0 && n.scrollLeft + n.clientWidth < n.scrollWidth - 1) || (dx < 0 && n.scrollLeft > 0));
    if (canY || canX) return n;
    n = n.parentElement;
  }
  return null;
}

/** Wheel deltas arrive in pixels, lines or pages depending on the device. */
function pixels(e: WheelEvent, axis: "y" | "x"): number {
  const raw = axis === "y" ? e.deltaY : e.deltaX;
  if (e.deltaMode === 1) return raw * 16; // LINE
  if (e.deltaMode === 2) return raw * (axis === "y" ? innerHeight : innerWidth); // PAGE
  return raw;
}

export interface PointerController {
  readonly shield: HTMLElement;
  setMode(mode: PointerMode): void;
  getMode(): PointerMode;
  /** Elements under a viewport point, with our own UI removed. */
  hitTest(x: number, y: number): Element[];
  destroy(): void;
}

export interface PointerOptions {
  /** Called with the topmost host element when the reviewer picks a target. */
  onPick?(el: Element, point: { x: number; y: number }): void;
  /**
   * The element under the pointer in `add` mode, rAF-coalesced.
   *
   * Coalescing is not an optimisation here, it is the AC: requires the
   * highlight to keep up at ≥50 fps while moving, and a pointermove handler
   * that measures on every event does layout work several times per frame.
   * `null` when the pointer leaves the page.
   */
  onHover?(el: Element | null): void;
  /**
   * A selection has BEGUN on the host page in `comments`.
   *
   * This is a load trigger, not a result: `selectstart` fires when the drag
   * starts, so the chunk that draws the chip lands during the drag instead of
   * on entry to `comments` — which is the state a review link arrives in, and
   * would have put those bytes inside the activation sum.
   */
  onSelectStart?(): void;
  /** Injected for tests; defaults to the real media query. */
  coarsePointer?: boolean;
  doc?: Document;
}

const SHIELD_CSS = [
  "position:fixed",
  "inset:0",
  // Under the toolbar, under the dock, UNDER THE PINS, and over
  // everything of the host's. See theme.ts's LAYER for the whole ladder.
  `z-index:${LAYER.shield}`,
  // pan-x pan-y PINCH-ZOOM: omitting pinch-zoom would suppress the browser's
  // zoom gesture and fail WCAG 1.4.4. Gesture control lives here and only here —
  // never on a host element.
  "touch-action:pan-x pan-y pinch-zoom",
  "background:transparent",
].join(";");

export function createPointerController(
  root: ShadowRoot,
  opts: PointerOptions = {},
): PointerController {
  const doc = opts.doc ?? root.ownerDocument ?? document;
  const win = doc.defaultView ?? window;

  // The coarse flag is DYNAMIC — initialised from the media
  // query, then flipped by every real pointer event. A hybrid (touch laptop)
  // starts from `(pointer: coarse)` and corrects itself on first contact:
  // a mouse user on a touch laptop raises the shield; a finger stands it down.
  let coarse =
    opts.coarsePointer ?? (win.matchMedia?.("(pointer: coarse)").matches ?? false);
  const noteCoarse = (e: Event): void => {
    const pt = (e as PointerEvent).pointerType;
    // Only a KNOWN type flips it: WebKit hands synthetic taps an empty
    // pointerType, and reading "" as "not touch" raised the shield on the
    // very tap that proved the finger (found by the suite on iPhone).
    const next = pt === "touch" ? true : pt === "mouse" || pt === "pen" ? false : coarse;
    if (next !== coarse) {
      coarse = next;
      applyShieldState();
    }
  };

  const shield = doc.createElement("div");
  shield.className = "snag-shield";
  shield.style.cssText = SHIELD_CSS;

  /**
   * THE TOUCH DECISION, and the reasoning is worth keeping close:
   *
   * Scroll chaining follows the EVENT TARGET's ancestor chain, not what is
   * visually beneath the finger. A full-viewport shield in our shadow root has
   * exactly one scrollable ancestor — the document. So a touch pan over a host
   * app's inner scroller (sidebar, modal body, data table) would scroll the PAGE
   * instead, and on an app-shell layout (`body{overflow:hidden}` + inner
   * scroller) would scroll NOTHING. Flipping pointer-events mid-gesture cannot
   * fix it: the browser fixes the scroll target when the gesture begins.
   *
   * The shield exists to own HOVER — and touch has no hover. So on a coarse
   * pointer it stands down from the first frame, the host element really is the
   * touch target, and native panning, momentum, pinch-zoom, overscroll and
   * correct chaining into nested scrollers all just work. The capture net still
   * owns behaviour: a tap landing on a link cannot navigate, because `click` is
   * cancelled at window capture.
   */
  let mode: PointerMode = "browse";

  /**
   * Simplified this to one condition. Text anchoring used to be a sub-mode
   * that stood the shield down; it is now what selecting text in `comments`
   * does — and the shield is ALREADY down in `comments`, because reading must
   * not cost interactivity. So there is nothing here to stand down: the shield
   * exists for `add`, where it is up on a fine pointer and down on a coarse
   * one.
   */
  const applyShieldState = (): void => {
    shield.style.pointerEvents = coarse ? "none" : "auto";
    shield.style.cursor = "crosshair";
  };
  applyShieldState();

  /** Is this node ours? Shadow content reports the host, so check both. */
  const isOurs = (n: EventTarget | Element | null): boolean => {
    const el = n as Element | null;
    if (!el || typeof (el as Element).closest !== "function") return false;
    if (root.contains(el as Node)) return true;
    return !!el.closest(`[${widgetAttr("root")}]`);
  };

  /**
   * Down into the host page's OWN open shadow roots, v0.
   *
   * `elementsFromPoint` runs the retargeting algorithm, so it never returns a
   * node inside a shadow tree: it returns the shadow HOST. Without this descent
   * every web component on a page is a single opaque block, and pointing at a
   * button inside one offers the whole component instead. Reported from
   * /lab/overlays as "only the whole div parent of the shadow root" — which was
   * a precise description of retargeting.
   *
   * Closed roots need no branch: `shadowRoot` is null for them, so they take
   * the same path and stop at the host, which is what the design wants for them
   * anyway. The depth cap is the, and it caps OUR walk rather than the page:
   * a component nested eleven roots deep still gets a pin, just one addressed
   * at the tenth boundary.
   *
   * ── WHERE THIS DEPARTS FROM THE CODE PRINTS, AND WHY IT HAS TO ──
   *
   * The snippet calls `shadowRoot.elementFromPoint(x, y)` — the SINGULAR
   * form — and that returns the wrong node in the one configuration this
   * function exists for. While `add` is on, our shield is the topmost element
   * in the document, and the singular call retargets it into the root being
   * asked, handing back a node that is not inside that root at all. Measured on
   * a host component: the singular call answered with our own shadow host,
   * `candidateFor` was given a div with no text, and the composer offered to
   * pin "the div" — which is the exact symptom this was meant to remove.
   *
   * The plural form returns the whole stack, so the first node whose root IS
   * this root is the real answer. That test is deliberately by ROOT IDENTITY
   * rather than by `isOurs`: it excludes our shield without needing to know
   * anything about our shield, and it also excludes the host's own outer nodes
   * that retargeting drags into the list.
   */
  function deepElementFromPoint(x: number, y: number, start: Element): Element {
    let el = start;
    let depth = 0;
    while (el.shadowRoot && depth++ < MAX_SHADOW_DEPTH) {
      const inner = insideRoot(el.shadowRoot, x, y);
      // `inner === el` cannot normally happen, but a root whose only content is
      // a slot can hand back the host and spin this loop forever.
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /** The topmost element at (x, y) that genuinely lives in `sr`. */
  function insideRoot(sr: ShadowRoot, x: number, y: number): Element | null {
    const many = (sr as unknown as { elementsFromPoint?: (x: number, y: number) => Element[] })
      .elementsFromPoint;
    if (typeof many === "function") {
      for (const el of many.call(sr, x, y)) if (el.getRootNode() === sr) return el;
      return null;
    }
    // No plural form on this engine. The singular one is still right whenever
    // nothing of ours is on top — which is every hover in `comments`, and every
    // pick on a coarse pointer, where the shield stands down.
    const one = sr.elementFromPoint(x, y) as Element | null;
    return one && one.getRootNode() === sr ? one : null;
  }

  function hitTest(x: number, y: number): Element[] {
    const out: Element[] = [];
    for (const el of doc.elementsFromPoint(x, y)) {
      if (isOurs(el)) continue;
      // The last-resort roots have no shadow root worth descending and are the
      // one case where handing back the container is the right answer.
      if (el === doc.documentElement || el === doc.body) {
        out.push(el);
        continue;
      }
      const deep = deepElementFromPoint(x, y, el);
      // A descent that lands back inside our own tree keeps the host: it means
      // the page has slotted our node into its component, and the ownership
      // rule says the answer to "is this ours?" is never "yes, so pin it".
      out.push(isOurs(deep) ? el : deep);
    }
    return out;
  }

  // The derived-tap state. The tap's COMPATIBILITY click needs no handling
  // here: on coarse the composer's scrim is under it by the time it lands,
  // and the scrim ignores clicks in its first breath (composer.tsx) — the
  // engine-agnostic version of a dedupe that WebKit's synthetic click
  // ordering defeated when it lived in this net.
  let tapStart: { x: number; y: number; t: number } | null = null;

  // The SAME candidate the highlight offered — picking a different element
  // from the one that was outlined is the bug the heuristic exists to stop.
  const pickAt = (x: number, y: number): void => {
    const [target] = hitTest(x, y);
    if (target) opts.onPick?.(candidateFor(target), { x, y });
  };

  /**
   * `comments`, whose whole job is to intercept almost nothing.
   *
   * Two behaviours, and the second is the one that can break somebody else's
   * site if it is wrong:
   *
   *  1. `selectstart` → tell the runtime a selection has begun, so the chunk
   *     that draws the chip loads during the drag.
   *
   *  2. THE ONE CANCELLED CLICK. Selecting a run of text that lies entirely
   *     inside an `<a href>` ends with mouseup on the link, and the click that
   *     follows navigates — away from the page the reviewer was about to
   *     comment on, with the selection lost. The old text sub-mode prevented
   *     this by cancelling `click` for the whole sub-mode; `comments` cannot,
   *     because the state exists precisely so the host page still works.
   *
   *     So the arm is single-shot and its condition is narrow: a `pointerup`
   *     that leaves a non-collapsed host selection behind arms exactly the
   *     next click, and anything at all disarms it. An ordinary click leaves
   *     the selection collapsed and is never armed — which is the property
   *     the second half tests, because a cancel that leaked into
   *     ordinary clicks would break every link on the page.
   */
  let clickArmed = false;

  /** A live, non-empty selection on the HOST page — not in our own UI. */
  const hostSelection = (): boolean => {
    const sel = doc.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    if (!sel.toString().trim()) return false;
    // A selection's anchor is usually a TEXT node, which has no `closest` —
    // so `isOurs` cannot be asked directly. Its parent element can be.
    const node = sel.anchorNode;
    if (!node) return false;
    if (root.contains(node)) return false;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    return !isOurs(el);
  };

  const commentsNet = (e: Event): void => {
    const target = e.composedPath()[0];
    // Our pins and our chip receive their own clicks; the design owns the pin path.
    // It also DISARMS: a gesture that landed on our UI is not one the host
    // page is about to see a click from, so holding the arm past it would
    // spend it on an unrelated click later. Reachable via a keyboard
    // selection — shift-arrow arms on keyup, and the chip is then clicked
    // rather than the page, so no page click ever arrives to consume it.
    if (target && isOurs(target as Element)) {
      clickArmed = false;
      return;
    }

    if (e.type === "selectstart") {
      opts.onSelectStart?.();
      return;
    }

    // BY SUFFIX, NOT BY NAME, and that is a build gate rather than a flourish:
    // verify-dist asserts that every "touchstart"/"touchmove"/"touchend"
    // literal in a shipped artefact sits in the passive NET tuple shape, so
    // that "touch is never defaulted" cannot be undone by a later edit.
    // Comparing `e.type` against those names spells them outside the tuple and
    // fails the gate — correctly, because the gate cannot tell my comparison
    // from somebody's new non-passive listener. Suffixes carry the same
    // meaning and spell nothing. `selectstart` has already returned above, so
    // it never reaches the "start" arm.
    const type = e.type;

    // A NEW gesture beginning clears any stale arm — pointerdown, mousedown,
    // touchstart, dragstart, keydown. A stale arm is a swallowed click on
    // somebody else's site, so it must not outlive the gesture that set it.
    if (type.endsWith("down") || type.endsWith("start")) {
      clickArmed = false;
      return;
    }
    // Every way a gesture can END, because the browsers disagree about the
    // order and only one of them is reliably the last before `click`. On a
    // mouse it is pointerup → mouseup → click; on touch, Chrome fires
    // pointerup → TOUCHEND → compatibility mouse events → click. An earlier
    // version cleared the arm on "anything else", which meant touchend
    // disarmed it between the selection and the click it was meant to stop —
    // the protection would have been mouse-only, on the platform where a
    // mis-fired navigation costs the most. `keyup` lands here too, which
    // extends the same protection to a shift-arrow selection for free.
    if (type.endsWith("up") || type.endsWith("end")) {
      // The selection is final by the first of them, so they all compute the
      // same answer and the write is idempotent.
      clickArmed = hostSelection();
      return;
    }
    if (type === "click" || type === "auxclick") {
      if (!clickArmed) return;
      clickArmed = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    // Everything else — wheel, scroll, keys, contextmenu, dblclick — is left
    // strictly alone, arm and all. `dblclick` in particular: its default IS
    // the word selection, and a host acting on a double-click it can see is
    // not our business.
  };

  const onEvent = (e: Event): void => {
    // The hybrid flip rides pointerDOWN only: WebKit's synthetic
    // post-tap `click` is a PointerEvent claiming pointerType "mouse", so a
    // finger's own compatibility click would flip the flag straight back.
    if (e.type === "pointerdown") noteCoarse(e);
    // `browse` leaves the host page completely alone — that is what makes a
    // review link safe to send to anyone. `comments` is *nearly* as free: it
    // intercepts exactly one click, and never a category of them.
    if (mode === "comments") {
      commentsNet(e);
      return;
    }
    if (mode !== "add") return;

    // OUR OWN UI IS NOT A TARGET. The composer and toolbar paint ABOVE the
    // shield, so they receive their own clicks — but this window-level capture
    // listener still sees them, and without this check a click on the composer
    // created a second pick and reopened the composer over whatever was behind
    // it. Found by typing into it. `composedPath` is required rather than
    // `e.target`: retargeting reports the shadow HOST for events inside the
    // root, which is indistinguishable from a click on the host page.
    // …EXCEPT the shield, which is a transparent hit-catcher rather than chrome:
    // every pick lands on it by design.
    //
    // Only the ACTUAL TARGET is consulted — composedPath()[0]. Scanning the
    // whole path is wrong twice over: a click on the shield carries the shadow
    // root and the host in its path, and both are "ours", so a path scan
    // rejected every pick and the tool stopped working. Two versions of this
    // check were wrong before this one; the E2E suite caught both.
    // Keyboard is an ALLOWLIST and takes its own path — see `onKey`. It sits
    // ABOVE the our-UI check: `editableTarget()` already exempts every editable
    // surface (the composer's textarea included), and routing our-focused keys
    // through the same rules is what makes a key behave identically with the
    // toolbar focused and with the page focused, through ONE code path.
    if (e.type === "keydown" || e.type === "keyup") {
      onKey(e as KeyboardEvent);
      return;
    }

    const target = e.composedPath()[0];
    if (target && target !== shield && isOurs(target as Element)) return;

    const passive = NET.find(([t]) => t === e.type)?.[1] ?? false;

    // Host listeners must not run, on any phase, for any of these.
    e.stopImmediatePropagation();

    if (passive) return; // touch: never defaulted — see above

    // preventDefault only where it cannot break input the reviewer needs:
    // suppress navigation, drag-start and focus changes, never text selection
    // or IME.
    if (coarse && e.type === "pointerdown") {
      const pe = e as PointerEvent;
      tapStart = { x: pe.clientX, y: pe.clientY, t: performance.now() };
      queueHover(pe.clientX, pe.clientY);
    }
    /**
     * THE DERIVED TAP (A5, verbatim: "taps are derived from
     * pointerdown/pointerup position and timing") — and it is not an
     * optimisation. iOS Safari only synthesizes `click` for elements its
     * heuristics call clickable, so a tap on a plain <p> or <h1> — the
     * exact things reviewers point at — fired pointer events and NO click,
     * and the pick silently never happened (found on the iPhone
     * suite; invisible on Chromium, which clicks everything). ≤8 px and
     * ≤700 ms are the numbers; the click that DOES follow on
     * clickable elements is deduped below.
     */
    if (coarse && e.type === "pointerup" && tapStart) {
      const pe = e as PointerEvent;
      const start = tapStart;
      tapStart = null;
      if (
        Math.hypot(pe.clientX - start.x, pe.clientY - start.y) <= 8 &&
        performance.now() - start.t <= 700
      ) {
        pickAt(pe.clientX, pe.clientY);
      }
      return;
    }
    if (e.type === "click" || e.type === "auxclick" || e.type === "dblclick") {
      e.preventDefault();
      const me = e as MouseEvent;
      pickAt(me.clientX, me.clientY);
      return;
    }
    if (e.type === "wheel") {
      // SCROLL PARITY (the desktop twin). The shield is the event target,
      // and its only scrollable ancestor is the document — so without this, a
      // wheel over a host app's inner scroller (sidebar, modal body, data table)
      // scrolls the PAGE instead, and on an app-shell layout scrolls nothing.
      // Measured before this existed: page +200px, nested box 0px.
      const we = e as WheelEvent;
      const dy = pixels(we, "y");
      const dx = pixels(we, "x");
      const [under] = hitTest(we.clientX, we.clientY);
      const target = scrollableAncestor(under ?? null, dy, dx);
      if (target) {
        target.scrollTop += dy;
        target.scrollLeft += dx;
        e.preventDefault(); // we performed the scroll ourselves
      }
      // No scrollable host ancestor ⇒ do NOT preventDefault, so the page scrolls
      // natively — momentum, overscroll and rubber-banding all intact.
      return;
    }
    if (e.type === "dragstart" || e.type === "contextmenu") {
      e.preventDefault();
      return;
    }
    if ((e.type === "pointerdown" || e.type === "mousedown") && !coarse) {
      // Only when the shield is up: stops host drag-start and focus change.
      e.preventDefault();
    }
  };

  /**
   * AN ALLOWLIST, NOT A DENYLIST, and the history is the argument.
   *
   * Draft 1 swallowed "all keydown that is not a modifier or Tab". Cancellable
   * browser shortcuts include Cmd/Ctrl+F, +R, +C, +P, zoom and arrow/space
   * scrolling — so a reviewer could not find text on the page, reload the
   * staging build they were reviewing, copy an error string, or scroll with the
   * keyboard, and a screen reader's virtual cursor was swallowed whole.
   *
   * So in an armed mode we cancel ONLY:
   *   1. Escape, which we own while a surface of ours is open.
   *   2. An unmodified single character in [a-z0-9/?] — the host-hotkey class
   *      (Gmail, GitHub and Linear all use them, and `/` focuses search on
   *      most of the rest of the web) — and only when focus is not editable.
   *
   * Anything else is left completely alone: no preventDefault, and no
   * stopImmediatePropagation either where the key is a browser chord or a
   * navigation key, so browser and assistive behaviour survive intact.
   *
   * **`Tab` is never intercepted, in any mode, by any layer.** the design states it
   * as an absolute: it is the reviewer's only reliable escape from our UI back
   * into the page, and a screen-reader user's only reliable way through the
   * host app.
   */
  const NAV_KEYS = new Set([
    "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    " ", "Spacebar", "PageUp", "PageDown", "Home", "End",
  ]);
  const HOST_HOTKEY = /^[a-z0-9/?]$/;

  /**
   * The editable test, through `composedPath()` rather than `activeElement`.
   *
   * Retargeting reports the shadow HOST for a focus inside a host app's own web
   * component, so `document.activeElement` cannot tell an `<input>` inside one
   * from the component itself — and cancelling a reviewer's keystroke while
   * they type into a host form is the worst thing on this list.
   */
  function editableTarget(e: KeyboardEvent): boolean {
    for (const n of e.composedPath()) {
      const el = n as Element;
      if (!el || el.nodeType !== 1 || typeof el.matches !== "function") continue;
      if (el.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]')) {
        return true;
      }
    }
    return false;
  }

  function onKey(e: KeyboardEvent): void {
    // Never Tab, never a navigation key, in any circumstance.
    if (NAV_KEYS.has(e.key)) return;
    // Never a browser-level chord we did not bind. Cmd+F and Ctrl+R belong to
    // the reviewer, and the design says so in as many words.
    //
    // `altKey` is in this list because rule 2 is about an **unmodified** single
    // character, and Alt+C is modified — but the sharper reason is that Alt+C is
    // OUR OWN chord. This listener is on `window` and the chord's is
    // on `document`, so window-capture runs first: without this line, entering
    // `add` and pressing Alt+C to leave it swallowed the keystroke before the
    // loader ever saw it, and the only way out of add mode by keyboard was gone.
    // Caught by the WebKit project, where Alt+C yields "ç" and Chromium's own
    // pass had said nothing.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Function keys are the browser's and the screen reader's.
    if (/^F\d{1,2}$/.test(e.key)) return;

    /**
     * ESCAPE IS LEFT ENTIRELY ALONE HERE, and the reason is a bug this made.
     *
     * The design lists Escape as ours, and the first version stopped it at window
     * capture so the host would not see it. But the runtime's own Escape
     * handler is registered on the DOCUMENT (runtime/index.ts), and window
     * capture runs first — so stopping it there stopped OUR handler, and Escape
     * no longer left add mode. Caught by the WebKit degraded-mode test, which
     * is the one path where Escape is the only way out: with the panels chunk
     * gone there is no composer to close and no dock to dismiss.
     *
     * The escape ladder working is worth more than the host not seeing the key.
     * The surfaces own the behaviour; this net owns nothing about it.
     */
    if (e.key === "Escape") return;

    // Rule 2. `e.key` is the character, so this is layout-independent, and the
    // length check is what keeps "Enter", "Shift" and every named key out.
    if (e.key.length === 1 && HOST_HOTKEY.test(e.key.toLowerCase()) && !editableTarget(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      // `t` used to be ours here — the picker toggle. Deleted the picker,
      // so `t` is now nothing but a swallowed host hotkey, like every other
      // single letter. The swallow itself is rule 2 and is unchanged.
    }
  }

  for (const [type, passive] of NET) {
    win.addEventListener(type, onEvent, { capture: true, passive });
  }


  /**
   * Hover reporting, coalesced to one measurement per frame.
   *
   * Wants the highlight tracking at ≥50 fps. A pointermove handler that
   * hit-tests and measures on every event does that work several times per
   * frame on a fast mouse, and the frames it costs are the ones the highlight
   * needed. rAF is also what makes the reported element agree with what is on
   * screen: the last position in the frame is the one the eye sees.
   */
  let hoverPending = 0;
  let hoverAt: { x: number; y: number } | null = null;

  function reportHover(): void {
    hoverPending = 0;
    if (mode !== "add" || !hoverAt) return;
    const [top] = hitTest(hoverAt.x, hoverAt.y);
    opts.onHover?.(top ? candidateFor(top) : null);
  }

  function queueHover(x: number, y: number): void {
    if (mode !== "add") return;
    hoverAt = { x, y };
    if (hoverPending) return;
    hoverPending = win.requestAnimationFrame(reportHover);
  }

  // Fine pointers: the shield IS the event target, so it sees every move.
  // Coarse pointers have no hover at all — the shield stands down there — so the
  // highlight is a confirmation flash on touch instead, driven from the net's
  // pointerdown.
  shield.addEventListener("pointermove", (e) => queueHover(e.clientX, e.clientY));
  shield.addEventListener("pointerleave", () => {
    hoverAt = null;
    opts.onHover?.(null);
  });

  return {
    shield,
    getMode: () => mode,
    setMode(next) {
      mode = next;
      // A mode change is "anything new" as far as the single-shot click arm is
      // concerned — and leaving `comments` with one live would spend it on the
      // host's next click in a state that never armed it.
      clickArmed = false;
      applyShieldState();
      // ATTACHED AND DETACHED, never merely hidden.: switching
      // `add → comments → browse` "leaves no shield, no highlight and no hint
      // node behind" — and already holds the pin layer to the same rule,
      // "absent from the DOM, not hidden by CSS". A hidden `position:fixed`
      // overlay is still a node in a client's page: it answers their own
      // `querySelectorAll`, it matches their `:has()`, and it makes "browse is
      // the site untouched" a sentence they can disprove in devtools.
      if (next === "add") root.appendChild(shield);
      else shield.remove();
      if (next !== "add") {
        // In the SAME task as the shield coming down, so no outline
        // survives the mode change.
        hoverAt = null;
        opts.onHover?.(null);
      }
    },
    hitTest,
    destroy() {
      if (hoverPending) win.cancelAnimationFrame(hoverPending);
      for (const [type] of NET) {
        win.removeEventListener(type, onEvent, { capture: true });
      }
      shield.remove();
    },
  };
}

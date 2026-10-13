import { assess, resolveAnchor } from "../anchor/resolve.ts";
import { stateFor } from "../anchor/score.ts";
import { adopt, LAYER, t } from "./theme.ts";
import { format } from "../strings/runtime.ts";
import { clusterPoints } from "./cluster.ts";
import { rectOf, isRendered } from "../anchor/geometry.ts";
import { statusInk, statusLabel, whereText, type Snag } from "../storage/types.ts";
import type { AnchorResolution, AnchorState } from "../anchor/types.ts";


/**
 * The pin layer: document-coordinate positioning and re-anchoring.
 *
 * Pins live in DOCUMENT coordinates inside a container at the document origin,
 * so the browser moves them with the page. That is why scrolling costs zero
 * JavaScript — no scroll listener, no rAF, nothing to jank.
 */

/**
 * The layer ladder, top to bottom: toolbar `z` · dock/notice `z-1` · PINS `z-2`
 * · shield `z-3`.
 *
 * Pins above the shield is and it is not cosmetic: with the shield on
 * top, a pin clicked in `add` was invisible to the hit test and the click went
 * to the element underneath, so tapping a pin to READ it filed a duplicate
 * comment on the same element. The design calls that "the worst client outcome there
 * is". The shield moved down rather than the pins moving up, because the dock
 * and the notice already own `z-1`.
 */
// `top:0;left:0` stays PHYSICAL and must: this is not layout, it is the
// document's coordinate ORIGIN. Pin positions come from getBoundingClientRect,
// which reports physical pixels in every writing mode, so a logical origin here
// would place every pin by one convention and measure it by another.
const DOC_CSS = `position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:${LAYER.pins}`;

const PULSE_CSS = `
.snag-pp{animation:snag-pp .5s ease-out 2}
@keyframes snag-pp{50%{transform:scale(1.45)}}
@media (prefers-reduced-motion: reduce){.snag-pp{animation:none}}
/* 28px fine / 34px coarse visual; ::after grows the HIT
   box to 44px — a transparent halo, no layout, no ring change. */
.snag-pin{width:28px;height:28px;margin:-14px 0 0 -14px}
.snag-pin::after{content:"";position:absolute;inset:-8px}
@media (pointer:coarse){.snag-pin{width:34px;height:34px;margin:-17px 0 0 -17px}}
`;
/**
 * The DYNAMIC layer — viewport coordinates.
 *
 * A pin in the document layer is placed once, in page space, and the browser
 * moves it with the page for free. That is exactly right for ordinary content
 * and exactly wrong for anything whose element does NOT move with the page: a
 * sticky nav, a `position:fixed` header, a page-transition wrapper with a
 * transform on it, or content inside a nested `overflow:auto` panel. Those
 * elements move relative to the document constantly, so a document-space pin
 * detaches from its target the moment anything scrolls — placed confidently,
 * and wrong, which is the failure the anchoring spec exists to prevent.
 *
 * Pins classified `dynamic` live here instead and are re-placed from a live
 * rect on each sync. It costs JavaScript, which is why only they pay it.
 */
const FIXED_CSS = `position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:${LAYER.pins}`;

// SIZE lives in the adopted sheet, not here: inline style beats a stylesheet,
// so the coarse 34px override could never win against an inline
// width. PIN_CSS below carries 28px fine / 34px coarse and the 44px ::after
// hit halo; this base carries everything size-independent.
const PIN_BASE = [
  "position:absolute",
  `color:${t.onAccent}`,
  `font:600 12px/1 ${t.font}`,
  // Centred by FLEX, not by line-height. The box is 24px but `box-sizing:
  // border-box` plus a 2px ring leaves a 20px content box, so the old
  // `line-height:24px` overflowed it and sat the number ~4px low — in every
  // pin, in every state, including the ones that looked right at a glance.
  "display:flex",
  "align-items:center",
  "justify-content:center",
  "box-shadow:0 1px 4px rgb(0 0 0 / .35)",
  "pointer-events:auto",
  "cursor:pointer",
  "box-sizing:border-box",
].join(";");

/**
 * One shape for every pin. A state that changes the silhouette reads
 * as a different kind of object rather than the same object in trouble.
 */
const SHAPE = "border-radius:50% 50% 50% 2px";

/** `--snag-status-progress` for `progress`, etc. One table, one spelling. */
const statusVar = (s: Snag["status"]): string =>
  // F-07b: a status this build does not know fills NEUTRAL GREY, never
  // `background:undefined` (a dropped declaration and an unfilled pin).
  t[`status${s[0]!.toUpperCase()}${s.slice(1)}` as keyof typeof t] ?? t.muted;

/**
 * How a snag is drawn in each of the three anchor states.
 *
 * TWO AXES, TWO CHANNELS: status owns the FILL, anchor state owns the BORDER.
 * That separation is why an orphan keeps its status colour — a reviewer
 * scanning a page must still see whether a lost-anchor snag is Active or
 * Resolved, and the design forbids any surface having its own palette.
 *
 * An earlier version greyed the orphan's fill. It read well and it was wrong:
 * it deleted status from every orphaned pin to solve a contrast problem in one
 * cell of four, and re-implemented the "de-emphasise the orphan" instinct that
 * records as deliberately overturned. Orphans stay ON the page, in
 * colour, at their fallback point.
 *
 * RING COUNT carries the orphan state, and that is the channel that works
 * without touching hue or silhouette. A single coloured ring cannot do it: the
 * spec's amber vanished on the amber *In progress* fill, and red vanishes on
 * the green *Resolved* fill for the ~8% with red–green colour blindness — a
 * hue-only answer only chooses whose cell breaks, because the ring is always
 * sitting directly against a fill it has to out-contrast.
 *
 * That used to be TWO RINGS — white inside, red outside — on the stated
 * ground that "red is unused by the status palette, so it collides with
 * nothing". Spends warm on `In progress`, and #DC2626 measures ΔE 2
 * against it under deuteranopia: indistinguishable, which is the one thing
 * this state cannot be. Every remaining hue was searched against the four
 * fills, the stray grey and the accent across normal vision and all three
 * dichromacies, and nothing scored better than ΔE 10. There is no colour
 * answer left.
 *
 * The inner white ring had stopped working too: `Resolved` is a pale green,
 * and white on it is 1.46:1 — the ring the red was supposed to stand against
 * would not have been there.
 *
 * SHAPE is not available either, and that is deliberate rather than an
 * oversight: persist.spec.ts asserts one silhouette across all three states,
 * because "a pin that changes shape reads as a different kind of object
 * rather than the same one in trouble". That argument survives intact.
 *
 * What is left is the channel the spec named first and the test already
 * asserts: RING COUNT. Both rings become the status ink, which every fill
 * out-contrasts by at least 5.5:1, so an orphan is 4 px of ink where the other
 * states carry 2 px — a weight difference, legible at 22 px in the dock and at
 * 28 px on the page, and untouchable by colour vision, greyscale or a forced
 * palette. The words still carry it too: the row reads "moved — the element is
 * gone" and the aria-label says the same.
 *
 * What is LOST is the alarm: red made an orphan findable across a busy page in
 * a way that ring weight does not. That is a real cost and it is open — see
 * the note. --snag-anchor-orphan is unchanged and still paints the dock's
 * moved-text, the ghost pin and the armed deletes, none of which sit on a
 * status fill.
 */
function pinStyle(state: AnchorState, snag: Snag): string {
  // The ink is measured against the fill, and the RING is the
  // ink — never --snag-onAccent, which cannot know how light the fill is.
  const ink = statusInk(snag.status);
  const fill = `background:${statusVar(snag.status)};color:${ink}`;
  const drop = "0 1px 4px rgb(0 0 0 / .35)";
  if (state === "anchored") {
    return `${PIN_BASE};${SHAPE};${fill};border:2px solid ${ink};box-shadow:${drop}`;
  }
  if (state === "approximate") {
    return `${PIN_BASE};${SHAPE};${fill};border:2px dashed ${ink};box-shadow:${drop}`;
  }
  // Same silhouette, twice the ring: 2 px outside plus 2 px inset, both ink.
  return (
    `${PIN_BASE};${SHAPE};${fill};border:2px solid ${ink};` +
    `box-shadow:inset 0 0 0 2px ${ink},${drop}`
  );
}

/**
 * Which layer does this element belong in? (ported verbatim)
 *
 * Walks to the documentElement looking for any ancestor that decouples the
 * element from document flow. Roughly 10–30 `getComputedStyle` calls, done ONCE
 * at attach and never on the scroll path — the design is explicit that this runs
 * inside the batched read pass, because getComputedStyle is a read and must not
 * be interleaved with writes.
 */
function classify(el: Element, win: Window): { tier: "static" | "dynamic"; clips: Element[] } {
  const clips: Element[] = [];
  let tier: "static" | "dynamic" = "static";
  // Everything from here outwards is escaped by a `position:fixed` element:
  // fixed positioning is relative to the viewport, so an ancestor's overflow
  // does not clip it. (A transformed ancestor DOES re-capture it — that is why
  // the flag is cleared again below rather than ending the walk.)
  let escaped = false;
  for (let n: Element | null = el; n && n !== el.ownerDocument.documentElement; n = n.parentElement) {
    const cs = win.getComputedStyle(n);
    const clipsHere =
      n !== el.ownerDocument.body && /auto|scroll|hidden|overlay/.test(cs.overflowY + cs.overflowX);
    // EVERY clipping ancestor, not just the nearest: an inner panel scrolled
    // into view inside an outer one that has scrolled it away is clipped by the
    // OUTER box, and tracking only the nearest drew the pin on top of unrelated
    // content 218 px below where anything of the element was visible.
    // Whether or not it currently overflows — a box that fits today clips the
    // moment the page reflows narrower.
    if (clipsHere && !escaped) clips.push(n);

    if (cs.position === "fixed") {
      tier = "dynamic";
      escaped = true;
    } else if (cs.transform !== "none" || cs.filter !== "none" || cs.perspective !== "none") {
      tier = "dynamic";
      // A transform makes this element the containing block for fixed
      // descendants, so anything below is inside its clip again.
      escaped = false;
    } else if (cs.position === "sticky") tier = "dynamic";
    else if (cs.willChange.includes("transform") || cs.contain.includes("layout")) tier = "dynamic";
    else if (clipsHere && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) {
      tier = "dynamic";
    }
    // The walk always runs to the root: an element can be inside a transformed
    // wrapper AND a scroller further out, and it is every scroller between here
    // and the viewport that decides whether the pin can be seen.
  }
  return { tier, clips };
}

export interface PinLayer {
  readonly el: HTMLElement;
  /** `hidden` — ids the ACTIVE FILTER removes from the page. They
   *  stay in the array so numbering holds (pin 3 is still 3 when 1 and
   *  2 are hidden); their dots are simply not shown, and clusters skip them. */
  render(snags: Snag[], hidden?: ReadonlySet<string>): void;
  /** One pulse after the navigator lands — suppressed entirely
   *  under prefers-reduced-motion. */
  pulse(id: string): void;
  /** Place the ghost pin at `AnchorRecord.rect` — "Show anyway"'s
   *  draw half. Document-relative CSS px, origin-corrected like every static
   *  pin; cleared by the next render. */
  showGhost(snag: Snag): void;
  /** Re-resolve every anchor against the live DOM. Returns the updated snags.
   *  `optimistic` is the phase-1 rule: results may only improve; no pin may
   *  transition to orphaned, and unresolved pins render `pending`. */
  reanchor(snags: Snag[], phase?: "optimistic" | "navigating" | "authoritative"): Snag[];
  /** Are any pins holding .6's retry window? The runtime keeps a retry
   *  tick alive while true — "none stays in locating" needs a next trigger. */
  hasPending(): boolean;
  /**
   * What the LAST resolution pass concluded, per pin — the
   * `anchor:settled` payload, which is the only v0 way a host or the own
   * tooling can watch cascade quality without polling.
   *
   * Read after a pass rather than pushed during one, because `reanchor` runs on
   * every repaint — a mode switch, a resize — and firing an event per pin per
   * repaint is a firehose, not a signal. The runtime emits from the passes that
   * are actually resolutions: load, and navigation.
   */
  settled(): { id: string; state: AnchorState; strategy: string; confidence: number }[];
  /** Lift one pin — the dock calls this as rows are pointed at. */
  highlight(id: string | null): void;
  destroy(): void;
}

/**
 * The v0.1 extension hook. `get()` hands back `snag.anchor-ext.js`'s
 * resolver once it has arrived; `want(rec)` tells the runtime a record fell
 * through the resident cascade — the runtime decides whether the record's
 * facets justify fetching the chunk. Injected as an object so the pin layer
 * needs no knowledge of chunks, loading, or release maps.
 */
export interface ExtensionHook {
  get(): import("../anchor/resolve.ts").ExtendedResolver | null;
  want(rec: import("../anchor/types.ts").AnchorRecord): void;
  /** Both extension rungs are known-unreachable (a load already failed) — the
   *  retry window shortens and settles carry `budget-exceeded`. */
  unavailable?(): boolean;
  /** Fresh per-pass caches from the ext module — one index, every pin. */
  newPass?(): import("../anchor/ext.ts").PassCaches | undefined;
  /** The fuzzy chunk's settled resolution for a pin, if a pass found one. */
  fuzzyHit?(id: string): import("../anchor/types.ts").AnchorResolution | null;
  /** …and the request that gets one queued — a no-op until the chunk arrives. */
  wantFuzzy?(id: string, rec: import("../anchor/types.ts").AnchorRecord): void;
}

export function createPinLayer(
  root: ShadowRoot,
  onOpen?: (snag: Snag) => void,
  ext?: ExtensionHook,
  /** The >6 case: the cluster cannot fan out, so the sidebar opens
   *  filtered to it — and the pin layer has no dock handle, so the runtime
   *  wires this. */
  onClusterOverflow?: (ids: string[]) => void,
): PinLayer {
  const doc = root.ownerDocument ?? document;
  const win = doc.defaultView ?? window;

  adopt(root, "pins", PULSE_CSS);

  /** Document space — the browser moves these with the page, for free. */
  const el = doc.createElement("div");
  el.className = "snag-pins";
  el.style.cssText = DOC_CSS;
  root.appendChild(el);

  /** Viewport space — re-placed from a live rect on each sync. */
  const dynLayer = doc.createElement("div");
  dynLayer.className = "snag-pins-dyn";
  dynLayer.style.cssText = FIXED_CSS;
  root.appendChild(dynLayer);

  interface Placed {
    node: HTMLElement;
    el: Element;
    fx: number;
    fy: number;
    /**
     * EVERY ancestor that clips this element, innermost first.
     *
     * A dynamic pin follows its element's LIVE rect, and a rect does not know
     * it has been scrolled out of the box that contains it — the browser
     * happily reports coordinates far outside a scroller's clip. Found by
     * scrolling one: the element left the box, the pin followed it 240 px up
     * the page and sat over unrelated content, still drawn, still confident.
     * That is the anchoring lie in geometric form, and the answer is the same
     * one `corroboratesText` gives — say nothing rather than something false.
     */
    clips: Element[];
  }
  /** Viewport-space pins — re-placed on scroll as well as on reflow. */
  let tracked: Placed[] = [];
  /**
   * Document-space pins, kept with their LIVE element.
   *
   * They were placed once from the stored rect and never revisited, which is
   * the "silently wrong" case verbatim: a lazy image loading above the target
   * moved it 98 px, the pin stayed where it was, and its centre landed dead
   * inside a DIFFERENT button two rows up — still `anchored`, still titled
   * after the element it was no longer on. Cumulative layout shift is the most
   * ordinary thing a page does, and it fires neither scroll nor resize.
   *
   * They stay OFF the scroll path, though. Scrolling does not move an element
   * relative to the document, so a static pin has nothing to recompute — which
   * is the whole reason the tier exists. Only a REFLOW needs them re-placed.
   */
  let statics: Placed[] = [];
  /**
   * id → the element the last cascade actually resolved to.
   *
   * `render` needs the LIVE element, not the stored rect: whether a pin belongs
   * in the dynamic layer is a question about the element's ancestors right now,
   * and a rect saved yesterday cannot answer it.
   */
  const resolved = new Map<string, Element>();

  // id → dot, rebuilt on every render. Kept here rather than as a data-* on the
  // dot: the DoD is that a client's page carries no attributes of ours, and the
  // cheapest way to keep that true is not to invent new ones.
  let dots = new Map<string, HTMLElement>();
  let lifted: string | null = null;

  // ── Clustering state ─────────────────────────────────────
  // Everything below works in LAYER coordinates (document coords minus the
  // origin correction) and — the load-bearing decision — clustering runs in
  // DOCUMENT SPACE. Viewport-space clustering would need every static pin's
  // rect re-read on every scroll frame, dragging the majority tier onto the
  // scroll path the file's founding invariant keeps it off; document space
  // needs no read at all, because every position written is CACHED here at
  // the moment it is written. Dynamic pins' document positions change per
  // sync (that is what sticky means) and the recompute runs per sync, so
  // membership stays live either way.
  const layerPos = new Map<HTMLElement, { x: number; y: number }>();
  let meta = new Map<HTMLElement, { snag: Snag; ordinal: number }>();
  /** 24 px centres cluster; 32 on a coarse pointer — and the pin
   *  itself is 34/28, which the fan pitch follows. */
  const coarsePins = win.matchMedia?.("(pointer: coarse)").matches ?? false;
  const clusterT = coarsePins ? 32 : 24;
  const pinSz = coarsePins ? 34 : 28;
  /** Cluster dots, fan proxies and leader lines — rebuilt every recompute. */
  let clusterNodes: HTMLElement[] = [];
  /** The fanned-out cluster's signature (sorted member ids), or null. */
  let fanKey: string | null = null;
  let ghost: HTMLElement | null = null;

  /**
   * ORIGIN CORRECTION (v0).
   *
   * The pin layer is `position:absolute; top:0; left:0`, which resolves against
   * the initial containing block — the document origin — ONLY while no ancestor
   * is positioned. The moment a host page sets `body { position: relative }`,
   * that box becomes the containing block and EVERY pin is displaced by the
   * body's offset: silently, on every page, with every DOM assertion still
   * passing.
   *
   * It is not an exotic configuration. It is WordPress, Webflow, and a good
   * half of hand-rolled CSS. host.ts carried a comment accepting this as a
   * "known residual"; tags the correction v0 and it is one rect read.
   *
   * Measured at mount and re-measured on resize — never per frame. Scroll does
   * not move it: the offset is in document space, and adding the current scroll
   * back converts the viewport-relative rect into it.
   */
  let origin = { x: 0, y: 0 };
  function measureOrigin(): void {
    const win = doc.defaultView;
    const r = el.getBoundingClientRect();
    origin = { x: r.left + (win?.scrollX ?? 0), y: r.top + (win?.scrollY ?? 0) };
  }

  let lastPass: ReturnType<PinLayer["settled"]> = [];
  /**
   * The retry window: a pin that fails every step is NOT immediately
   * orphaned — it renders `pending`, joins this map, and is retried on each
   * subsequent trigger for 10 s / 5 attempts from first sight, then settles
   * to the best state any attempt produced. This is what makes lazy-loaded
   * content and slow route transitions work without user-visible flapping —
   * and the optimistic phase .2's two-phase navigation pass is the same
   * rule with the window pinned open.
   */
  const settling = new Map<string, { firstSeenAt: number; tries: number; best: AnchorResolution }>();
  /**
   * The window, and WHICH of its two bounds applies depends on whether a
   * navigation is in flight. That is not a detail — it is the whole rule.
   *
   * Two situations look identical from here: the element is not in the DOM.
   *
   *   1. A client router is still rendering the new route. Orphaning is WRONG;
   *      the grace exists precisely for this, and a pin that flaps orange
   *      on every navigation is unusable.
   *   2. Somebody deleted the element on a stable page. Orphaning is RIGHT and
   *      must be prompt — requires it without a reload, and an orphan
   *      the reviewer cannot see for six seconds is its own bug.
   *
   * `tries` counts reanchor passes, and a route render emits a burst of them
   * within milliseconds. Under case 1 that burst spent all five before the
   * element existed, and the sixth pass orphaned the page — a ten-second
   * promise collapsing to two hundred milliseconds on exactly the devices that
   * need it. It surfaced only under full-suite contention, which is what a
   * load-sensitive product bug looks like from outside.
   *
   * Removing the count instead was tried and is worse: it makes case 2 wait
   * out the full window, and four orphan specs said so within a minute.
   *
   * So the caller says which situation it is. During the navigation window the
   * hold is on TIME alone; outside it, the count still settles a real orphan
   * quickly. `optimistic` remains the phase 1, where nothing may orphan.
   */
  const RETRY_WINDOW_MS = 10_000;
  const MAX_RETRIES = 5;

  /**
   * The FAST PATH — the cost control that matters (v0).
   *
   * id → a weak handle on the element the last pass resolved to, plus the
   * strategy that found it. Weak, so holding it cannot keep a detached subtree
   * of the host's alive: a review session lasts hours, and a strong reference
   * per pin would make the widget a memory leak on any app that churns nodes.
   */
  const lastEl = new Map<string, { ref: WeakRef<Element>; strategy: string }>();

  /** Strategies the design calls authoritative — an explicit hook does not need
   *  corroborating, because that is the entire reason it is preferred. */
  const HOOK = new Set(["testid", "domid"]);

  /**
   * Is the element this pin resolved to LAST time still the right answer?
   *
   * Prints this, and the sentence that matters is: *"the full cascade
   * never runs for a pin that still hits its fast path."* Without it every
   * repaint ran a `querySelectorAll` per pin — and since the MutationObserver
   * landed, "every repaint" means every 120 ms on a page that is doing
   * anything. A React page with 40 pins re-rendering on hover paid 40 full
   * cascades for a DOM change that touched none of them.
   *
   * Cost: one `deref`, one `isConnected`, at most one `matches()` — the
   * ≤ 0.05 ms per pin. A re-render that REPLACES nodes kills `isConnected` and
   * pays a cascade, which is correct; one that preserves them pays nothing,
   * which is the common case.
   */
  function fastPath(s: Snag): Element | null {
    const last = lastEl.get(s.id);
    const el = last?.ref.deref();
    if (!el || !el.isConnected) return null;
    if (HOOK.has(last!.strategy)) return el;
    // The css check is what stops the fast path from being a lie: a framework
    // that reuses a node for different content leaves `isConnected` true while
    // the element is no longer the one the record describes.
    if (s.anchor.css) {
      try {
        if (!el.matches(s.anchor.css)) return null;
      } catch {
        // An invalid stored selector is a full-cascade problem, not a
        // fast-path one — fall through rather than throwing on every frame.
        return null;
      }
    }
    return el;
  }

  /**
   * The resolution a fast-path hit reports.
   *
   * The printed function short-circuits the SEARCH — deref, isConnected,
   * matches — and says nothing about the state, which is the trap: the full
   * cascade caps a not-rendered element to `approximate` (score ≤ 0.7), and a
   * fast path that skipped that check reported a confident `anchored` for an
   * element the page had just hidden.
   *
   * Caught by the WebKit project on the `display:none` test, and it is exactly
   * the failure the whole cascade exists to prevent: a pin claiming certainty it
   * has not earned. So the cheap path skips the LOOKUP and nothing else — every
   * honesty rule is re-applied against the element it found.
   */
  function cheapResolution(s: Snag, el: Element): AnchorResolution {
    const reasons: AnchorResolution["reasons"] = [];
    // THE SAME function the cascade uses — not a copy of its rules. Two
    // re-implementations of them went wrong in one afternoon: `display:none`
    // reported as `anchored`, then a positional selector that had drifted onto
    // the wrong element reported as `anchored`, which is the exact failure the
    // cascade exists to prevent.
    const score = assess(el, s.anchor, 1, reasons);
    return {
      element: el,
      strategy: lastEl.get(s.id)!.strategy as AnchorResolution["strategy"],
      score,
      state: stateFor(score),
      reasons: reasons.length ? reasons : ["exact"],
      candidates: 1,
    };
  }

  function reanchor(
    snags: Snag[],
    phase: "optimistic" | "navigating" | "authoritative" = "authoritative",
  ): Snag[] {
    resolved.clear();
    lastPass = [];
    const now = Date.now();
    // One caches object per PASS — never reused across passes (the
    // invalidation rule: a stale accessible name anchors the wrong element).
    const passCaches = ext?.newPass?.();
    return snags.map((s) => {
      // `extended` is INJECTED, never imported: the v0.1 steps live in
      // `snag.anchor-ext.js`, fetched by the runtime on the first fall-through
      // P8's claim that a happy-path session fetches neither anchor
      // chunk survives because a session whose every pin resolves resident
      // never calls `want()`.
      // The fast path first, and the full cascade only when it misses.
      // The synthesised resolution reports the strategy that ORIGINALLY found
      // the element rather than inventing one, so `settled()` and the dock
      // cannot tell a cheap pass from an expensive one — which is the point.
      const hit = fastPath(s);
      const extended = ext?.get();
      let res = hit ? cheapResolution(s, hit) : resolveAnchor(s.anchor, doc, {
        viewportWidth: doc.defaultView?.innerWidth ?? 0,
        ...(extended ? { extended } : {}),
        ...(passCaches ? { passCaches } : {}),
      });
      // A DRIFTED fast-path hit must not lock the pin onto the wrong element
      // pass after pass: the cheap path short-circuits the SEARCH, and a
      // search that would now do better (the ext chunk arrived since last
      // pass) has to be allowed to run. Without this, the first drifted pass
      // caches the wrong element and the fast path re-confirms it forever.
      if (hit && res.reasons.includes("text-drift")) {
        const full = resolveAnchor(s.anchor, doc, {
          viewportWidth: doc.defaultView?.innerWidth ?? 0,
          ...(extended ? { extended } : {}),
          ...(passCaches ? { passCaches } : {}),
        });
        if (full.score > res.score) res = full;
      }
      // An outright miss OR a drifted structural hit both justify the fetch:
      // drift is precisely the case where an extended step can replace a
      // wrong-element approximate with a right-element anchor (corpus A5).
      if (ext && (!res.element || res.reasons.includes("text-drift"))) ext.want(s.anchor);
      // Still nothing, and the record carries a searchable quote: the FUZZY
      // rung. A settled hit from an earlier pass replaces the orphan;
      // otherwise the pin is queued and the orphan stands until a pass lands —
      // pending-but-honest, never blocking, never a guess (the budgets).
      if (!res.element && ext) {
        const f = ext.fuzzyHit?.(s.id);
        if (f) res = f;
        else ext.wantFuzzy?.(s.id, s.anchor);
      }
      // …and a WEAK structural guess does not lock the words out (the
      // drift lesson, one rung lower). Two shapes qualify: a DRIFTED hit (a
      // positional selector matched something whose text disagrees — capped
      // 0.5, wrong element, warning sticker) and a sub-0.5 path-rect (a
      // structural coin-toss on a shuffled list, corroborated just past the
      // approximate floor by template-similar text). Both stand only until
      // the quote weighs in: the BETTER score wins, ties keep the structural
      // answer, and a record with no searchable quote changes nothing.
      const weakGuess =
        res.element &&
        s.anchor.text?.exact &&
        (res.reasons.includes("text-drift") || (res.strategy === "path-rect" && res.score < 0.5));
      if (ext && weakGuess) {
        const f = ext.fuzzyHit?.(s.id);
        if (f && f.score > res.score) res = f;
        else if (!f) ext.wantFuzzy?.(s.id, s.anchor);
      }
      // Remember what this pass settled on, for the next one's fast path.
      if (res.element) lastEl.set(s.id, { ref: new WeakRef(res.element), strategy: res.strategy });
      else lastEl.delete(s.id);
      // Where the element still exists AND is rendered, trust the LIVE rect over
      // the stored one: the page may have reflowed, and a stale rect would place
      // the pin confidently in the wrong place — the visual form of a silent lie.
      //
      // "AND is rendered" is load-bearing. A `display:none` element measures
      // 0×0 at 0,0, so adopting its rect teleports the pin to the top-left
      // corner of the document and states that position with total confidence.
      // The stored rect is imperfect but honest: it is where the thing was when
      // somebody pointed at it. Found by looking at a screenshot — the pin sat
      // in the page corner while every assertion passed, which is the same
      // failure mode as the HOST_CSS origin bug.
      if (res.element) resolved.set(s.id, res.element);

      /**
       * SETTLE OR HOLD (phase rules + the window). A hit settles and
       * clears any retry entry. A miss holds as `pending` while the phase is
       * optimistic (no pin may transition to orphaned there — a client router
       * renders the new route asynchronously and a sync at +100 ms would
       * orphan the entire page) or while the retry window is open; then it
       * settles to the best state any attempt produced. With the extension
       * rungs UNAVAILABLE the window shortens to two tries — nothing further
       * is coming, and requires settlement within two cycles on the
       * resident core alone — and the settle carries `budget-exceeded` so the
       * detail view can say which steps never ran (F-04b).
       */
      let pending = false;
      if (res.state === "orphaned") {
        const e = settling.get(s.id) ?? { firstSeenAt: now, tries: 0, best: res };
        e.tries++;
        if (res.score >= e.best.score) e.best = res;
        settling.set(s.id, e);
        const failed = ext?.unavailable?.() ?? false;
        const cap = failed ? 2 : MAX_RETRIES;
        const withinWindow = now - e.firstSeenAt < RETRY_WINDOW_MS;
        if (
          phase === "optimistic" ||
          (withinWindow && (phase === "navigating" || e.tries < cap))
        ) {
          pending = true;
        } else {
          res = e.best;
          if (failed && !res.reasons.includes("budget-exceeded")) {
            res = { ...res, reasons: [...res.reasons, "budget-exceeded"] };
          }
          settling.delete(s.id);
        }
      } else {
        settling.delete(s.id);
      }
      // `pending` never leaves the browser: not an event, not a write.
      if (!pending) {
        lastPass.push({ id: s.id, state: res.state, strategy: res.strategy, confidence: res.score });
      }
      const r = res.element ? rectOf(res.element) : undefined;
      if (r && (r.width > 0 || r.height > 0)) {
        const win = doc.defaultView;
        s.anchor.rect = {
          x: r.left + (win?.scrollX ?? 0),
          y: r.top + (win?.scrollY ?? 0),
          w: r.width,
          h: r.height,
        };
      }
      return {
        ...s,
        // A pending pin keeps its LAST SETTLED persisted state underneath —
        // the flap the window exists to prevent is exactly a transient write.
        anchorState: pending ? s.anchorState : res.state,
        anchorPending: pending,
        anchorReasons: res.reasons,
      };
    });
  }

/**
   * Keep a pin inside the page.
   *
   * The design says "clamped so the pin stays ≥ 14 px inside the viewport", and in the
   * same breath that "pins are positioned in DOCUMENT coordinates … so ordinary
   * scrolling costs zero JavaScript". Taken literally those fight: a
   * viewport-relative clamp has to be recomputed on every scroll, which is the
   * one cost the document-coordinate design exists to avoid.
   *
   * Clamping to the DOCUMENT's reachable box satisfies both, because the two
   * coincide exactly where it matters. On a page with no horizontal overflow —
   * which is every responsive page at 375 px, the width names
   * `scrollWidth` IS the viewport width, so a pin on an element that overhangs
   * gets pulled back on screen. On a page that genuinely scrolls sideways, the
   * pin lands somewhere the reviewer can still reach. Neither needs a scroll
   * listener.
   *
   * Without it, an element wider than the viewport put its pin off the right
   * edge with no way to reach it — the comment was in the list and invisible on
   * the page.
   */
  /**
   * The document's reachable box, measured ONCE per pass.
   *
   * `clamp` used to read `scrollWidth`/`scrollHeight` itself, which put two
   * layout-flushing reads inside `sync()`'s WRITE pass: each iteration wrote a
   * pin's style and the next one flushed it, so N static pins cost N forced
   * synchronous layouts per frame on the path budgets at ≤ 4 ms for
   * all of them together. The design names the rule this broke: "strict read/write
   * separation is the whole trick".
   */
  function reach(): { w: number; h: number } {
    const de = doc.documentElement;
    return { w: de.scrollWidth, h: de.scrollHeight };
  }

  function clamp(x: number, y: number, box: { w: number; h: number }): { x: number; y: number } {
    const M = 14; // The margin, and half a pin's width either side of it
    return {
      x: Math.min(Math.max(x, M), Math.max(box.w, M * 2) - M),
      y: Math.min(Math.max(y, M), Math.max(box.h, M * 2) - M),
    };
  }

  function render(snags: Snag[], filteredOut?: ReadonlySet<string>): void {
    // Before any position is written, not after: a stale origin places every
    // pin in this pass and corrects them only on the next one.
    measureOrigin();
    el.textContent = "";
    dynLayer.textContent = "";
    tracked = [];
    statics = [];
    dots = new Map();
    meta = new Map();
    layerPos.clear();
    clusterNodes = [];
    ghost = null; // el was just cleared; the ghost went with it
    snags.forEach((s, i) => {
      const r = s.anchor.rect;
      if (!r) return;
      const o = s.anchor.offset ?? { fx: 0.5, fy: 0.5 };
      const dot = doc.createElement("div");
      dot.className = "snag-pin";
      // `pending` shows as data-state so the suite can assert none REMAIN so;
      // visually it borrows the approximate look, dimmed — a held judgement,
      // not a verdict, and never the persisted state underneath.
      dot.setAttribute("data-state", s.anchorPending ? "pending" : s.anchorState);
      dot.setAttribute("data-key", s.key);
      dot.style.cssText = s.anchorPending
        ? `${pinStyle("approximate", s)};opacity:.55`
        : pinStyle(s.anchorState, s);
      // WHICH LAYER. Resolved live where we can — a stored rect cannot tell us
      // whether the element sits under a sticky ancestor today.
      const live = resolved.get(s.id);
      const { tier, clips } = live ? classify(live, win) : { tier: "static" as const, clips: [] };
      if (tier === "dynamic" && live) {
        const vr = live.getBoundingClientRect();
        const dl = dynOrigin();
        dot.style.left = `${vr.left - dl.left + vr.width * o.fx}px`;
        dot.style.top = `${vr.top - dl.top + vr.height * o.fy}px`;
        layerPos.set(dot, {
          x: vr.left + vr.width * o.fx + win.scrollX - origin.x,
          y: vr.top + vr.height * o.fy + win.scrollY - origin.y,
        });
        const placed = { node: dot, el: live, fx: o.fx, fy: o.fy, clips };
        tracked.push(placed);
        dot.hidden = !isRendered(live);
        if (!dot.hidden) {
          showIfVisible(placed, vr, new Map(clips.map((c) => [c, c.getBoundingClientRect()])));
        }
      } else {
        // Document coordinates, minus wherever our own layer actually starts.
        const at = clamp(r.x + r.w * o.fx - origin.x, r.y + r.h * o.fy - origin.y, reach());
        dot.style.left = `${at.x}px`;
        dot.style.top = `${at.y}px`;
        layerPos.set(dot, at);
        if (live) {
          statics.push({ node: dot, el: live, fx: o.fx, fy: o.fy, clips: [] });
          dot.hidden = !isRendered(live);
        }
      }
      // Numbering is by position in the list and stays stable under filtering,
      // so people can say "snag 3" mid-review and mean the same thing.
      dot.textContent = String(i + 1);
      // A `title` is not reliably announced, so the same fact goes in the
      // accessible name too — which is how the three states stay
      // distinguishable without sight of the rings that distinguish them.
      const where = whereText(s);
      // The sentence: the element in WORDS (role + accessible
      // name), because no IDREF can reach it across the shadow boundary.
      // Falls back to the stored label when the cascade recorded no role.
      const target = s.anchor.role
        ? format("pin.target", { role: s.anchor.role, name: s.anchor.accessibleName ?? s.anchor.label })
        : s.anchor.label;
      const replies = s.comments.length - 1;
      // The design puts a `~` prefix in the approximate pin's accessible name. It
      // marks the IDENTIFIER rather than opening the sentence — a glyph pinned
      // to `SN-4`, not a fragment glued to a translatable string.
      const key = s.anchorState === "approximate" ? `~ ${s.key}` : s.key;
      dot.setAttribute("role", "button");
      dot.setAttribute("tabindex", "0");
      const name =
        s.anchorState === "anchored"
          ? format(replies === 0 ? "pin.aria.none" : replies === 1 ? "pin.aria.one" : "pin.aria", {
              key,
              target,
              status: statusLabel(s.status),
              replies,
            })
          : format("pin.aria.moved", { key, target, status: statusLabel(s.status), where });
      // The tooltip IS the accessible name — one sentence, one source. They
      // used to be two keys saying overlapping things, and the title was the
      // one that could go stale.
      dot.title = name;
      dot.setAttribute("aria-label", name);
      // Space must not scroll the host page — onPress preventDefaults it.
      if (onOpen) onPress(dot, () => onOpen(s));
      // A status/read/by/page filter takes the pin OFF the page.
      // Marked as well as hidden, because sync()'s pass 2 un-hides any dot
      // whose element renders — the mark is what it checks first.
      if (filteredOut?.has(s.id)) {
        dot.hidden = true;
        dot.setAttribute("data-fo", "");
      }
      dots.set(s.id, dot);
      meta.set(dot, { snag: s, ordinal: i + 1 });
      (tier === "dynamic" ? dynLayer : el).appendChild(dot);
    });
    // Directly, not only via the sync below: on an all-static page sync()
    // returns before its rAF (nothing tracked), and the clusters must exist
    // the moment the pins do.
    recomputeClusters();
    // A re-render replaces every node, so re-apply whatever was lifted.
    if (lifted) highlight(lifted);
    // The pins were placed from rects read during this pass; a sync now costs
    // nothing extra and covers anything that moved between the cascade and the
    // paint. The net only runs while there is something to watch.
    sync();
    lastProbe = "";
    net(doc.visibilityState === "visible" && dots.size > 0);
  }

  /**
   * Re-place the dynamic pins from live rects.
   *
   * ONE rAF for the whole set, and reads before writes: interleaving a rect
   * read with a style write forces a synchronous layout PER PIN, which on a
   * scroll handler is the difference between smooth and visibly juddering.
   *
   * Static pins are deliberately absent from this loop. They are the majority
   * and they cost nothing — the browser already moves them with the page.
   */
  /**
   * Where the FIXED layer actually starts — which is not always (0,0).
   *
   * `position: fixed` is anchored to the viewport only while no ancestor is a
   * containing block for it. A `transform`, `filter`, `perspective` or
   * `will-change: transform` on `<body>` makes the body that containing block,
   * and the layer silently starts scrolling with the document while the rects
   * written into it stay viewport-relative. The error is exactly `scrollY`,
   * unbounded and growing — measured at 840 px after one scroll, and 8 690 px
   * on a long page, all three engines, every pin reading `anchored`.
   *
   * Three things make it worse than it sounds. `will-change: transform` has NO
   * visual effect on the page, so nothing about it looks like a cause. An
   * off-canvas push drawer — `body { transform: translateX(280px) }` — puts the
   * pin 253 px off THE INSTANT IT IS PLACED, with no scrolling at all. And
   * classify() sees that same body transform on every ancestor walk, so on such
   * a page EVERY element routes to this layer: not one wrong pin, all of them.
   *
   * This is the dynamic layer's counterpart to measureOrigin(), and it
   * self-corrects: untrapped, the rect is (0,0) and the arithmetic is
   * unchanged. It is read per frame rather than at mount because a drawer
   * toggles the transform at runtime.
   */
  const dynOrigin = (): { left: number; top: number } => dynLayer.getBoundingClientRect();

  let framePending = false;
  /**
   * @param reflow the page's LAYOUT changed, not just its scroll offset — so
   *        the document-space pins need re-placing too.
   */
  /**
   * Draw a dynamic pin only where its element can actually be seen.
   *
   * The design asks for a clamp — "the pin stays ≥ 14 px inside the viewport"
   * and a clamp is the wrong instrument HERE. Dragging a pin to the edge of the
   * screen when its element has scrolled out of a carousel puts it on top of
   * something it is not about, which is worse than not drawing it: the reviewer
   * reads a confident mark against the wrong content. The document-space clamp
   * still applies to static pins, where "off screen" means "further down the
   * page" and the clamp genuinely brings something reachable back.
   *
   * A hidden pin is not a lost one. Every snag is in the dock's list whatever
   * its pin is doing, and opening it there scrolls the element back into view —
   * which is the affordance the clamp was reaching for.
   */
  function showIfVisible(t: Placed, er: DOMRect, rects: Map<Element, DOMRect>): void {
    // A 0×0 rect means the element is not rendered — `display:none`, or removed
    // from the flow. A DYNAMIC pin cannot keep its last position through that:
    // it is placed in VIEWPORT space, so "stay where you were" glues it to the
    // screen and it follows the reviewer down the page, still `anchored`, over
    // whatever happens to be under it. Nothing recovers it either, because
    // `display:none` fires no scroll and may leave the document height
    // unchanged. The static tier keeps its last position on purpose — that one
    // is in document space and scrolls away honestly with the page.
    // The contract: the ANCHOR RECT is intersected with every
    // clipping scroller's client rect, and area 0 hides the pin. Rect-area-0
    // is a strictly LATER trigger than the old centre±14px test, so the
    // anti-flicker property that tolerance bought improves rather than
    // degrades: a pin half out of its carousel still belongs to it, and only
    // an element with not one visible pixel takes its pin away.
    for (const c of t.clips) {
      const cr = rects.get(c);
      if (!cr) continue;
      if (er.right <= cr.left || er.left >= cr.right || er.bottom <= cr.top || er.top >= cr.bottom) {
        t.node.hidden = true;
        return;
      }
    }
    t.node.hidden = false;
  }

  /**
   * Clip rects for a whole pass, measured ONCE per clipping element.
   *
   * Both halves matter. Measuring in the read pass keeps `sync`'s reads and
   * writes separated — this file's whole position story depends on that, and a
   * `getBoundingClientRect` after a style write forces a synchronous layout per
   * pin. And deduping by element is what stops twenty pins inside one carousel
   * measuring the same carousel twenty times.
   */
  function clipRects(set: Placed[]): Map<Element, DOMRect> {
    const out = new Map<Element, DOMRect>();
    for (const t of set) {
      for (const c of t.clips) if (!out.has(c)) out.set(c, c.getBoundingClientRect());
    }
    return out;
  }

  const STATUS_PRIORITY = ["open", "progress", "review", "resolved"] as const;

  /** click + Enter/Space, the pattern every actionable dot repeats. */
  function onPress(n: HTMLElement, fn: () => void): void {
    n.addEventListener("click", fn);
    n.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      fn();
    });
  }

  function drawClusterDot(
    ms: { dot: HTMLElement; snag: Snag; ordinal: number; x: number; y: number }[],
    cx: number,
    cy: number,
    key: string,
    fanned: boolean,
  ): void {
    const status = STATUS_PRIORITY.find((st) => ms.some((m) => m.snag.status === st)) ?? "open";
    const c = doc.createElement("div");
    c.className = "snag-pin snag-cluster";
    // The ONE sanctioned non-teardrop silhouette.
    c.style.cssText =
      `${PIN_BASE};border-radius:50%;background:${statusVar(status)};` +
      `color:${statusInk(status)};border:2px solid ${t.onAccent}`;
    c.style.left = `${cx}px`;
    c.style.top = `${cy}px`;
    c.textContent = String(ms.length);
    c.setAttribute("data-count", String(ms.length));
    c.setAttribute("data-state", status);
    c.setAttribute("role", "button");
    c.setAttribute("tabindex", "0");
    if (fanned) c.setAttribute("aria-expanded", "true");
    c.setAttribute(
      "aria-label",
      format("cluster.aria", { n: ms.length, list: ms.map((m) => m.ordinal).join(", ") }),
    );
    onPress(c, () => {
      if (fanned) {
        fanKey = null; // collapse
      } else if (ms.length <= 6) {
        fanKey = key; // ≤6 fans out in place
      } else {
        onClusterOverflow?.(ms.map((m) => m.snag.id)); // >6 opens the sidebar
        return;
      }
      recomputeClusters();
    });
    el.appendChild(c);
    clusterNodes.push(c);
  }

  function drawFan(ms: { dot: HTMLElement; snag: Snag; ordinal: number; x: number; y: number }[], cx: number, cy: number, key: string): void {
    // The cluster dot STAYS, expanded — it is the collapse control, and a fan
    // with no way back reads as pins that multiplied.
    drawClusterDot(ms, cx, cy, key, true);
    ms.forEach((m, idx) => {
      const fx = cx;
      const fy = cy + (idx + 1) * (pinSz + 12); // dot + 12 px spacing
      // Leader line first, under the dots: from the fan position back to
      // where the pin genuinely is.
      const dx = m.x - fx;
      const dy = m.y - fy;
      const len = Math.hypot(dx, dy);
      if (len > 4) {
        const line = doc.createElement("div");
        line.className = "snag-leader";
        line.setAttribute("aria-hidden", "true");
        // No pointer-events:none needed — the doc layer's own `none` already
        // makes anything without an explicit auto unclickable.
        line.style.cssText =
          `position:absolute;left:${fx}px;top:${fy}px;width:${len}px;height:0;` +
          `border-top:1px solid ${t.onAccent};transform-origin:0 0;` +
          `transform:rotate(${Math.atan2(dy, dx)}rad)`;
        el.appendChild(line);
        clusterNodes.push(line);
      }
      // The member, drawn AT the fan position as a proxy — the real dot keeps
      // its true coordinates and its tier, so the next sync never has to know
      // a fan exists.
      const proxy = m.dot.cloneNode(true) as HTMLElement;
      proxy.style.visibility = "";
      proxy.style.left = `${fx}px`;
      proxy.style.top = `${fy}px`;
      onPress(proxy, () => onOpen?.(m.snag));
      el.appendChild(proxy);
      clusterNodes.push(proxy);
    });
  }

  /**
   * The per-pass recompute ("recomputed on every sync"). Positions
   * come from `layerPos` — CACHED at write time — so this performs ZERO
   * layout reads. Instrumentation rides the layer element as data-cv
   * (cluster visits), data-cp (pins considered) and data-ms (sync cost) —
   * short on purpose, they ship eager — where the suite reads them without
   * an API surface the spec never minted.
   */
  function recomputeClusters(): void {
    for (const n of clusterNodes) n.remove();
    clusterNodes = [];
    const entries: { dot: HTMLElement; snag: Snag; ordinal: number; x: number; y: number }[] = [];
    for (const [dot, m] of meta) {
      if (dot.hidden) {
        dot.style.visibility = "";
        continue; // a pin that is not on the page cannot overlap anything
      }
      const pos = layerPos.get(dot);
      if (!pos) continue;
      entries.push({ dot, snag: m.snag, ordinal: m.ordinal, x: pos.x, y: pos.y });
    }
    const { members, visits } = clusterPoints(entries, clusterT);
    el.setAttribute("data-cv", String(visits));
    el.setAttribute("data-cp", String(entries.length));
    let fanAlive = false;
    for (const g of members) {
      if (g.length < 2) {
        entries[g[0]!]!.dot.style.visibility = "";
        continue;
      }
      const ms = g.map((i) => entries[i]!);
      const key = ms.map((m) => m.snag.id).sort().join("|");
      for (const m of ms) m.dot.style.visibility = "hidden";
      const cx = ms.reduce((a, m) => a + m.x, 0) / ms.length;
      const cy = ms.reduce((a, m) => a + m.y, 0) / ms.length;
      if (fanKey === key && ms.length <= 6) {
        fanAlive = true;
        drawFan(ms, cx, cy, key);
      } else {
        drawClusterDot(ms, cx, cy, key, false);
      }
    }
    if (fanKey && !fanAlive) fanKey = null; // membership changed under it
  }

  function showGhost(snag: Snag): void {
    ghost?.remove();
    ghost = null;
    const r = snag.anchor.rect;
    if (!r) return;
    const o = snag.anchor.offset ?? { fx: 0.5, fy: 0.5 };
    const g = doc.createElement("div");
    g.className = "snag-pin snag-ghost";
    // Hollow and dashed: a recorded position, not a live claim — the design
    // fixes `rect` as document-relative, and the origin correction applies
    // to it exactly as to every static pin.
    g.style.cssText =
      `${PIN_BASE};${SHAPE};background:transparent;border:2px dashed ${t.anchorOrphan};` +
      `color:${t.anchorOrphan};box-shadow:none;pointer-events:none`; // ghost stays inert over live UI
    const at = clamp(r.x + r.w * o.fx - origin.x, r.y + r.h * o.fy - origin.y, reach());
    g.style.left = `${at.x}px`;
    g.style.top = `${at.y}px`;
    g.setAttribute("aria-hidden", "true");
    el.appendChild(g);
    ghost = g;
  }

  function sync(reflow = false): void {
    const set = reflow ? [...tracked, ...statics] : tracked;
    if (framePending || set.length === 0) return;
    framePending = true;
    win.requestAnimationFrame(() => {
      framePending = false;
      const t0 = performance.now();
      const sx = win.scrollX;
      const sy = win.scrollY;
      // PASS 1 — reads only. The layer's own rect belongs here too: it is one
      // more read alongside the ones already being taken, so it costs no extra
      // layout, and taking it in the write pass would break the batching.
      const dl = dynOrigin();
      const rects = set.map((t) => (t.el.isConnected ? t.el.getBoundingClientRect() : null));
      // RENDERED is not the same question as MEASURED, and the difference is a
      // collapsed `<details>`: its content gets `content-visibility: hidden`,
      // which keeps the box — the element still measures 152×41 while being
      // completely unpainted. A rect test says "there", so the pin was drawn on
      // top of the collapsed section, over whatever the page shows instead.
      // Read here, in pass 1, because checkVisibility is layout-dependent.
      const shown = set.map((t) => t.el.isConnected && isRendered(t.el));
      const clips = clipRects(set);
      const box = reach();
      // PASS 2 — writes only.
      set.forEach((t, i) => {
        const r = rects[i];
        if (!r) return; // gone since the last cascade; the next refresh re-anchors it
        // A HIDDEN element measures 0×0 at 0,0, so adopting its rect teleports
        // the pin to the document's top-left corner and states that position
        // with total confidence. The same guard reanchor() carries — this loop
        // is a second door into the same failure, and it walked straight
        // through it until the test caught it.
        //
        // The two tiers part company here. A STATIC pin keeps its last known
        // position, which is imperfect but honest: it is in document space, so
        // it is where the thing was when somebody pointed at it and it scrolls
        // away with the page. A DYNAMIC pin cannot — its position is in
        // VIEWPORT space, so keeping it glues the pin to the screen and it
        // follows the reviewer down the page, over whatever is beneath it,
        // still saying `anchored`. That one hides, via showIfVisible.
        if (t.node.hasAttribute("data-fo")) {
          t.node.hidden = true;
          return;
        }
        if (!shown[i]) {
          // BOTH TIERS. The static tier's "keep the last known position" is for
          // an element that MOVED — it is in document space and scrolls away
          // honestly with the page. An element that is not rendered at all has
          // no honest position to keep, and drawing one is the same lie in a
          // different costume.
          t.node.hidden = true;
          return;
        }
        t.node.hidden = false;
        const x = r.left + r.width * t.fx;
        const y = r.top + r.height * t.fy;
        if (t.node.parentElement === dynLayer) {
          t.node.style.left = `${x - dl.left}px`;
          t.node.style.top = `${y - dl.top}px`;
          showIfVisible(t, r, clips);
          layerPos.set(t.node, { x: x + sx - origin.x, y: y + sy - origin.y });
        } else {
          // Viewport rect back into document space, then the same clamp.
          const at = clamp(x + sx - origin.x, y + sy - origin.y, box);
          t.node.style.left = `${at.x}px`;
          t.node.style.top = `${at.y}px`;
          layerPos.set(t.node, at);
        }
      });
      // Recomputed on EVERY sync — from cached positions, zero reads.
      recomputeClusters();
      // The frame's cost, where the suite can read it (the 4 ms
      // budget is the DoD); our own shadow DOM, so no host-page attribute.
      el.setAttribute("data-ms", (performance.now() - t0).toFixed(2));
    });
  }

  /**
   * Scroll is CAPTURE-phase and passive, so a nested `overflow:auto` panel
   * scrolling reaches us — those events do not bubble to the window, which is
   * why a pin inside a scrolling panel never moved before.
   */
  const onScroll = (): void => sync();
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });

  /**
   * REFLOW, which is a different event from scroll and from resize.
   *
   * A lazy image getting its intrinsic size, a consent bar arriving, an
   * accordion opening — every one moves the content below it and fires neither.
   * A ResizeObserver on the documentElement catches the ones that change the
   * document's HEIGHT, which is most of them and costs almost nothing.
   */
  const ro =
    typeof win.ResizeObserver === "function"
      ? new win.ResizeObserver(() => sync(true))
      : null;
  ro?.observe(doc.documentElement);

  /**
   * …and the net under the rest.
   *
   * A reflow that does not change the document's height — a tab swapping
   * panels, a drawer opening while something else collapses — produces no
   * ResizeObserver callback at all, and the pin below it stays put. Measured:
   * still 38 px off, still `anchored`, centred on the neighbouring button.
   *
   * So a slow poll compares one rect and syncs only when it moved. Bounded on
   * purpose: it runs only while pins exist and only while the tab is visible,
   * because a timer on a backgrounded tab is somebody else's battery.
   */
  let netTimer: ReturnType<typeof setTimeout> | null = null;
  let lastProbe = "";
  function probe(): void {
    // EVERY tracked element, not the first one. A net-zero reflow moves the
    // pins BELOW it and leaves everything above untouched — which is the whole
    // situation this poll exists for — so probing one element asked exactly the
    // pin least likely to have moved. Measured: two pins either side of a
    // 0→120 / 120→0 swap, the second one 110 px off its element, `anchored`,
    // and still there minutes later because the first never moved.
    //
    // One rect read per pin every 500 ms is affordable precisely because it is
    // reads only: no writes follow unless the key changed, so a page at rest
    // costs one batched layout read and nothing else.
    //
    // NOT COVERED BY AN E2E TEST, and said out loud rather than left implied.
    // Two fixtures were written for it and both passed against the one-element
    // version, because something else in the page re-synced before the poll
    // mattered — and a test that passes against the defect it was written for
    // is worse than no test, which this file has learned once already. The
    // single-pin case IS covered ("…and a SAME-HEIGHT reflow, which no observer
    // reports, is caught too"); what is unproven is the pin that is not first.
    let key = "";
    for (const t of [...statics, ...tracked]) {
      if (!t.el.isConnected) continue;
      const r = t.el.getBoundingClientRect();
      key += `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)};`;
    }
    if (!key || key === lastProbe) return;
    lastProbe = key;
    sync(true);
  }
  /**
   * A SELF-CANCELLING `setTimeout` CHAIN, not an interval.
   *
   * The design forbids `setInterval` by name and spells out the same
   * requirement again — "a self-cancelling setTimeout chain runs a read-only
   * pass every 500 ms" — and the rule's own justification is that the widget
   * must leave no unbounded timer on a client's page. An interval also keeps
   * queuing while a slow probe is still running; a chain cannot overlap itself.
   */
  function net(on: boolean): void {
    if (netTimer) clearTimeout(netTimer);
    netTimer = null;
    if (!on) return;
    const tick = (): void => {
      probe();
      // Re-armed from INSIDE the callback, so the chain ends the moment nobody
      // re-arms it — which is what "self-cancelling" buys over an interval.
      netTimer = setTimeout(tick, 500);
    };
    netTimer = setTimeout(tick, 500);
  }
  const onVisibility = (): void => net(doc.visibilityState === "visible" && dots.size > 0);
  doc.addEventListener("visibilitychange", onVisibility);

  /**
   * The arrival feedback: pulse ONCE after the navigator's
   * scroll settles. A class + adopted keyframes rather than inline style,
   * because reduced motion must yield literally zero animations — the
   * DoD reads getAnimations().length === 0, and `animation: none` under the
   * media query is what makes that true by construction.
   */
  function pulse(id: string): void {
    const dot = dots.get(id);
    if (!dot) return;
    dot.classList.remove("snag-pp");
    // Reflow-free restart: toggling in the same frame never re-triggers.
    void win.requestAnimationFrame(() => dot.classList.add("snag-pp"));
    win.setTimeout(() => dot.classList.remove("snag-pp"), 1400);
  }

  function highlight(id: string | null): void {
    const prev = lifted ? dots.get(lifted) : undefined;
    if (prev) {
      prev.style.transform = "";
      prev.style.zIndex = "";
    }
    lifted = id;
    const next = id ? dots.get(id) : undefined;
    if (next) {
      next.style.transform = "scale(1.4)";
      next.style.zIndex = "1";
    }
  }

  return {
    el,
    render,
    showGhost,
    pulse,
    reanchor,
    settled: () => lastPass,
    hasPending: () => settling.size > 0,
    highlight,
    destroy() {
      doc.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      doc.removeEventListener("visibilitychange", onVisibility);
      ro?.disconnect();
      net(false);
      el.remove();
      dynLayer.remove();
    },
  };
}

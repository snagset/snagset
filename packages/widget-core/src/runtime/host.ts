import { widgetAttr } from "@snagset/types/names";

/**
 * The single shadow host — the only node Snagset adds to the page (A3).
 *
 * ⚠️ NO `contain` PROPERTY, EVER. Layout or paint containment establishes a
 * containing block for `position: fixed` descendants, which collapses the widget's
 * fixed UI against the 0×0 host box and makes it invisible on one of two supported
 * stacking paths. Isolation comes from position + zero size + pointer-events, which
 * is all A3 requires. The `.snag-ui` panel roots MAY use `contain: layout style`
 * (with a lint forbidding `position: fixed` inside them) — the host may not.
 * Design makes this a literal-string DoD, asserted in host.test.
 */
export const HOST_CSS =
  "position:absolute!important;top:0!important;left:0!important;" +
  "width:0!important;height:0!important;margin:0!important;padding:0!important;" +
  "border:0!important;pointer-events:none!important;" +
  "z-index:2147483647;isolation:isolate;color-scheme:light dark;";
// `!important` on the load-bearing properties: the host is styled
// inline so a host-page rule matching `div` cannot beat it — but a host rule
// that ALSO uses `!important` would, and one of these going missing is invisible
// until the widget is mounted on the one site that does it.
//
// `color-scheme:light dark` is what makes native controls and scrollbars INSIDE
// our UI follow the theme; `isolation:isolate` gives us a stacking context
// without a containing block (unlike `contain`, `transform` or `filter`, which
// would collapse the fixed layer — see above).
//
// `top:0;left:0` is LOAD-BEARING, not tidiness. Without it the host takes its
// static position — it is appended last, so that is near the bottom of the page
// — and every document-coordinate pin is offset by that distance. The pins were
// rendering off-screen while every DOM assertion passed; only a screenshot
// showed it. With no positioned ancestor, an absolutely positioned element at
// 0,0 resolves against the initial containing block, i.e. the document origin.
// A host page with `body{position:relative}` DOES shift that containing block,
// and this comment used to say v0 accepted it. Tags the correction v0
// and it is one rect read — pins.ts measures the layer's real origin at mount
// and on resize and subtracts it. WordPress, Webflow and half of hand-rolled
// CSS set that property, so "accepted" meant every pin on those pages was
// displaced by the body's offset, silently.

/**
 * Does this element create a containing block for `position: fixed`
 * descendants? — the first failure row.
 *
 * `transform`, `filter`, `backdrop-filter`, `perspective`, `will-change` naming
 * any of those, `contain: paint|layout|strict|content`, and `container-type`.
 * Any one of them turns our fixed toolbar, shield, notice and composer into
 * elements positioned against THAT box rather than the viewport — so they drift
 * on scroll, and on a page tall enough they leave the screen entirely.
 *
 * It is not exotic. `body { transform: translateX(280px) }` is how a large
 * fraction of off-canvas navigation drawers are built, and a page-transition
 * wrapper does the same thing for the length of the animation.
 */
function trapsFixed(el: Element): boolean {
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!cs) return false;
  return (
    (cs.transform !== "none" && cs.transform !== "") ||
    (cs.filter !== "none" && cs.filter !== "") ||
    (cs.perspective !== "none" && cs.perspective !== "") ||
    /transform|filter|perspective|contain/.test(cs.willChange) ||
    /paint|layout|strict|content/.test(cs.contain) ||
    (cs.containerType !== undefined && cs.containerType !== "normal" && cs.containerType !== "")
  );
}

/**
 * Where the host goes, and why it is not always `<body>`.
 *
 * The design describes a JS-driven absolute layer as the mitigation. There is a
 * cheaper one that covers the case that actually occurs: if the trapped
 * ancestor is `<body>`, appending to `<html>` steps outside its containing
 * block entirely, and every fixed surface is correct again with zero per-frame
 * work. A JS layer would cost a scroll listener and a write per frame on every
 * page, forever, to fix a page shape that is uncommon.
 *
 * When `<html>` ITSELF traps — rare, and unfixable by relocation — the caller
 * emits `error{code:'fixed-trapped'}` and we stay where we are. The own
 * instruction is to be honest about the fallback rather than to pretend.
 */
export function hostParent(doc: Document): { parent: Element; trapped: boolean } {
  const root = doc.documentElement;
  const body = doc.body;
  if (root && trapsFixed(root)) return { parent: body ?? root, trapped: true };
  if (body && trapsFixed(body)) return { parent: root ?? body, trapped: false };
  return { parent: body ?? root, trapped: false };
}

/** Create (or return the existing) shadow host and its open shadow root. Idempotent. */
export function createHost(doc: Document = document): ShadowRoot {
  const attr = widgetAttr("root"); // data-snag-root
  const existing = doc.querySelector(`[${attr}]`);
  if (existing?.shadowRoot) return existing.shadowRoot;

  const host = doc.createElement("div");
  host.setAttribute(attr, "");
  host.style.cssText = HOST_CSS;
  hostParent(doc).parent.appendChild(host);
  return host.attachShadow({ mode: "open" });
}

/**
 * Put the host back if the page throws it away.
 *
 * A host application that does `body.innerHTML = ''` on a route change — or any
 * framework that owns the body and re-renders it — removes our shadow host and
 * with it every pin, the toolbar and the panel. Today that is SILENT: the
 * widget simply ceases to exist mid-round, with the reviewer's comments still in
 * storage and nothing on screen, and no way to tell that from "there are no
 * comments here".
 *
 * A MutationObserver on the body's child list is the cheapest way to notice,
 * and it observes only `childList` on one node — not a subtree scan.
 *
 * BOUNDED, and the bound is the point. A page in a re-render loop would
 * otherwise become a fight: we re-append, it clears, forever, at whatever rate
 * the host renders. After `LIMIT` evictions we stop, say so once, and leave the
 * page alone — losing the widget is bad, but pinning a client's main thread
 * against their own framework is worse.
 *
 * Returns its own disposer; re-appending does not re-create the shadow root, so
 * every listener, sheet and pin survives the move.
 */
export function keepHostMounted(
  root: ShadowRoot,
  onGiveUp: (evictions: number) => void,
  limit = 5,
): () => void {
  const doc = root.ownerDocument ?? document;
  const host = root.host;
  const parent = hostParent(doc).parent;
  if (typeof MutationObserver !== "function" || !parent) return () => {};

  let evictions = 0;
  const mo = new MutationObserver(() => {
    if (host.isConnected) return;
    evictions++;
    if (evictions > limit) {
      mo.disconnect();
      onGiveUp(evictions);
      return;
    }
    hostParent(doc).parent.appendChild(host);
  });
  mo.observe(parent, { childList: true });
  return () => mo.disconnect();
}

/**
 * Keep our own events inside our own boundary — pin hunt, item 1.
 *
 * Every dismiss-on-outside library — Radix's `DismissableLayer`, Base UI's
 * `useDismiss`, Headless UI's outside-click — listens on the DOCUMENT for
 * `pointerdown` and asks "is `event.target` inside my layer?". An event
 * leaving a shadow root is retargeted to the host as it crosses the boundary,
 * so the answer for a click on our toolbar is the host `<div>` sitting in the
 * body: outside. A reviewer reaching for `+` to comment on an open dialog
 * watched it vanish, on exactly the kind of site a dev-led studio builds.
 *
 * The same retargeting feeds the focus traps: a `focusin` from our composer
 * reads as focus escaping the dialog, and the trap yanks it back mid-sentence.
 *
 * Stopping the bubble at the host is precise, not a blanket. The host is a 0×0
 * absolutely positioned box that nothing else can be inside, so the ONLY events
 * that pass through it are ours. A click on the host page still reaches every
 * listener the page has, and their own outside-click still closes their own
 * menus — which is right: it is not our business to keep a menu open when the
 * reviewer clicks the page.
 *
 * This is not and does not fix it. `popover="auto"` light-dismisses inside
 * event dispatch, before any listener runs, and no script can stop it; the
 * answer there is still the Alt+C chord.
 *
 * `stopPropagation`, never `stopImmediatePropagation`: other listeners on the
 * host itself — ours, or a page's delegated handler bound there — still run.
 */
// Registered as `[type, passive]` tuples, PASSIVE every one — the same shape
// the pointer net uses, and for the same law: The corrigendum makes
// touchstart/touchmove passive and never defaulted, because `preventDefault()`
// on touchstart is how a page stops scrolling. Nothing here defaults anything;
// `stopPropagation` is unaffected by passive. `verify-dist` asserts the shape
// in the shipped bytes, which is what keeps the next edit honest.
const SEALED: readonly (readonly [string, boolean])[] = [
  ["pointerdown", true],
  ["mousedown", true],
  ["touchstart", true],
  ["pointerup", true],
  ["mouseup", true],
  ["touchend", true],
  ["click", true],
  ["dblclick", true],
  ["focusin", true],
  ["focusout", true],
];

export function sealHostEvents(root: ShadowRoot): () => void {
  const host = root.host as HTMLElement;
  const stop = (e: Event) => e.stopPropagation();
  for (const [type, passive] of SEALED) host.addEventListener(type, stop, { passive });
  return () => {
    for (const [type] of SEALED) host.removeEventListener(type, stop);
  };
}

/**
 * Stay in the accessibility tree — the other half of the shadcn page.
 *
 * A modal dialog built in JavaScript marks every other child of the body
 * `aria-hidden="true"` (the `aria-hidden` package's `hideOthers`, which Radix
 * and Base UI both use). Our host is a child of the body, so while such a
 * dialog is open the whole widget stops existing for a screen reader — and for
 * anything else reading the accessibility tree, which is how this was found:
 * the toolbar button could not be located at all.
 *
 * Nothing is actually inert. Our chrome still paints and still takes clicks;
 * only its announcement is gone. So we take the attribute off OUR OWN element,
 * which A3 and A5 permit — the rule they set is that we never touch the host
 * page's nodes, and this is ours.
 *
 * A native `showModal()` is deliberately untouched by this: it makes the rest
 * of the document inert through the top layer rather than through an
 * attribute, there is nothing to remove, and the answer there is to
 * pause and say so.
 *
 * Bounded like `keepHostMounted`, and for the same reason: a page that sets it
 * back in a loop would otherwise be a fight we hold the main thread for.
 */
export function keepHostAnnounced(
  root: ShadowRoot,
  onGiveUp: (removals: number) => void,
  limit = 20,
): () => void {
  const host = root.host as HTMLElement;
  if (typeof MutationObserver !== "function") return () => {};

  let removals = 0;
  const strip = (): boolean => {
    let did = false;
    if (host.getAttribute("aria-hidden") === "true") {
      host.removeAttribute("aria-hidden");
      did = true;
    }
    if (host.hasAttribute("inert")) {
      host.removeAttribute("inert");
      did = true;
    }
    return did;
  };
  const mo = new MutationObserver(() => {
    if (!strip()) return;
    if (++removals > limit) {
      mo.disconnect();
      onGiveUp(removals);
    }
  });
  strip();
  mo.observe(host, { attributes: true, attributeFilter: ["aria-hidden", "inert"] });
  return () => mo.disconnect();
}

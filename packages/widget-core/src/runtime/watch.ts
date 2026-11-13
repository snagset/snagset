import { wrap } from "../patch.ts";

/**
 * When the page changes underneath us.
 *
 * Two events, both found by dogfooding rather than by a test:
 *
 *   RESIZE — pins are drawn from their element's live rect, but nothing
 *   repainted on resize, so they sat at the last painted position until some
 *   unrelated action happened to repaint. On a responsive layout that means
 *   every pin is wrong the moment the window changes width.
 *
 *   NAVIGATION — a client-side route change is not a page load, so the previous
 *   route's pins stayed on screen until a hard reload. Worse than missing pins:
 *   they are confidently placed on a page they were never about.
 */

export interface PageWatcher {
  destroy(): void;
}

export interface WatchOptions {
  /** Layout moved. Cheap — re-derive positions from live rects and repaint. */
  onResize(): void;
  /** The route changed without a page load. Reload the round for the new one. */
  onRoute(): void;
  /**
   * A native modal `<dialog>` opened or closed.
   *
   * `showModal()` does not merely raise the dialog into the top layer — it marks
   * **everything else in the document inert**, top-layer siblings included. Our
   * shield, toolbar and composer keep painting above the dialog and receive no
   * pointer or keyboard events at all. The corrigendum is explicit that
   * re-entering the top layer does not fix this, because the problem is
   * inertness rather than paint order.
   *
   * So there is nothing to fix, only something to admit: review mode pauses
   * while the dialog is up and resumes when it closes. A shield that is visible
   * and dead is the worst of the three possible states.
   */
  onModal(open: boolean): void;
}

export function watchPage(win: Window, opts: WatchOptions): PageWatcher {
  const cleanups: (() => void)[] = [];

  // ── Resize, coalesced to one repaint per frame ─────────────────────────────
  // A resize event fires continuously while a window is dragged; repainting per
  // event would re-measure every pin dozens of times a frame for no gain.
  let frame = 0;
  const onResize = (): void => {
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      opts.onResize();
    });
  };
  win.addEventListener("resize", onResize);
  cleanups.push(() => {
    if (frame) win.cancelAnimationFrame(frame);
    win.removeEventListener("resize", onResize);
  });

  // Orientation change and the visual viewport settling are both resizes that
  // `resize` alone can miss on iOS.
  win.visualViewport?.addEventListener("resize", onResize);
  cleanups.push(() => win.visualViewport?.removeEventListener("resize", onResize));

  // Orientation is a FULL relayout — every rect changed
  // and the settle outlasts a frame; 250 ms is the spec's number.
  const onOrientation = (): void => void win.setTimeout(opts.onResize, 250);
  win.addEventListener("orientationchange", onOrientation);
  cleanups.push(() => win.removeEventListener("orientationchange", onOrientation));

  // ── Route changes ─────────────────────────────────────────────────────────
  let last = win.location.pathname;
  const check = (): void => {
    const now = win.location.pathname;
    if (now === last) return; // a query or hash change is page STATE, not identity
    last = now;
    opts.onRoute();
  };

  const nav = (win as unknown as { navigation?: EventTarget }).navigation;
  if (nav) {
    // The Navigation API reports every same-document navigation, including ones
    // a framework performs without touching history directly. Preferred wherever
    // it exists precisely because it needs no patching.
    const onNavigate = (): void => void win.setTimeout(check, 0);
    nav.addEventListener("navigatesuccess", onNavigate);
    cleanups.push(() => nav.removeEventListener("navigatesuccess", onNavigate));
  } else {
    // Fallback: patch the two history methods that do not emit an event.
    // A3 names this as its one sanctioned exception, and it goes through
    // the ONE registry — breadcrumbs are its second consumer at v0.1,
    // and a second registry is forbidden. The restore matrix (only unwind when
    // ours is still on top; otherwise neutralise to a pass-through)
    // lives in the registry now, not here.
    for (const name of ["pushState", "replaceState"] as const) {
      cleanups.push(
        wrap(win.history, name, (prev) => function (this: History, ...args: unknown[]) {
          const out = (prev as (...a: unknown[]) => unknown).apply(this, args);
          win.setTimeout(check, 0);
          return out;
        }),
      );
    }
  }

  // ── Native modal dialogs ────────────────────────────────────────
  const doc = win.document;

  // `:modal` is the precise test and is the one the design names. Where the
  // engine does not know the pseudo-class, `matches` THROWS on the selector
  // rather than returning false — so the feature test is a try, and the
  // documented fallback is "an open dialog exists", which over-pauses on a
  // non-modal dialog and never under-pauses on a modal one. Wrong in the safe
  // direction: a paused review mode is visible and recoverable; a dead one
  // looks like a broken widget.
  let hasModalSelector = true;
  try {
    doc.documentElement.matches(":modal");
  } catch {
    hasModalSelector = false;
  }

  const modalUp = (): boolean => {
    const open = doc.querySelectorAll("dialog[open]");
    if (!hasModalSelector) return open.length > 0;
    for (const d of open) if (d.matches(":modal")) return true;
    return false;
  };

  let wasModal = false;
  const checkModal = (): void => {
    const now = modalUp();
    if (now === wasModal) return;
    wasModal = now;
    opts.onModal(now);
  };

  // Two detectors, because neither covers every engine on its own. `toggle` on
  // <dialog> is recent (Chrome 114, Safari 18, Firefox 130); the attribute
  // observer catches the rest, and also catches a dialog opened by setting the
  // attribute directly rather than by calling the method.
  //
  // `attributeFilter` is what makes a document-wide subtree observer affordable:
  // the engine only queues a record when THAT attribute name changes, so a page
  // mutating a thousand class names an animation frame costs us nothing.
  doc.addEventListener("toggle", checkModal, true);
  cleanups.push(() => doc.removeEventListener("toggle", checkModal, true));

  const dialogObserver = new MutationObserver(checkModal);
  dialogObserver.observe(doc.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  cleanups.push(() => dialogObserver.disconnect());

  // `popstate` covers back/forward on both paths.
  const onPop = (): void => void win.setTimeout(check, 0);
  win.addEventListener("popstate", onPop);
  cleanups.push(() => win.removeEventListener("popstate", onPop));

  return {
    destroy() {
      for (const fn of cleanups) fn();
      cleanups.length = 0;
    },
  };
}

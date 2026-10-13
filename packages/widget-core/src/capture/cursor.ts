import { widgetAttr } from "@snagset/types/names";
import { isRendered } from "../anchor/geometry.ts";
import { accessibleNameOf, roleOf } from "../anchor/record.ts";
import { narrow, widen } from "../runtime/cursor.ts";
import { format } from "../strings/capture.ts";

/**
 * The keyboard virtual cursor.
 *
 * "Mouse users point; keyboard users need an equivalent. **Decision: a
 * virtual cursor over a candidate set, not real DOM focus.**" Real focus on a
 * host element fires the host's own `focus`/`blur` handlers, applies its
 * `:focus` styles, can open menus and submit-on-focus widgets and trigger SPA
 * route changes — it would break the page we are supposed to be observing.
 * So real focus stays on a hidden proxy button inside our shadow root the
 * entire time, and the "cursor" is a highlight we draw.
 *
 * ── THE TAB QUESTION, settled ──────────────────────────────────────────────
 * the design says Tab is intercepted at capture phase in `add`. The design says
 * the opposite in three places, calls itself "the settled resolution of the
 * direct 01/02 contradiction", and asserts it: "in every mode, Tab and
 * Shift+Tab reach the host document unmodified". 02 governs mechanism, and it
 * names the shape that satisfies both: build the cursor "within our own focus
 * scope, never on capturing Tab from the host document".
 *
 * That is exactly what this is. The listener is bound to the PROXY BUTTON, so
 * it only ever sees Tab while our own element holds focus — which is the
 * whole of `add` mode, because entering `add` focuses it. Nothing is bound at
 * document or window level; with focus in the host page Tab is untouched and
 * stays green. The literal "Tab ×5" works because the reviewer
 * pressed `+`, which put focus here.
 *
 * Lives in the CAPTURE chunk: `add` cannot be entered without it (the T0
 * snapshot and the gated label both need this chunk), and the add chrome the
 * cursor draws through is already here.
 */

/** The candidate selector, verbatim. */
const CANDIDATES =
  'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]),' +
  "[role], h1,h2,h3,h4,h5,h6, img, video, figure, table, li," +
  "main, nav, header, footer, aside, section[aria-label], form, [data-testid]";

const OURS = `[${widgetAttr("root")}]`;

/** The set, in document order — the pipeline, with the visibility
 *  predicate (never a second one) and our own DOM excluded. */
export function candidates(root: ParentNode = document.body): Element[] {
  return [...root.querySelectorAll(CANDIDATES)].filter(
    (el) => !el.closest(OURS) && isRendered(el),
  );
}

export interface VirtualCursor {
  /** Enter add mode: focus the proxy and place the cursor. */
  engage(): void;
  /** Leave: hand focus back to whatever the runtime says (the `+`). */
  release(): void;
  destroy(): void;
}

export interface CursorDeps {
  /** Draw the outline + chip over the cursor element (the add chrome). */
  show(el: Element): void;
  /** `Enter` — open the composer on the cursor element, exactly as a click. */
  pick(el: Element, point: { x: number; y: number }): void;
  /** Speak the move (the polite region, debounced by the runtime). */
  announce(text: string): void;
}

export function createCursor(root: ShadowRoot, deps: CursorDeps): VirtualCursor {
  const doc = root.ownerDocument ?? document;

  /**
   * The proxy: real focus lives here the whole time. Visually hidden
   * but FOCUSABLE — `display:none` or `visibility:hidden` cannot hold focus,
   * and a 0×0 element loses it in some engines.
   */
  const proxy = doc.createElement("button");
  proxy.type = "button";
  proxy.className = "snag-cursor-proxy";
  proxy.setAttribute("aria-label", format("cursor.proxy"));
  proxy.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  root.appendChild(proxy);

  let set: Element[] = [];
  let at = -1;
  /** Where focus was when we took it — restored on release. Better than
   *  naming a control: the reviewer may have entered `add` from the `+`, from
   *  the `a` hotkey with focus anywhere, or from the host's own page. */
  let cameFrom: Element | null = null;
  /** Elements reached by `[`/`]` are OUTSIDE the candidate set
   *  held separately so widening does not have to rebuild it. */
  let off: Element | null = null;

  const current = (): Element | null => off ?? set[at] ?? null;

  function speak(el: Element): void {
    const role = roleOf(el);
    const name = accessibleNameOf(el);
    const i = off ? 0 : at + 1;
    deps.announce(
      off || !name
        ? format("cursor.here", { role: role ?? el.tagName.toLowerCase(), name: name ?? "" })
        : format("cursor.at", { role: role ?? el.tagName.toLowerCase(), name, i, n: set.length }),
    );
  }

  function land(el: Element | null): void {
    if (!el) return;
    deps.show(el);
    // `block:'nearest'` and `behavior:'auto'` — the design forbids a smooth
    // scroll here, and nearest is what keeps a long list from jumping.
    el.scrollIntoView({ block: "nearest", behavior: "auto" });
    speak(el);
  }

  function move(delta: 1 | -1): void {
    // Stepping through the SET drops any `[`/`]` excursion — the excursion is
    // a detour from a candidate, not a new place in the order.
    off = null;
    if (set.length === 0) return;
    at = at < 0 ? (delta === 1 ? 0 : set.length - 1) : (at + delta + set.length) % set.length;
    land(set[at]!);
  }

  function step(dir: "out" | "in"): void {
    const from = current();
    if (!from) return;
    const next = dir === "out" ? widen(from) : narrow(from);
    if (!next) return;
    // If the widen/narrow landed back ON a candidate, resume the ordered walk
    // there rather than treating it as an excursion.
    const idx = set.indexOf(next);
    if (idx >= 0) {
      off = null;
      at = idx;
    } else {
      off = next;
    }
    land(next);
  }

  proxy.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "Tab":
      case "ArrowDown":
      case "ArrowRight":
        // Bound to the PROXY, never to the document — see the header. Cancelled
        // so focus stays here rather than leaving for the host's tab order.
        e.preventDefault();
        move(e.key === "Tab" && e.shiftKey ? -1 : 1);
        return;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        move(-1);
        return;
      case "[":
        e.preventDefault();
        step("out");
        return;
      case "]":
        e.preventDefault();
        step("in");
        return;
      case "Enter":
      case " ": {
        const el = current();
        if (!el) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        deps.pick(el, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
        return;
      }
    }
  });

  return {
    engage() {
      set = candidates(doc.body);
      at = -1;
      off = null;
      cameFrom = root.activeElement ?? doc.activeElement;
      proxy.focus({ preventScroll: true });
    },
    release() {
      off = null;
      // Only if WE still hold it — a reviewer who clicked into the composer
      // has moved focus on purpose, and yanking it back is worse than leaving.
      if (root.activeElement === proxy) (cameFrom as HTMLElement | null)?.focus?.();
      cameFrom = null;
    },
    destroy() {
      proxy.remove();
    },
  };
}

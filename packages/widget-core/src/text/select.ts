import { CSS_VAR } from "@snagset/types/names";
import { LAYER } from "../runtime/theme.ts";
import { format } from "../strings/text.ts";

/**
 * Text anchoring's visible half. While armed — which is now for
 * as long as the widget is in `comments` — watch `selectionchange`, draw a
 * highlight over the live range's client rects, and hang a "Comment" chip at
 * the range's end. The SELECTION ITSELF is the browser's: the shield is down in
 * `comments` because reading must not cost interactivity, and that is the same
 * condition text selection needs, so OS handles, IME and `::selection` behave
 * natively. This module draws BESIDE the selection, never instead of it.
 *
 * STILL IN THE CAPTURE CHUNK, and now for a sharper reason. It used to be lazy
 * because nothing here could run before `add`. `comments` is the state a review
 * link ARRIVES in, so that argument is gone — and loading on entry would have
 * put these bytes inside the activation sum, which is the one
 * budget the whole runtime is shaped around. So the trigger moved instead of
 * the code: the eager net carries a single `selectstart` listener (pointer.ts),
 * which fires when the drag BEGINS. The chunk loads during the drag and is warm
 * by the time there is a range to draw against. First selection of a session
 * may show the chip a beat late; no selection after it does.
 *
 * A selection inside a form field gets the refusal chip instead: the quote
 * would BE the input value, and input values are never captured as text
 * The chip says so where the reviewer is looking, which beats a
 * silent nothing.
 */

export interface SelectionWatcher {
  arm(): void;
  disarm(): void;
  destroy(): void;
}

export interface SelectOptions {
  /** The reviewer clicked the chip on a usable selection. */
  onQuote(sel: Selection, at: { x: number; y: number }): void;
}

const FORM = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
const DEBOUNCE_MS = 150;

export function createSelectionWatcher(
  root: ShadowRoot,
  opts: SelectOptions,
): SelectionWatcher {
  const doc = root.ownerDocument ?? document;
  const win = doc.defaultView ?? window;

  const layer = doc.createElement("div");
  layer.className = "snag-select-layer";
  layer.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${LAYER.shield + 1}`;

  const chip = doc.createElement("button");
  chip.type = "button";
  chip.className = "snag-chip";
  chip.style.cssText = [
    "position:fixed",
    "pointer-events:auto",
    "transform:translate(8px, -50%)",
    "font:600 12px/1 ui-sans-serif,system-ui,sans-serif",
    "padding:6px 10px",
    "border-radius:999px",
    "border:0",
    "cursor:pointer",
    `background:var(${CSS_VAR.accent},#2563eb)`,
    `color:var(${CSS_VAR.onAccent},#fff)`,
    "box-shadow:0 2px 8px rgba(0,0,0,.25)",
  ].join(";");
  chip.hidden = true;

  let armed = false;
  let timer = 0;
  let refusal = false;

  const clearHighlight = (): void => {
    while (layer.firstChild !== chip && layer.firstChild) layer.firstChild.remove();
  };

  const hide = (): void => {
    clearHighlight();
    chip.hidden = true;
  };

  const formBound = (sel: Selection): boolean => {
    const n = sel.anchorNode ?? sel.focusNode;
    const el = n && (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);
    return !!el?.closest?.(FORM);
  };

  const render = (): void => {
    timer = 0;
    if (!armed) return;
    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hide();
      return;
    }
    const range = sel.getRangeAt(0);
    // A selection inside our own shadow root is not a quote target.
    if (root.contains(range.commonAncestorContainer)) {
      hide();
      return;
    }

    refusal = formBound(sel);
    clearHighlight();
    const rects = range.getClientRects();
    if (rects.length === 0) {
      hide();
      return;
    }
    if (!refusal) {
      // The browser's own ::selection paint is underneath; these are OUR
      // affordance that the selection is pin-able — deliberately faint.
      for (const r of rects) {
        if (r.width < 1 || r.height < 1) continue;
        const box = doc.createElement("div");
        box.style.cssText =
          `position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;` +
          `pointer-events:none;border-radius:2px;background:var(${CSS_VAR.accent},#2563eb);opacity:.14`;
        layer.insertBefore(box, chip);
      }
    }

    const end = rects[rects.length - 1]!;
    chip.textContent = refusal ? format("chip.notext") : format("chip.comment");
    chip.disabled = refusal;
    chip.style.left = `${Math.min(end.right, win.innerWidth - 40)}px`;
    chip.style.top = `${Math.min(end.top + end.height / 2, win.innerHeight - 24)}px`;
    chip.hidden = false;
  };

  const onChange = (): void => {
    if (!armed) return;
    // Debounced: selectionchange fires per caret move while
    // dragging, and re-measuring rects on each is layout work per event.
    if (timer) win.clearTimeout(timer);
    timer = win.setTimeout(render, DEBOUNCE_MS);
  };

  chip.addEventListener("click", () => {
    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed || refusal) return;
    const r = sel.getRangeAt(0).getClientRects();
    const first = r.length ? r[0]! : sel.getRangeAt(0).getBoundingClientRect();
    hide();
    opts.onQuote(sel, { x: first.x + Math.min(12, first.width / 2), y: first.y + first.height / 2 });
  });

  layer.appendChild(chip);
  doc.addEventListener("selectionchange", onChange);

  return {
    arm() {
      armed = true;
      root.appendChild(layer);
      render();
    },
    disarm() {
      armed = false;
      if (timer) win.clearTimeout(timer);
      timer = 0;
      hide();
      // Detached, not hidden — the same rule the shield follows.
      layer.remove();
    },
    destroy() {
      this.disarm();
      doc.removeEventListener("selectionchange", onChange);
    },
  };
}

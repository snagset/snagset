import { quoteFromSelection, type QuoteFromSelection, type QuoteRefusal } from "../anchor/quote.ts";
import type { AnchorRecord } from "../anchor/types.ts";

/**
 * The capture chunk's creation-side functions, INJECTED rather than bundled.
 * Bundling them here dragged @medv/finder, the redaction predicates and the
 * label gates into a second lazy chunk — ~7 KB of duplicate bytes for code
 * the caller already holds: the runtime cannot reach text picking without the
 * capture chunk warm (entering `add` preloads it). Passing live functions at
 * call time involves no module specifier, so the self-containment argument
 * — no baked cross-chunk URL to poison — is untouched.
 */
export interface CaptureDeps {
  createElementAnchor: typeof import("../anchor/record.ts").createElementAnchor;
  describeElement: typeof import("../capture/selector.ts").describeElement;
  deriveQuoteLabel: typeof import("../capture/label.ts").deriveQuoteLabel;
}

/**
 * `createTextAnchor` — assembled. The quote policy lives in
 * the anchor layer (quote.ts, textindex.ts); this composes it with the
 * capture chunk's creation-side pieces the same way the element path does:
 * `describeElement` for selectors, the gated label derivation, and
 * `createElementAnchor` for the full record — because the design is
 * explicit that the text quote is an ADDITIONAL facet on a complete element
 * record, not a replacement for one.
 */

export type TextAnchorResult =
  | {
      kind: "text";
      record: AnchorRecord;
      /** The anchor element — the record describes it. */
      el: Element;
      label: string;
      /** Where the pin goes — the START of the selection. */
      point: { x: number; y: number };
    }
  | {
      /** Fall back to an element anchor on the control, and say why. */
      kind: "refused-form-control";
      el: Element;
    }
  | { kind: "not-a-text-anchor" };

export function createTextAnchor(
  sel: Selection,
  cap: CaptureDeps,
  opts: { viewportWidth?: number; ourRoot?: Node } = {},
): TextAnchorResult {
  const q = quoteFromSelection(sel, opts.ourRoot);
  if (!q) return { kind: "not-a-text-anchor" };
  if ("refused" in q) {
    return q.refused === "form-control"
      ? { kind: "refused-form-control", el: (q as Extract<QuoteRefusal, { refused: "form-control" }>).el }
      : { kind: "not-a-text-anchor" };
  }

  const { el, quote, weak, startRect } = q as QuoteFromSelection;
  // The pin sits ON the highlight: computes the offset against
  // the range's own rect, which is what passing the range-start point into
  // the element-anchor offset math does.
  const point = { x: startRect.x + Math.min(12, startRect.w / 2), y: startRect.y + startRect.h / 2 };

  const label = quote ? cap.deriveQuoteLabel(el, quote.exact) : cap.deriveQuoteLabel(el, "");
  const record = cap.createElementAnchor(el, {
    point,
    ...(opts.viewportWidth === undefined ? {} : { viewportWidth: opts.viewportWidth }),
    label,
    ...cap.describeElement(el),
  });

  record.source = "text";
  if (quote) {
    // The SELECTION's quote replaces the element-derived facet — it is the
    // reviewer's own words about which words they meant. `weak` quotes keep
    // the facet for corroboration; bars them from being a primary
    // strategy, which the resolution side enforces by length.
    record.text = { exact: quote.exact };
    if (quote.prefix) record.text.prefix = quote.prefix;
    if (quote.suffix) record.text.suffix = quote.suffix;
  }
  void weak;

  return { kind: "text", record, el, label, point };
}

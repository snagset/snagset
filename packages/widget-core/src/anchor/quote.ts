import { normalizeText } from "./similarity.ts";
import { buildTextIndex, flatOffsetOf } from "./textindex.ts";

/**
 * Text-quote creation — and the policies.
 *
 * This is CREATION-side code: it ships with the capture chunk (like
 * selector.ts, and for the same reason — nothing here runs until a reviewer
 * makes a selection). Resolution against the quote is the
 * `snag.anchor-fuzzy.js`; the exact-match step in the extension chunk works
 * on the element facet and needs none of this.
 */

export interface TextQuoteFacet {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface QuoteFromSelection {
  /** The element the record is built against. */
  el: Element;
  /** The facet, or null when dropped it (punctuation/whitespace only). */
  quote: TextQuoteFacet | null;
  /** Under 8 chars: corroboration only, never a primary strategy. */
  weak: boolean;
  /** First client rect of the range — the pin sits on the highlight. */
  startRect: { x: number; y: number; w: number; h: number };
}

export type QuoteRefusal =
  /** A11 — a quote inside a form field IS the input value. */
  | { refused: "form-control"; el: Element }
  /** A selection inside our own shadow root. */
  | { refused: "widget-internal" };

/** The calibration: 32 each side, word-boundary extension, hard cap 64. */
const QUOTE_CONTEXT = 32;
const CONTEXT_CAP = 64;
/** The caps. */
const WEAK_BELOW = 8;
const QUOTE_MAX = 512;

const FORM = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
const PUNCT_ONLY = /^[\p{P}\p{S}\s]*$/u;

function containerElement(n: Node): Element | null {
  return n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
}

/**
 * Cut `prefix`/`suffix`: take QUOTE_CONTEXT code units, extend AWAY
 * from the quote to the next word boundary, stop at CONTEXT_CAP. Boundary via
 * `Intl.Segmenter` when the engine has it, else `/\s/` — correctness does not
 * depend on the choice, it only makes contexts read better.
 */
function wordEdge(s: string, atLeast: number, fromEnd: boolean): string {
  const capped = fromEnd ? s.slice(-CONTEXT_CAP) : s.slice(0, CONTEXT_CAP);
  if (capped.length <= atLeast) return capped;

  const seg = (Intl as { Segmenter?: new (l?: string, o?: object) => { segment(s: string): Iterable<{ index: number }> } })
    .Segmenter;
  const boundaries: number[] = [];
  if (seg) {
    for (const part of new seg(undefined, { granularity: "word" }).segment(capped)) boundaries.push(part.index);
  } else {
    for (let i = 0; i < capped.length; i++) if (/\s/.test(capped[i]!)) boundaries.push(i + 1);
  }
  if (fromEnd) {
    // Prefix: keep the TAIL; extend leftward to a boundary, so it starts on a word.
    const cut = capped.length - atLeast;
    const b = boundaries.filter((i) => i <= cut).pop();
    return capped.slice(b ?? 0);
  }
  // Suffix: keep the HEAD; extend rightward to the boundary after `atLeast`.
  const b = boundaries.find((i) => i >= atLeast);
  return capped.slice(0, b ?? capped.length);
}

/** Over-length quotes truncate at a word boundary. */
function capQuote(exact: string): string {
  if (exact.length <= QUOTE_MAX) return exact;
  const cut = exact.slice(0, QUOTE_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > QUOTE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd();
}

export function quoteFromSelection(
  sel: Selection,
  ourRoot?: Node,
): QuoteFromSelection | QuoteRefusal | null {
  // Not a text anchor at all; the caller falls back to elements.
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  const startEl = containerElement(range.startContainer);
  const endEl = containerElement(range.endContainer);
  if (!startEl || !endEl) return null;

  // Refuse form controls, offering the control for an element
  // anchor instead. Input values are never captured AS TEXT: a quote
  // inside a form field IS the input value.
  const control = startEl.closest(FORM) ?? endEl.closest(FORM);
  if (control) return { refused: "form-control", el: control };

  // A selection inside our own shadow root (the hold-to-browse
  // guard; a selection cannot be produced through the shield).
  if (ourRoot && range.commonAncestorContainer.getRootNode() === ourRoot) {
    return { refused: "widget-internal" };
  }

  const el = containerElement(range.commonAncestorContainer);
  if (!el) return null;

  // The index, and the boundaries as flat offsets.
  const index = buildTextIndex(el.ownerDocument.body);
  const start = flatOffsetOf(index, range.startContainer, range.startOffset, "start");
  const end = flatOffsetOf(index, range.endContainer, range.endOffset, "end");

  const rects = range.getClientRects();
  const r = rects.length > 0 ? rects[0]! : range.getBoundingClientRect();
  const startRect = { x: r.x, y: r.y, w: r.width, h: r.height };

  if (start === null || end === null || end <= start) {
    return { el, quote: null, weak: false, startRect };
  }

  // The quote and its context, all cut from the SAME flat text.
  const exact = capQuote(normalizeText(index.text.slice(start, end)));

  // Drop a facet that is nothing but punctuation and whitespace; mark
  // one under 8 chars weak (the Hypothesis incident's exact input class).
  if (!exact || PUNCT_ONLY.test(exact)) {
    return { el, quote: null, weak: false, startRect };
  }
  const weak = exact.length < WEAK_BELOW;

  const quote: TextQuoteFacet = { exact };
  const prefix = wordEdge(index.text.slice(Math.max(0, start - CONTEXT_CAP), start), QUOTE_CONTEXT, true);
  const suffix = wordEdge(index.text.slice(end, end + CONTEXT_CAP), QUOTE_CONTEXT, false);
  if (prefix.trim()) quote.prefix = prefix;
  if (suffix.trim()) quote.suffix = suffix;

  return { el, quote, weak, startRect };
}

import { hostAttr, widgetAttr } from "@snagset/types/names";
import { isRendered } from "./geometry.ts";
import { yieldToMain, SLICE_MS } from "./sliced.ts";

/**
 * `TextIndex`, the flat text a quote is cut from and matched
 * against. Builds it at CREATION (mapping a Selection's boundaries to
 * flat offsets, and cutting prefix/suffix); the
 * `matchQuote` reads the same structure at resolution.
 *
 * The one invariant everything hangs off: THE BUILD AND THE MAPPING SHARE A
 * COLLAPSE STATE MACHINE. The lazy flat→DOM rule is "re-run the
 * normalisation on that single node's data while walking both strings in
 * lockstep" — which only recovers the right offset if the walk IS the build,
 * character for character. So both go through `collapse()` below, and the
 * per-node contribution deliberately does NOT trim: `normalizeText` trims a
 * whole string, but a node's text is a slice of a paragraph, and trimming
 * each slice would delete the inter-node spaces that are real content
 * ("Sa" + "ve" in a <b> must stay "Save"; "foo " + "bar" must stay
 * "foo bar"). Quotes cut from the index go through `normalizeText` at the
 * END, where trimming is correct.
 */

export interface TextSegment {
  node: Text;
  flatStart: number;
  flatEnd: number;
}

export interface TextIndex {
  /** Collapsed, fold-normalised, concatenated. May carry edge spaces — quotes trim. */
  text: string;
  segments: TextSegment[];
  truncated: boolean;
  /** Pass-cache epoch (owns invalidation); 0 until then. */
  epoch: number;
  builtAt: number;
}

/** The calibration: one ~1 MB string, hard stop, truncated flag. */
export const MAX_INDEX_CHARS = 500_000;

const SKIP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  '[aria-hidden="true"]',
  `[${hostAttr("ignore")}]`,
].join(",");

// The same fold set as normalizeText — restated as a TABLE the state
// machine can walk one character at a time. \uXXXX escapes only.
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/;
const SPACE = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
function foldChar(ch: string): string {
  if ("\u2018\u2019\u201A\u201B".includes(ch)) return "'";
  if ("\u201C\u201D\u201E\u201F".includes(ch)) return '"';
  if (("\u2010" <= ch && ch <= "\u2015") || ch === "\u2212") return "-";
  if (ch === "\u2026") return "...";
  if (ch === "\u2044") return "/";
  return ch;
}

interface CollapseState {
  /** True when the last emitted character was a space — doubles collapse across node seams. */
  lastWasSpace: boolean;
}

/**
 * Feed raw text through the collapse machine. `emit` receives each output
 * character; return the count consumed so a caller can stop mid-node. NFC is
 * applied per node BEFORE this (composition never crosses a node boundary in
 * practice, and per-character NFC does not exist).
 */
function collapse(raw: string, state: CollapseState, emit: (ch: string) => boolean): void {
  for (const ch of raw) {
    if (ZERO_WIDTH.test(ch)) continue;
    if (SPACE.test(ch)) {
      if (state.lastWasSpace) continue;
      state.lastWasSpace = true;
      if (!emit(" ")) return;
      continue;
    }
    state.lastWasSpace = false;
    for (const out of foldChar(ch)) if (!emit(out)) return;
  }
}

/** Elements whose boundary does NOT imply a visual break — no seam space. */
const INLINE = new Set([
  "A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "DFN", "EM", "I",
  "KBD", "LABEL", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB",
  "SUP", "TIME", "U", "VAR", "WBR",
]);

function nearestBlock(node: Text): Element | null {
  let el = node.parentElement;
  while (el && INLINE.has(el.tagName)) el = el.parentElement;
  return el;
}

/**
 * The same walk, YIELDING, and the reason `sliced.ts` exists.
 *
 * `sliced()` was written for "the text index build, the ARIA sweep, the fuzzy
 * windows" and had no callers at all: the fuzzy windows yield by using its
 * constants directly, and the index build — the largest single unit of the
 * three — ran unbroken. On a page with enough text that is one ~53 ms task in
 * the middle of a settle, which is precisely what the design promises never happens
 * and what the 40-pin DoD test caught about a quarter of the time.
 *
 * The synchronous form stays and is still correct for its one caller: `quote.ts`
 * builds an index while a reviewer is making a selection, where the work is
 * bounded by one gesture and an await would put a frame between the click and
 * the highlight. The settle path — unbounded pins, no user waiting — takes this
 * one.
 */
export async function buildTextIndexSliced(root: ParentNode = document.body): Promise<TextIndex> {
  return build(root, true) as Promise<TextIndex>;
}

export function buildTextIndex(root: ParentNode = document.body): TextIndex {
  return build(root, false) as TextIndex;
}

function build(root: ParentNode, slice: boolean): TextIndex | Promise<TextIndex> {
  const doc = root.ownerDocument ?? (root as Document);
  const ourRoot = `[${widgetAttr("root")}]`;
  const renderedMemo = new Map<Element, boolean>();
  const skipMemo = new Map<Element, boolean>();

  const skipped = (el: Element): boolean => {
    const hit = skipMemo.get(el);
    if (hit !== undefined) return hit;
    let out: boolean;
    if (el.matches(SKIP_SELECTOR) || el.matches(ourRoot)) out = true;
    else if (el.parentElement) out = skipped(el.parentElement);
    else out = false;
    skipMemo.set(el, out);
    return out;
  };
  // The rendered check is consulted PER ELEMENT and memoised — the
  // walker asks once when it enters an element, not once per text node.
  const rendered = (el: Element): boolean => {
    const hit = renderedMemo.get(el);
    if (hit !== undefined) return hit;
    const out = isRendered(el);
    renderedMemo.set(el, out);
    return out;
  };

  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = (node as Text).parentElement;
      if (!el || skipped(el) || !rendered(el)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const parts: string[] = [];
  const segments: TextSegment[] = [];
  const state: CollapseState = { lastWasSpace: false };
  let flat = 0;
  let truncated = false;
  let prevBlock: Element | null = null;

  // Hoisted so the sync and sliced forms share one body: the walk is
  // identical, and a second copy of it is a second place for the block-seam
  // rule to drift.
  let sliceStart = performance.now();
  const step = (node: Text): boolean => {
    // A single space at BLOCK seams: </p><p> is a word break the flat
    // string must carry, </b>text is not.
    const block = nearestBlock(node);
    if (prevBlock && block !== prevBlock && !state.lastWasSpace) {
      parts.push(" ");
      flat += 1;
      state.lastWasSpace = true;
    }
    prevBlock = block;

    const start = flat;
    let over = false;
    collapse(node.data.normalize("NFC"), state, (ch) => {
      if (flat >= MAX_INDEX_CHARS) {
        over = true;
        return false;
      }
      parts.push(ch);
      flat += 1;
      return true;
    });
    if (flat > start) segments.push({ node, flatStart: start, flatEnd: flat });
    if (over) {
      truncated = true;
      return false;
    }
    return true;
  };

  const done = (): TextIndex => ({
    text: parts.join(""),
    segments,
    truncated,
    epoch: 0,
    builtAt: Date.now(),
  });

  if (!slice) {
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (!step(node)) break;
    }
    return done();
  }

  return (async () => {
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (!step(node)) break;
      if (performance.now() - sliceStart >= SLICE_MS) {
        await yieldToMain();
        sliceStart = performance.now();
      }
    }
    return done();
  })();
}

/**
 * Map a DOM boundary to a flat offset — the creation-side need.
 * An Element container (offset = child index) is normalised to the nearest
 * text boundary INSIDE the selection: the following text node for a start,
 * the preceding one for an end.
 */
export function flatOffsetOf(
  index: TextIndex,
  container: Node,
  offset: number,
  edge: "start" | "end",
): number | null {
  let node: Text | null = null;
  let within = 0;

  if (container.nodeType === Node.TEXT_NODE) {
    node = container as Text;
    within = offset;
  } else {
    // Walk the child list toward the selection's inside.
    const children = container.childNodes;
    if (edge === "start") {
      for (let i = offset; i < children.length && !node; i++) node = firstText(children[i]!);
      if (node) within = 0;
    } else {
      for (let i = offset - 1; i >= 0 && !node; i--) node = lastText(children[i]!);
      if (node) within = node.data.length;
    }
  }
  if (!node) return null;

  const seg = index.segments.find((s) => s.node === node);
  if (!seg) {
    // The boundary node contributed nothing (skipped, unrendered, collapsed
    // empty). The nearest segment boundary is the honest answer.
    return nearest(index, node, edge);
  }

  // Lockstep re-walk of this ONE node — the build in miniature,
  // stopping once `within` raw characters have been consumed.
  let consumed = 0;
  const raw = node.data.normalize("NFC");
  const st2: CollapseState = { lastWasSpace: false };
  let out = seg.flatStart;
  for (const ch of raw) {
    if (consumed >= within) break;
    consumed += ch.length;
    if (ZERO_WIDTH.test(ch)) continue;
    if (SPACE.test(ch)) {
      if (st2.lastWasSpace) continue;
      st2.lastWasSpace = true;
      out += 1;
      continue;
    }
    st2.lastWasSpace = false;
    out += foldChar(ch).length;
  }
  return Math.min(out, seg.flatEnd);
}

function firstText(n: Node): Text | null {
  if (n.nodeType === Node.TEXT_NODE) return n as Text;
  for (const c of n.childNodes) {
    const t = firstText(c);
    if (t) return t;
  }
  return null;
}
function lastText(n: Node): Text | null {
  if (n.nodeType === Node.TEXT_NODE) return n as Text;
  for (let i = n.childNodes.length - 1; i >= 0; i--) {
    const t = lastText(n.childNodes[i]!);
    if (t) return t;
  }
  return null;
}

/** Position of a non-indexed node relative to indexed segments, by document order. */
function nearest(index: TextIndex, node: Text, edge: "start" | "end"): number | null {
  for (const seg of index.segments) {
    const cmp = node.compareDocumentPosition(seg.node);
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) {
      return edge === "start" ? seg.flatStart : Math.max(0, seg.flatStart);
    }
  }
  return index.text.length;
}

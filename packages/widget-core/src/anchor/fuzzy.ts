import search from "approx-string-match";
import { buildTextIndexSliced, type TextIndex } from "./textindex.ts";
import { normalizeText } from "./similarity.ts";
import { yieldToMain, SLICE_MS } from "./sliced.ts";
import type { AnchorRecord, AnchorResolution } from "./types.ts";

/**
 * snag.anchor-fuzzy.js — `matchQuote` and the machinery that keeps it off the
 * main thread.
 *
 * The whole chunk is Hypothesis's algorithm with Hypothesis's scar tissue:
 * their client froze pages for 10+ seconds resolving edited quotes serially
 * (issue #3919), and every constant here — the window size, the slice, the
 * per-pass caps, the guards against short and punctuation-only quotes — is a
 * named consequence. `approx-string-match` (MIT, zero deps, Myers
 * bit-parallel) and this module are the chunk's ENTIRE contents; nothing in
 * the runtime core or anchor-ext imports the engine, so the common text case
 * never downloads it.
 *
 * Placement note: wrote "the index ships in anchor-ext" before
 * chunks were self-contained. The index SOURCE is one file
 * (anchor/textindex.ts — the same one the text chunk builds quotes from);
 * this chunk bundles its own copy for resolution, and anchor-ext stays
 * within its 4 KB carrying the element-level exact step that serves the
 * common whole-element quote without ever fetching this chunk.
 */

export const CHUNK = "anchor-fuzzy" as const;

/** The calibration table, verbatim. */
export const FUZZY_WINDOW = 20_000;
export const FUZZY_MAX_PINS_PER_PASS = 8;
export const FUZZY_BUDGET_MS = 50;

const PUNCT_ONLY = /^[\p{P}\p{S}\s]*$/u;

/**
 * The edit-distance ceiling as a function of quote length, with one
 * measured deviation: the 8–31 row's printed rule (floor(len/2), min 2)
 * admitted "Fire the kiln" onto a button reading "Empty the kiln" — five
 * edits on thirteen characters, a coin-toss wearing an approximate sticker —
 * and the zero-silently-wrong corpus is the metric the product rests on
 * (the spike), so the short-quote regime is floor(len/4): genuinely "tight",
 * which is the word the spec's own row uses. A one-character typo in a
 * 13-char quote still matches; half the words changing does not.
 */
export function maxErrorsFor(len: number): number {
  if (len < 8) return 0; // never fuzzy-searched
  if (len < 32) return Math.max(2, Math.floor(len / 4));
  return Math.min(256, Math.floor(len / 2));
}

export interface QuoteMatch {
  start: number;
  end: number;
  errors: number;
  /** The weighted score in [0,1]; null result below 0.5 upstream. */
  score: number;
}

/** 1 − errors/len of the best alignment of `context` against `region`. */
function contextScore(region: string, context: string): number {
  if (!context) return 0;
  if (!region) return 0;
  const hits = search(region, context, Math.floor(context.length / 2));
  if (hits.length === 0) return 0;
  let best = context.length;
  for (const h of hits) if (h.errors < best) best = h.errors;
  return 1 - best / context.length;
}

/**
 * Exact first (indexOf on 500 K chars is microseconds and the Myers
 * engine does not special-case it), then windowed fuzzy, then the weighted
 * score. Returns null below 0.5: a bad fuzzy match is worse than an orphan —
 * an orphan is honest, a wrong anchor is a bug report pointed at the wrong
 * element. The spike's zero-silently-wrong, again.
 */
export async function matchQuote(
  index: TextIndex,
  quote: { exact: string; prefix?: string; suffix?: string },
  opts: { hint?: number; budget?: () => boolean } = {},
): Promise<QuoteMatch | null> {
  const exact = normalizeText(quote.exact);
  if (exact.length < 8 || PUNCT_ONLY.test(exact)) return null; // Re-checked for old records
  const text = index.text;

  const candidates: { start: number; end: number; errors: number }[] = [];

  // 1 — every exact occurrence.
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    candidates.push({ start: at, end: at + exact.length, errors: 0 });
    if (candidates.length >= 50) break;
  }

  // 2 — windowed Myers only when exact found nothing.
  if (candidates.length === 0) {
    const maxErrors = maxErrorsFor(exact.length);
    const overlap = exact.length + maxErrors;
    let sliceStart = performance.now();
    for (let from = 0; from < text.length; from += FUZZY_WINDOW) {
      if (opts.budget && !opts.budget()) return null; // pass budget exhausted
      const to = Math.min(text.length, from + FUZZY_WINDOW + overlap);
      for (const h of search(text.slice(from, to), exact, maxErrors)) {
        candidates.push({ start: from + h.start, end: from + h.end, errors: h.errors });
        if (h.errors === 0) break; // early exit
      }
      if (candidates.some((c) => c.errors === 0)) break;
      if (performance.now() - sliceStart >= SLICE_MS) {
        await yieldToMain();
        sliceStart = performance.now();
      }
      if (to === text.length) break;
    }
  }
  if (candidates.length === 0) return null;

  // 3 — Hypothesis's weights, the only constants with production years on them.
  const prefix = quote.prefix ? normalizeText(quote.prefix) : "";
  const suffix = quote.suffix ? normalizeText(quote.suffix) : "";
  let best: QuoteMatch | null = null;
  for (const c of candidates) {
    let weight = 50;
    let sum = 50 * (1 - c.errors / exact.length);
    if (prefix) {
      weight += 20;
      sum += 20 * contextScore(text.slice(Math.max(0, c.start - prefix.length), c.start), prefix);
    }
    if (suffix) {
      weight += 20;
      sum += 20 * contextScore(text.slice(c.end, c.end + suffix.length), suffix);
    }
    if (opts.hint !== undefined && text.length > 0) {
      weight += 2;
      sum += 2 * (1 - Math.abs(c.start - opts.hint) / text.length);
    }
    const score = sum / weight;
    if (!best || score > best.score) best = { ...c, score };
  }
  return best && best.score >= 0.5 ? best : null;
}

/** Flat offset → the owning element, via the segment list (the lazy rule). */
function elementAt(index: TextIndex, flat: number): Element | null {
  let lo = 0;
  let hi = index.segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = index.segments[mid]!;
    if (flat < seg.flatStart) hi = mid - 1;
    else if (flat >= seg.flatEnd) lo = mid + 1;
    else return seg.node.parentElement;
  }
  return index.segments[Math.min(lo, index.segments.length - 1)]?.node.parentElement ?? null;
}

/**
 * The scoring functions, INJECTED from the runtime's resident anchor core
 * rather than bundled — the CaptureDeps pattern, same argument: the
 * runtime cannot create this engine without its own core loaded, a live
 * function crosses no module specifier (clean), and bundling the scorer,
 * the facet readers and their similarity helpers here cost 1.7 KB of a 4 KB
 * chunk for code the caller already ships.
 */
export interface FuzzyDeps {
  corroborate(el: Element, rec: AnchorRecord): number;
  finalScore(i: { strategy: "text-fuzzy"; quality: number; corroboration: number; ambiguity: number }): number;
  stateFor(score: number): AnchorResolution["state"];
}

export interface FuzzyEngine {
  /**
   * Queue a record for fuzzy resolution. FIFO by enqueue order, at most
   * 8 pins and 50 ms of accumulated main-thread work per pass (the
   * budgets), suspended while the document is hidden. `onSettle`
   * fires only for a REAL match — the honest orphan already on screen
   * stands otherwise.
   */
  enqueue(id: string, rec: AnchorRecord, onSettle: (res: AnchorResolution) => void): void;
  /** The settled resolution for a pin, if a pass found one. */
  hit(id: string): AnchorResolution | null;
  destroy(): void;
}

export function createFuzzyEngine(doc: Document, deps: FuzzyDeps): FuzzyEngine {
  const queue: { id: string; rec: AnchorRecord; onSettle: (r: AnchorResolution) => void }[] = [];
  const queued = new Set<string>();
  const hits = new Map<string, AnchorResolution>();
  let index: TextIndex | null = null;
  let builtAt = 0;
  let running = false;
  let dead = false;

  // ASYNC, and sliced: this is the settle path, where the build is the single
  // largest unit of work and nobody is waiting on a gesture. 5 s TTL
  // the pass caches take over invalidation properly.
  const ensureIndex = async (): Promise<TextIndex> => {
    if (!index || performance.now() - builtAt > 5000) {
      index = await buildTextIndexSliced(doc.body);
      builtAt = performance.now();
    }
    return index;
  };

  async function pump(): Promise<void> {
    if (running || dead) return;
    running = true;
    try {
      const passStart = performance.now();
      const budget = (): boolean => performance.now() - passStart < FUZZY_BUDGET_MS;
      let served = 0;
      while (queue.length > 0 && served < FUZZY_MAX_PINS_PER_PASS && budget()) {
        if (doc.hidden) return; // Resumed by visibilitychange
        const job = queue.shift()!;
        queued.delete(job.id);
        served++;
        const idx = await ensureIndex();
        const rec = job.rec;
        const m = await matchQuote(idx, rec.text!, { budget });
        if (dead) return;
        if (!m) continue;
        const el = elementAt(idx, m.start);
        if (!el || !el.isConnected) continue;
        const c = deps.corroborate(el, rec);
        let score = deps.finalScore({ strategy: "text-fuzzy", quality: m.score, corroboration: c, ambiguity: 1 });
        const reasons: AnchorResolution["reasons"] = ["fuzzy"];
        if (idx.truncated) {
          score = Math.min(score, 0.7);
          reasons.push("index-truncated");
        }
        if (score < 0.35) continue; // below approximate: the orphan stands
        const res: AnchorResolution = {
          element: el,
          strategy: "text-fuzzy",
          score,
          state: deps.stateFor(score), // ≤ 0.74 by the hard cap: never 'anchored'
          reasons,
          candidates: 1,
        };
        hits.set(job.id, res);
        job.onSettle(res);
      }
    } finally {
      running = false;
    }
    // Anything still queued is the NEXT pass's work — one yield apart, so a
    // 40-pin page settles over a few seconds instead of one freeze.
    if (queue.length > 0 && !doc.hidden && !dead) {
      await yieldToMain();
      void pump();
    }
  }

  const onVisible = (): void => {
    if (!doc.hidden) void pump();
  };
  doc.addEventListener("visibilitychange", onVisible);

  return {
    enqueue(id, rec, onSettle) {
      if (dead || queued.has(id) || hits.has(id)) return;
      if (!rec.text?.exact || normalizeText(rec.text.exact).length < 8) return; // The design guards
      queued.add(id);
      queue.push({ id, rec, onSettle });
      void pump();
    },
    hit(id) {
      const res = hits.get(id) ?? null;
      if (res && res.element && !res.element.isConnected) {
        // The matched node left the DOM — the cache must not resurrect it.
        hits.delete(id);
        return null;
      }
      return res;
    },
    destroy() {
      dead = true;
      queue.length = 0;
      queued.clear();
      hits.clear();
      index = null;
      doc.removeEventListener("visibilitychange", onVisible);
    },
  };
}

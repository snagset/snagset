import { widgetAttr } from "@snagset/types/names";
import { ambiguity, corroboration, finalScore, stateFor } from "./score.ts";
import { isRendered } from "./geometry.ts";
import { accessibleNameOf, breakpointBucket as bucketFor, pathOf, roleOf } from "./record.ts";
import { normalizeText, pathSimilarity, similarity } from "./similarity.ts";
import type { AnchorReason, AnchorRecord, AnchorResolution, AnchorStrategy } from "./types.ts";

/**
 * snag.anchor-ext.js — the v0.1 half of the cascade.
 *
 * LAZY, and v0 never fetches it: The design makes the v0 cascade `testid` and
 * `css` only, and P8 asserts exactly that. It lives here rather than in
 * the runtime because it is not free — the steps drag the whole corroboration
 * scorer, the similarity helpers and a facet read per candidate with them, and
 * `query(root, "*")` walks every element on the page.
 *
 * It shipped inside `snag.runtime.js` until selector generation landed, and
 * that was load-bearing rather than sloppy: with nothing populating `rec.css`,
 * these fallbacks were the ONLY thing resolving anchors on a page without
 * `data-testid` — which is most pages. Splitting them out only became safe once
 * generation was real.
 *
 * These steps do NOT run at v0, so nothing here is on the critical path today.
 * It is kept building and tested so the v0.1 wiring is a fetch rather than a
 * rewrite.
 */

interface Step {
  strategy: AnchorStrategy;
  applicable(rec: AnchorRecord): boolean;
  find(rec: AnchorRecord, root: ParentNode, caches: PassCaches): Element[];
  /** Per-candidate quality in [0,1]; 1 for exact hits. */
  quality?(el: Element, rec: AnchorRecord): number;
}

/**
 * The per-pass caches — the fix for the per-pin index blow-up. The first
 * version of these steps ran `query(root, "*")` and computed accessible
 * names PER PIN, which the spec's own arithmetic condemns: 40 retrying pins
 * × a full-page walk per pass showed up as thirteen 55 ms tasks in the
 * DoD trace. One index per pass, reused by every pin; caches NEVER survive a
 * pass — a stale accessible name is exactly how a pin anchors confidently to
 * the wrong element.
 */
export interface PassCaches {
  names: WeakMap<Element, string | undefined>;
  ariaIndex?: Map<string, { el: Element; name: string }[]>;
  ariaTruncated?: boolean;
  /** normalised leaf text → elements; the poor-man's exact index for step 5a. */
  textMap?: Map<string, Element[]>;
}

export function createPassCaches(): PassCaches {
  return { names: new WeakMap() };
}

const ARIA_CANDIDATES =
  "[role], a[href], button, input, select, textarea, h1, h2, h3, h4, h5, h6, img, nav, main, [aria-label]";
const ARIA_INDEX_MAX = 2000;
const ARIA_BUCKET_SCAN = 200;

function cachedName(el: Element, caches: PassCaches): string | undefined {
  if (caches.names.has(el)) return caches.names.get(el);
  const n = accessibleNameOf(el);
  caches.names.set(el, n);
  return n;
}

function ariaIndexOf(root: ParentNode, caches: PassCaches): NonNullable<PassCaches["ariaIndex"]> {
  if (caches.ariaIndex) return caches.ariaIndex;
  const index = new Map<string, { el: Element; name: string }[]>();
  let seen = 0;
  for (const el of root.querySelectorAll(ARIA_CANDIDATES)) {
    if (!isNotOurs(el)) continue;
    if (++seen > ARIA_INDEX_MAX) {
      // Same honesty rule as the truncated text index: results cap at
      // approximate, because "we stopped looking" is not "we looked".
      caches.ariaTruncated = true;
      break;
    }
    const role = roleOf(el);
    if (!role) continue;
    const name = cachedName(el, caches);
    if (!name) continue;
    const bucket = index.get(role) ?? [];
    bucket.push({ el, name });
    index.set(role, bucket);
  }
  caches.ariaIndex = index;
  return index;
}

function textMapOf(root: ParentNode, caches: PassCaches): NonNullable<PassCaches["textMap"]> {
  if (caches.textMap) return caches.textMap;
  const map = new Map<string, Element[]>();
  for (const el of root.querySelectorAll("*")) {
    if (el.children.length > 0 || !isNotOurs(el)) continue;
    const key = normalizeText(el.textContent ?? "");
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(el);
    map.set(key, list);
  }
  caches.textMap = map;
  return map;
}

/** Never resolve onto our own UI — the widget must be invisible to itself. */
const isNotOurs = (el: Element): boolean => !el.closest(`[${widgetAttr("root")}]`);

function query(root: ParentNode, selector: string): Element[] {
  return [...root.querySelectorAll(selector)].filter(isNotOurs);
}
function tryQuery(root: ParentNode, selector: string): Element[] {
  try {
    return query(root, selector);
  } catch {
    return [];
  }
}

// `domid` is NOT here — moved it into the resident core (two
// lines, cascade position 2, resolve.ts). A copy in this chunk would run the
// same query twice on every fall-through.
const STEPS: Step[] = [
  {
    strategy: "aria",
    applicable: (r) => !!r.role && !!r.accessibleName,
    // One Map.get plus a Dice pass over the role's bucket, capped — the
    // shape: microseconds per pin against the index built once per pass.
    find: (r, root, caches) => {
      const bucket = ariaIndexOf(root, caches).get(r.role!) ?? [];
      const out: Element[] = [];
      for (const { el, name } of bucket.slice(0, ARIA_BUCKET_SCAN)) {
        if (similarity(name, r.accessibleName!) >= 0.9) out.push(el);
      }
      return out;
    },
  },
  {
    strategy: "text-exact",
    applicable: (r) => !!r.text?.exact,
    // The ONE normalisation on both sides — case-sensitive.
    find: (r, root, caches) => textMapOf(root, caches).get(r.text!.exact) ?? [],
  },
  {
    strategy: "path-rect",
    applicable: (r) => !!r.path?.length,
    /**
     * The ladder, in its order. The old shape here — exact join, else
     * bare leaf tag — jumped straight from "perfect" to "every <button> on
     * the page", which is exactly the candidate flood the intermediate rungs
     * exist to avoid.
     */
    find: (r, root) => {
      const path = r.path!;
      // 1 — the recorded path, verbatim.
      const exact = tryQuery(root, path.join(" > "));
      if (exact.length) return exact.slice(0, 50);
      // 2 — drop `:nth-of-type(n)` from the LEAF UPWARD, one level per
      // iteration. A sibling inserted above the target shifts every index on
      // the way down; the tag skeleton survives. ≤ 4 relaxations, ≤ 50
      // candidates.
      const parts = [...path];
      let relaxed = 0;
      for (let i = parts.length - 1; i >= 0 && relaxed < 4; i--) {
        const bare = parts[i]!.split(":")[0]!;
        if (bare === parts[i]) continue;
        parts[i] = bare;
        relaxed++;
        const found = tryQuery(root, parts.join(" > "));
        if (found.length) return found.slice(0, 50);
      }
      // 3 — drop leading entries; the record may have been captured under a
      // since-removed wrapper. The suffix keeps its child combinators and
      // scopes as a descendant query. ≤ 3 iterations.
      for (let i = 1; i <= 3 && i < path.length; i++) {
        const found = tryQuery(root, path.slice(i).join(" > "));
        if (found.length) return found.slice(0, 50);
      }
      return [];
    },
    quality: (el, r) => pathSimilarity(pathOf(el), r.path ?? []),
  },
];

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Geometry as a TIE-BREAK, bounded at 0.05, never a strategy.
 * `rec.rect` is document-relative CSS px, so both terms are computable;
 * `near` is zero across a breakpoint change BY CONSTRUCTION — a document
 * position captured at 1440 px says nothing at 375 px, and the hard
 * orphan for a changed bucket must never be contradicted by a proximity bonus.
 */
function geometryBonus(el: Element, rec: AnchorRecord, sameBucket: boolean, win: Window): number {
  const r = rec.rect;
  if (!r || r.w < 1 || r.h < 1) return 0;
  const b = el.getBoundingClientRect();
  if (b.width < 1 || b.height < 1) return 0;
  const areaRatio = (b.width * b.height) / (r.w * r.h);
  const aspectRatio = b.width / b.height / (r.w / r.h);
  const shape =
    (1 - clamp01(Math.abs(Math.log2(areaRatio)) / 3)) *
    (1 - clamp01(Math.abs(Math.log2(aspectRatio)) / 2));
  const near = sameBucket
    ? 1 - clamp01(Math.hypot(b.x + win.scrollX - r.x, b.y + win.scrollY - r.y) / (2 * win.innerHeight))
    : 0;
  return 0.05 * (0.6 * shape + 0.4 * near);
}

function facetsOf(el: Element) {
  return {
    tagName: el.tagName,
    role: roleOf(el),
    accessibleName: accessibleNameOf(el),
    textContent: el.textContent ?? "",
    path: pathOf(el),
  };
}



/**
 * Try the v0.1 steps. `null` when they all miss, so the caller can report an
 * honest orphan rather than a fabricated match.
 */
/**
 * The scoring trio + facet reader, packaged for the FUZZY chunk.
 * Injected from HERE, not the runtime: fuzzy only ever escalates after these
 * steps ran and missed, so this module is loaded by construction — and these
 * functions are eager bytes in the runtime but already-paid lazy bytes here.
 */
export const fuzzyDeps = {
  corroborate: (el: Element, rec: AnchorRecord): number => corroboration(facetsOf(el), rec),
  finalScore,
  stateFor,
};

export const resolveExtended = (
  rec: AnchorRecord,
  root: ParentNode,
  ctx: { viewportWidth?: number; caches?: PassCaches },
): AnchorResolution | null => {
  const caches = ctx.caches ?? createPassCaches();
  const reasons: AnchorReason[] = [];

  // A path-rect resolution across a different breakpoint bucket is void: the
  // layout it encodes no longer exists (hard overrides). `sameBucket`
  // is stricter than `!bucketDiffers` — with either side UNKNOWN the hard
  // orphan must not fire, but the proximity bonus must not either.
  const bucketDiffers =
    !!rec.breakpoint && !!ctx.viewportWidth && rec.breakpoint !== bucketFor(ctx.viewportWidth);
  const sameBucket =
    !!rec.breakpoint && !!ctx.viewportWidth && rec.breakpoint === bucketFor(ctx.viewportWidth);

  for (const step of STEPS) {
    if (!step.applicable(rec)) continue;
    const found = step.find(rec, root, caches);
    if (found.length === 0) continue;

    if (step.strategy === "path-rect" && bucketDiffers) {
      return {
        element: null,
        strategy: "path-rect",
        score: 0,
        state: "orphaned",
        reasons: ["breakpoint"],
        candidates: 0,
      };
    }

    // score every candidate against the WHOLE record, then rank. Geometry
    // enters ONLY here, only for path-rect, only as the ≤ 0.05 tie-break.
    const win = (root as Document).defaultView ?? (root.ownerDocument?.defaultView ?? window);
    const scored = found
      .map((el) => {
        const c = corroboration(facetsOf(el), rec);
        const q = step.quality?.(el, rec) ?? 1;
        const g = step.strategy === "path-rect" ? geometryBonus(el, rec, sameBucket, win) : 0;
        return { el, raw: c * q + g, c, q };
      })
      .sort((a, b) => b.raw - a.raw);

    const best = scored[0]!;
    const runnerUp = scored[1]?.raw ?? 0;
    const amb = ambiguity(scored.length, best.raw, runnerUp);

    let score = finalScore({
      strategy: step.strategy,
      quality: best.q,
      corroboration: best.c,
      ambiguity: amb,
    });

    if (scored.length > 1) reasons.push("ambiguous");
    if (!isRendered(best.el)) {
      reasons.push("hidden");
      score = Math.min(score, 0.7);
    }
    if (step.strategy === "aria" && caches.ariaTruncated) {
      reasons.push("index-truncated");
      score = Math.min(score, 0.7);
    }

    return {
      element: best.el,
      strategy: step.strategy,
      score,
      state: stateFor(score),
      reasons: reasons.length ? reasons : ["exact"],
      candidates: scored.length,
    };
  }

  return null;
};

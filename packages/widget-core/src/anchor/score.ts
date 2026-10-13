import { similarity, pathSimilarity, normalizeText } from "./similarity.ts";
import type { AnchorRecord, AnchorStrategy, AnchorState } from "./types.ts";

// Scoring. Every constant here is calibration, and publishes
// the arithmetic consequences as a table — score.test.ts asserts that table
// verbatim, so a change to any constant fails loudly with the row it broke.

export const BASE: Record<AnchorStrategy, number> = {
  testid: 1.0,
  domid: 1.0,
  css: 0.9,
  aria: 0.75,
  "text-exact": 0.8,
  "text-fuzzy": 0.78,
  "path-rect": 0.35,
  none: 0,
  manual: 1.0,
};

/** Explicit hooks are a promise from the codebase; they get a high floor. */
const HOOK: ReadonlySet<AnchorStrategy> = new Set<AnchorStrategy>(["testid", "domid"]);

export const THRESHOLD = { anchored: 0.75, approximate: 0.35 } as const;

const FACET_W = { tag: 0.15, role: 0.2, name: 0.25, text: 0.3, path: 0.1 } as const;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * v0 scorer — no corroboration exists yet, because v0 records no role, name,
 * text or path. Eight lines, and it produces the three states the v0 UI needs.
 */
export function scoreV0(strategy: "testid" | "css", n: number): number {
  const base = BASE[strategy];
  return n === 1 ? base : base / (1 + Math.log2(n));
}

/**
 * Score a candidate against the WHOLE record, not just the facet that found it.
 * Returns 1 when there is nothing to check — neutral, not punitive: a record
 * with no corroborating facets should not be penalised for the absence.
 */
export function corroboration(
  // `| undefined` deliberately: a facet the element genuinely lacks is a real
  // input to corroboration, not a missing argument. exactOptionalPropertyTypes
  // makes that distinction, and here we want the permissive side.
  el: {
    tagName: string;
    role?: string | undefined;
    accessibleName?: string | undefined;
    textContent?: string | undefined;
    path?: string[] | undefined;
  },
  rec: AnchorRecord,
): number {
  let total = 0;
  let hit = 0;
  const leaf = rec.path?.at(-1)?.split(":")[0];

  if (leaf) {
    total += FACET_W.tag;
    if (el.tagName.toLowerCase() === leaf.toLowerCase()) hit += FACET_W.tag;
  }
  if (rec.role) {
    total += FACET_W.role;
    if (el.role === rec.role) hit += FACET_W.role;
  }
  if (rec.accessibleName) {
    total += FACET_W.name;
    hit += FACET_W.name * similarity(el.accessibleName ?? "", rec.accessibleName);
  }
  if (rec.text?.exact) {
    total += FACET_W.text;
    hit += FACET_W.text * similarity(normalizeText(el.textContent ?? "").slice(0, 512), rec.text.exact);
  }
  if (rec.path?.length) {
    total += FACET_W.path;
    hit += FACET_W.path * pathSimilarity(el.path ?? [], rec.path);
  }
  return total === 0 ? 1 : hit / total;
}

/**
 * Ambiguity factor, computed after scoring all n candidates of the winning step.
 * A clear winner is trusted; a tie is punished hard, because a coin-flip between
 * two plausible elements is precisely how a pin becomes silently wrong.
 */
export function ambiguity(n: number, best: number, runnerUp: number): number {
  if (n === 1) return 1;
  if (best - runnerUp >= 0.15) return 0.92;
  return 1 / (1 + Math.log2(n));
}

export interface FinalScoreInput {
  strategy: AnchorStrategy;
  /** Per-strategy quality (e.g. path similarity for path-rect). 1 for exact hits. */
  quality?: number;
  corroboration: number;
  ambiguity: number;
}

export function finalScore(i: FinalScoreInput): number {
  const trust = HOOK.has(i.strategy)
    ? 0.85 + 0.15 * i.corroboration // hooks are authoritative
    : 0.6 + 0.4 * i.corroboration; // everything else must earn it
  let s = BASE[i.strategy] * (i.quality ?? 1) * trust * i.ambiguity;

  // Hard cap: fuzzy text can NEVER reach `anchored`. It is the strategy most
  // likely to be confidently wrong, so it is structurally barred from the state
  // that shows the reviewer no warning.
  if (i.strategy === "text-fuzzy") s = Math.min(s, 0.74);

  return clamp01(s);
}

export function stateFor(score: number): AnchorState {
  if (score >= THRESHOLD.anchored) return "anchored";
  if (score >= THRESHOLD.approximate) return "approximate";
  return "orphaned";
}

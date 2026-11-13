/**
 * String and path similarity for anchor corroboration.
 *
 * `similarity()` is a trigram Dice coefficient, NOT edit distance — a decision,
 * not an accident. Corroboration asks "is this roughly the same label?", not
 * "how many edits apart are these?". Dice is ~15 lines, dependency-free and
 * O(n+m); routing this through a Myers edit-distance engine would drag that
 * engine into the 6 KB anchor core for records that never fuzzy-match.
 */

const CAP = 256;

/**
 * `normalizeText` — the NORMATIVE form, applied identically at creation
 * and at resolution; any divergence between the two is a correctness bug.
 *
 * Order is normative: NFC first (folding must see composed forms), zero-width
 * removal before folding (a ZWJ must not split a fold target), whitespace
 * collapse last (so the ellipsis expansion cannot leave an uncollapsed run).
 * The FOLD step is the load-bearing one in practice: typography plugins and
 * CMS paste-normalisation rewrite `'` into its curly form between deploys,
 * which would otherwise turn every quote containing an apostrophe fuzzy.
 *
 * NOT LOWERCASED — the explicit rejection. Case is real signal (`Save` vs
 * `SAVE` is a design change worth surfacing), and the trigram/fuzzy layers
 * charge a visible penalty for a case flip rather than hiding it. The M1 form
 * of this function lowercased; records written before therefore carry a
 * lowercased `text.exact`, which the corroboration layers absorb as a
 * near-match rather than a miss — pre-release local data, accepted.
 *
 * Explicit \uXXXX escapes only; no literal non-ASCII may appear in source.
 */
// ZWSP, ZWNJ, ZWJ, word joiner, BOM
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/gu;
// ASCII whitespace + NBSP, OGHAM SPACE, EN..HAIR spaces, LS, PS, NNBSP, MMSP, IDEOGRAPHIC SPACE
const WHITESPACE = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/gu;
const FOLD: [RegExp, string][] = [
  [/[\u2018\u2019\u201A\u201B]/gu, "'"], // curly single quotes  -> ASCII apostrophe
  [/[\u201C\u201D\u201E\u201F]/gu, '"'], // curly double quotes  -> ASCII quote
  [/[\u2010-\u2015\u2212]/gu, "-"], // hyphen, en/em dash, minus sign
  [/\u2026/gu, "..."], // ellipsis
  [/\u2044/gu, "/"], // fraction slash
];

export function normalizeText(s: string): string {
  let t = s.normalize("NFC").replace(ZERO_WIDTH, "");
  for (const [re, to] of FOLD) t = t.replace(re, to);
  return t.replace(WHITESPACE, " ").trim();
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Trigram Dice coefficient in [0,1]. Both sides capped at 256 chars. */
export function similarity(a: string, b: string): number {
  const x = normalizeText(a).slice(0, CAP);
  const y = normalizeText(b).slice(0, CAP);
  if (x === y) return 1;
  if (!x || !y) return 0;

  const A = trigrams(x);
  const B = trigrams(y);
  if (A.size === 0 || B.size === 0) return 0;

  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/**
 * Longest common SUFFIX of tag-name paths ÷ the longer length.
 *
 * Suffix, deliberately: ancestors are what get re-wrapped when a framework
 * changes its layout components, while the element's immediate lineage is the
 * stable part. A prefix comparison would score a re-wrapped-but-identical
 * element near zero, which is exactly the false orphan we are trying to avoid.
 */
export function pathSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;

  let common = 0;
  while (
    common < a.length &&
    common < b.length &&
    bare(a[a.length - 1 - common]!) === bare(b[b.length - 1 - common]!)
  ) {
    common++;
  }
  return common / max;
}

/** `div:nth-of-type(3)` → `div` — positional suffixes are churn, not identity. */
function bare(seg: string): string {
  return seg.split(":")[0]!.toLowerCase();
}

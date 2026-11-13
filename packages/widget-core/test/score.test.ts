import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreV0, corroboration, ambiguity, finalScore, stateFor, THRESHOLD } from "../src/anchor/score.ts";
import { similarity, pathSimilarity } from "../src/anchor/similarity.ts";
import type { AnchorRecord } from "../src/anchor/types.ts";

const near = (a: number, b: number, msg: string, eps = 0.005) =>
  assert.ok(Math.abs(a - b) < eps, `${msg}: expected ~${b}, got ${a.toFixed(4)}`);

// ─────────────────────────────────────────────────────────────────────────────
// Publishes a calibration table — the arithmetic consequences of the
// scoring constants. It is a free, authoritative oracle, so it is asserted
// verbatim: change any constant and the failing row names what you broke.
// ─────────────────────────────────────────────────────────────────────────────

test("Calibration — testid rows", () => {
  near(finalScore({ strategy: "testid", corroboration: 1, ambiguity: 1 }), 1.0, "unique, everything corroborates");
  near(finalScore({ strategy: "testid", corroboration: 0, ambiguity: 1 }), 0.85, "unique, label completely rewritten");
  near(finalScore({ strategy: "testid", corroboration: 1, ambiguity: 0.92 }), 0.92, "shared testid, corroboration separates");
  // two elements, indistinguishable → ambiguity 1/(1+log2(2)) = 0.5
  near(finalScore({ strategy: "testid", corroboration: 1, ambiguity: ambiguity(2, 0.9, 0.9) }), 0.5, "shared testid, indistinguishable");
});

test("Calibration — css, aria, text, path-rect rows", () => {
  near(finalScore({ strategy: "css", corroboration: 1, ambiguity: 1 }), 0.9, "css, all facets agree");
  near(finalScore({ strategy: "css", corroboration: 0.5, ambiguity: 1 }), 0.72, "css, half the facets disagree");
  near(finalScore({ strategy: "aria", corroboration: 1, ambiguity: 1 }), 0.75, "aria, full corroboration (anchored, just)");
  near(finalScore({ strategy: "text-exact", corroboration: 1, ambiguity: 1 }), 0.8, "exact text, full corroboration");
  near(finalScore({ strategy: "path-rect", corroboration: 1, ambiguity: 1 }), 0.35, "path-rect, perfect path (approximate, just)");
  // The "path-rect, 50 % path similarity → 0.14". Reaching 0.14 requires
  // corroboration ALSO at 0.5, which is the correct reading: `path` is both the
  // strategy's quality input and one of the corroboration facets, so a halved
  // path degrades the score twice. 0.35 × 0.5 × (0.6 + 0.4×0.5) = 0.14.
  const halfPath = pathSimilarity(["div", "span"], ["section", "span"]);
  assert.equal(halfPath, 0.5, "sanity: the fixture really is 50% similar");
  near(
    finalScore({ strategy: "path-rect", quality: halfPath, corroboration: 0.5, ambiguity: 1 }),
    0.14,
    "path-rect, 50% path similarity",
  );
  assert.equal(stateFor(0.14), "orphaned", "and the design says that row is orphaned");
});

test("the rows land in the states the table says they do", () => {
  assert.equal(stateFor(1.0), "anchored");
  assert.equal(stateFor(0.85), "anchored");
  assert.equal(stateFor(0.92), "anchored");
  assert.equal(stateFor(0.5), "approximate");
  assert.equal(stateFor(0.75), "anchored", "0.75 is anchored — the boundary is inclusive");
  assert.equal(stateFor(0.35), "approximate", "0.35 is approximate — inclusive");
  assert.equal(stateFor(0.3499), "orphaned");
  assert.equal(stateFor(0.14), "orphaned");
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PROPERTY S2 EXISTS TO MEASURE. A pin that confidently points at the wrong
// element is worse than an orphan: one instance destroys the value of every
// correct instance. These are the structural guarantees that make that rare.
// ─────────────────────────────────────────────────────────────────────────────

test("fuzzy text can NEVER reach `anchored`, whatever else agrees", () => {
  const best = finalScore({ strategy: "text-fuzzy", corroboration: 1, ambiguity: 1 });
  assert.ok(best <= 0.74, `fuzzy capped at 0.74, got ${best}`);
  assert.equal(stateFor(best), "approximate");
  assert.ok(best < THRESHOLD.anchored, "the cap must sit strictly below the anchored threshold");
});

test("a coin-flip between two candidates cannot be `anchored`", () => {
  // Two indistinguishable candidates: even a perfect testid hit must degrade,
  // because picking one at random is how a pin becomes silently wrong.
  const s = finalScore({ strategy: "testid", corroboration: 1, ambiguity: ambiguity(2, 0.9, 0.9) });
  assert.equal(stateFor(s), "approximate");
});

test("ambiguity rewards a clear winner and punishes a tie", () => {
  assert.equal(ambiguity(1, 1, 0), 1, "single candidate is unambiguous");
  assert.equal(ambiguity(2, 0.9, 0.7), 0.92, "0.2 apart → corroboration disambiguated it");
  near(ambiguity(2, 0.9, 0.89), 0.5, "0.01 apart → punished");
  near(ambiguity(4, 0.9, 0.9), 1 / 3, "four-way tie → punished harder");
});

test("v0 scorer: one hit anchors, two hits degrade to approximate", () => {
  assert.equal(scoreV0("testid", 1), 1.0);
  assert.equal(stateFor(scoreV0("testid", 1)), "anchored");
  near(scoreV0("css", 1), 0.9, "unique css");
  near(scoreV0("testid", 2), 0.5, "two testid hits");
  assert.equal(stateFor(scoreV0("testid", 2)), "approximate");
  near(scoreV0("css", 2), 0.45, "two css hits");
  assert.equal(stateFor(scoreV0("css", 2)), "approximate");
});

// ─────────────────────────────────────────────────────────────────────────────
// Corroboration
// ─────────────────────────────────────────────────────────────────────────────

const rec: AnchorRecord = {
  role: "button",
  accessibleName: "Continue",
  // Case-preserved — rejects lowercasing because a case flip
  // is a copy change reviewers care about. Records from before then carried
  // "continue"; the similarity layer absorbs those as near-matches.
  text: { exact: "Continue" },
  path: ["div", "form", "button"],
  label: "the Continue button",
};

test("corroboration: a survived rewrite still corroborates", () => {
  // A Continue button through a total component-library rewrite: new markup,
  // new classes, new DOM path — but the same affordance. 03 calls this RIGHT.
  const c = corroboration(
    { tagName: "BUTTON", role: "button", accessibleName: "Continue", textContent: "Continue", path: ["main", "section", "button"] },
    rec,
  );
  assert.ok(c > 0.85, `a rewrapped-but-identical button should corroborate strongly, got ${c.toFixed(3)}`);
});

test("corroboration: a different affordance does not corroborate", () => {
  const c = corroboration(
    { tagName: "A", role: "link", accessibleName: "Cancel", textContent: "Cancel", path: ["div", "nav", "a"] },
    rec,
  );
  assert.ok(c < 0.35, `a different affordance must score low, got ${c.toFixed(3)}`);
  // …and low corroboration on a non-hook strategy must not reach anchored.
  assert.equal(stateFor(finalScore({ strategy: "css", corroboration: c, ambiguity: 1 })), "approximate");
});

test("corroboration is neutral, not punitive, when there is nothing to check", () => {
  assert.equal(corroboration({ tagName: "BUTTON" }, { label: "x" }), 1);
});

test("similarity: trigram Dice behaves at the edges", () => {
  assert.equal(similarity("Continue", "Continue"), 1);
  assert.equal(similarity("Continue", "Continue  "), 1, "whitespace folds");
  // NOT case-insensitive: a case flip is a visible penalty, not a
  // hidden equality — the rejection of case folding, working as designed.
  const flipped = similarity("Continue", "continue");
  assert.ok(flipped > 0.5 && flipped < 1, `a case flip is near but not equal, got ${flipped.toFixed(3)}`);
  // Typography folding IS normalisation: a smart-quote pass must not degrade a
  // quote (the load-bearing FOLD case).
  assert.equal(similarity("It’s fine — ship it", 'It\'s fine - ship it'), 1);
  assert.ok(similarity("Save", "Save changes") > 0.4, "a label that grew is still similar");
  assert.ok(similarity("Continue", "Delete account") < 0.2, "unrelated labels are not");
  assert.equal(similarity("", "anything"), 0);
});

test("pathSimilarity compares SUFFIXES, because ancestors get re-wrapped", () => {
  assert.equal(pathSimilarity(["div", "form", "button"], ["div", "form", "button"]), 1);
  // Two new wrapper layers, same element lineage → still strong.
  assert.ok(
    pathSimilarity(["form", "button"], ["div", "section", "form", "button"]) >= 0.5,
    "re-wrapping must not destroy the score",
  );
  // Same ancestors, different leaf → weak, which is the case that matters.
  assert.ok(pathSimilarity(["div", "form", "button"], ["div", "form", "a"]) < 0.4);
  assert.equal(pathSimilarity(["div", "button:nth-of-type(2)"], ["div", "button"]), 1, "positional suffixes are churn");
});

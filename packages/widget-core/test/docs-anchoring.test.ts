import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The anchoring page prints NUMBERS, so the numbers are checked.
 *
 * A confidence table is the kind of documentation that is written once against
 * a correct reading and then silently becomes fiction the first time somebody
 * tunes a score. It is also the table a developer uses to decide whether adding
 * `data-testid` is worth the effort, so being wrong about it changes what they
 * do.
 */

const HERE = import.meta.dirname;
const SCORE = readFileSync(join(HERE, "..", "src", "anchor", "score.ts"), "utf8");
const PAGE = readFileSync(join(HERE, "..", "..", "..", "docs", "anchoring.md"), "utf8");

function baseScores(): Record<string, string> {
  const start = SCORE.indexOf("export const BASE");
  const body = SCORE.slice(start, SCORE.indexOf("};", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s+"?([a-z-]+)"?:\s*([0-9.]+),/gm)) out[m[1]!] = m[2]!;
  return out;
}

test("every strategy's confidence on the page is the one in the code", () => {
  const wrong: string[] = [];
  for (const [strategy, score] of Object.entries(baseScores())) {
    // `none` and `manual` are not reader-facing: one is the absence of a match,
    // the other is a repair a person made by hand.
    if (strategy === "none" || strategy === "manual") continue;
    const row = new RegExp(`\\\`${strategy}\\\`\\s*\\|\\s*([0-9.]+)`).exec(PAGE);
    if (!row) wrong.push(`${strategy} is not on the page`);
    else if (Number(row[1]) !== Number(score)) wrong.push(`${strategy}: page ${row[1]}, code ${score}`);
  }
  assert.deepEqual(wrong, []);
});

test("the two state thresholds on the page are the ones enforced", () => {
  const t = /THRESHOLD = \{ anchored: ([0-9.]+), approximate: ([0-9.]+) \}/.exec(SCORE);
  assert.ok(t, "THRESHOLD is where the states are decided");
  assert.ok(PAGE.includes(`≥ ${t[1]}`), `the page should say ≥ ${t[1]} for anchored`);
  assert.ok(PAGE.includes(`≥ ${t[2]}`), `the page should say ≥ ${t[2]} for approximate`);
});

test("the page's claim that text-fuzzy cannot reach `anchored` is true", () => {
  // The page tells a reader a near-text-match is "a good guess and not a fact".
  // That is only true while the cap is below the anchored threshold.
  const cap = /i\.strategy === "text-fuzzy"\) s = Math\.min\(s, ([0-9.]+)\)/.exec(SCORE);
  const anchored = /anchored: ([0-9.]+)/.exec(SCORE);
  assert.ok(cap && anchored);
  assert.ok(
    Number(cap[1]) < Number(anchored[1]),
    `text-fuzzy caps at ${cap[1]} and anchored begins at ${anchored[1]} — the page's claim would be false`,
  );
});

test("the page's geometry claim matches the bound in the code", () => {
  assert.match(PAGE, /tie-break only.*capped at 0\.05/is);
  const ext = readFileSync(join(HERE, "..", "src", "anchor", "ext.ts"), "utf8");
  assert.match(ext, /bounded at 0\.05, never a strategy/);
});

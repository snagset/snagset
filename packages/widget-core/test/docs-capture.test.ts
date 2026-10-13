import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The capture page is a PRIVACY CLAIM, so it is checked against the code.
 *
 * This is the page a client's security team reads, and the one sentence in it
 * that is wrong is the one that ends a deal. Two directions, and the second
 * matters more here than anywhere else on the site:
 *
 *   · Every selector the page says is masked must actually be masked.
 *   · Every selector the screenshot code masks must be ON the page — because a
 *     mask we added and did not document is a promise we are keeping and not
 *     getting credit for, and one we later REMOVE silently is a page that lies.
 */

const HERE = import.meta.dirname;
const MASKS = readFileSync(join(HERE, "..", "src", "screenshot", "capture.ts"), "utf8");
const PAGE = readFileSync(join(HERE, "..", "..", "..", "docs", "capture.md"), "utf8");

/** The always-on selectors, read out of `maskSelectorList`'s `base`. */
function builtinMasks(): string[] {
  const start = MASKS.indexOf("const base = [");
  assert.notEqual(start, -1, "maskSelectorList builds a `base` array");
  const body = MASKS.slice(start, MASKS.indexOf("];", start));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

test("every selector the screenshot code masks is on the page", () => {
  // The first run of this caught the page dropping the ` i` case-insensitivity
  // flags off two selectors — `autocomplete="CC-Number"` IS masked, and a page
  // that says otherwise understates the product to the person least likely to
  // give it the benefit of the doubt.
  const undocumented = builtinMasks().filter((sel) => !PAGE.includes(sel));
  assert.deepEqual(
    undocumented,
    [],
    "these are masked and unmentioned — a promise kept without credit, and one that could be " +
      "removed later without the page noticing",
  );
});

test("the page does not claim a mask that is not applied", () => {
  // Fenced block only: the prose around it names `data-snag-mask` and the two
  // classes, which are built from the constants module rather than literals.
  const block = /```\n(input\[type="password"\][\s\S]*?)```/.exec(PAGE)?.[1] ?? "";
  assert.ok(block, "the page lists the built-in selectors in a fenced block");
  const claimed = block.split("\n").map((l) => l.trim()).filter(Boolean);
  const actual = builtinMasks();
  const overclaimed = claimed.filter((sel) => !actual.includes(sel));
  assert.deepEqual(overclaimed, [], "these are documented as masked and are not");
});

test("mask-all covers the four element kinds the code adds", () => {
  const start = MASKS.indexOf("if (opts.maskAllInputs)");
  const line = MASKS.slice(start, MASKS.indexOf("\n", start + 30));
  for (const kind of [...line.matchAll(/"([a-z[\]-]+)"/g)].map((m) => m[1]!)) {
    assert.ok(PAGE.includes(kind), `mask-all adds ${kind} and the page does not say so`);
  }
});

test("the page's own promise about config is true in the code", () => {
  // "Your selectors add to the built-in list; they never replace it." A config
  // that shortened the list would undress a password field.
  assert.match(PAGE, /never replace it/);
  assert.match(
    MASKS,
    /return \[\.\.\.base, \.\.\.\(opts\.maskSelectors \?\? \[\]\)\]/,
    "config is spread AFTER base, so it can only add",
  );
});

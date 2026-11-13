import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The kill-switches page describes the gates that EXIST — both directions.
 *
 * Same reasoning as `docs-api.test.ts`, and the same failure it was written to
 * prevent: a page that advertises a switch we do not implement sends a client
 * to production believing the widget is off. The reverse rots quietly — adding
 * a gate and not documenting it means the one person who needed it never finds
 * it.
 *
 * The gates are read out of `loader/policy.ts` rather than out of a list
 * somebody maintains, because a list somebody maintains is the thing that
 * drifts.
 */

const HERE = import.meta.dirname;
const POLICY = readFileSync(join(HERE, "..", "src", "loader", "policy.ts"), "utf8");
const PAGE = readFileSync(join(HERE, "..", "..", "..", "docs", "kill-switches.md"), "utf8");

/** Every `gate: "…"` the policy can return. */
function gates(): string[] {
  return [...POLICY.matchAll(/gate:\s*"([a-z-]+)"/g)].map((m) => m[1]!);
}

/**
 * What the page must say for each gate to count as documented.
 *
 * The token, not the gate NAME — a reader never sees `disabled-attr`, they see
 * `data-snag-disabled`. Documenting the internal name would satisfy a test and
 * help nobody.
 */
const EVIDENCE: Record<string, string> = {
  "disabled-global": "__SNAGSET_DISABLED__",
  "disabled-config": "SnagsetConfig",
  "disabled-attr": "data-snag-disabled",
  "off-switch": "snag_off",
  automation: "navigator.webdriver",
  "mode-off": 'data-snag-mode="off"',
  "no-review-token": "auto",
  "config-disabled": "SnagsetConfig",
  "origin-not-allowed": "allowedOrigins",
};

test("every gate the loader can return is on the page", () => {
  const missing = [...new Set(gates())].filter((g) => {
    const evidence = EVIDENCE[g];
    return !evidence || !PAGE.includes(evidence);
  });
  assert.deepEqual(
    missing,
    [],
    "these gates are implemented and undocumented — a switch nobody can find is a switch nobody uses",
  );
});

test("the page's ordered table lists as many rows as there are gates", () => {
  // The order is the product's behaviour: the first match wins, and a reader
  // debugging "why is it off" walks the table top to bottom.
  const rows = [...PAGE.matchAll(/^\| \d+ \| /gm)].length;
  assert.equal(
    rows,
    new Set(gates()).size,
    `the table has ${rows} rows and the loader has ${new Set(gates()).size} gates`,
  );
});

test("the page does not promise a switch that does not exist", () => {
  // The `docs-api` failure, in this shape: a documented `data-snag-*` attribute
  // the loader never reads would be a client shipping to production believing
  // the widget is off.
  const documented = [...PAGE.matchAll(/`(data-snag-[a-z-]+)`/g)].map((m) => m[1]!);
  const known = readFileSync(join(HERE, "..", "..", "types", "src", "names.ts"), "utf8");
  const unknown = [...new Set(documented)].filter((a) => !known.includes(`"${a}"`));
  assert.deepEqual(unknown, [], "these attributes are documented and not in the registry");
});

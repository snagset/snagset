import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY } from "../src/config.generated.ts";

/**
 * The identity page prints the permission list, the write modes and four
 * defaults. All four are read from config or from code here.
 *
 * A docs page that names a default is making a promise about what happens to
 * somebody who changes nothing — which is almost everybody. `write_mode` in
 * particular decides who may write to a client's live site, so "open for 24
 * hours" being wrong in either direction is a real problem: too long and a
 * forgotten site is a public comment box, too short and the first pin fails.
 */

const HERE = import.meta.dirname;
const PAGE = readFileSync(join(HERE, "..", "..", "..", "docs", "identity.md"), "utf8");
const LINKS = readFileSync(join(HERE, "..", "src", "routes", "reviewLinks.ts"), "utf8");
const SCHEMA = readFileSync(join(HERE, "..", "src", "db", "migrations", "0001_init.sql"), "utf8");

function listFrom(name: string): string[] {
  const start = LINKS.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} is where the list lives`);
  return [...LINKS.slice(start, LINKS.indexOf("]", start)).matchAll(/"([a-z:]+)"/g)].map((m) => m[1]!);
}

test("every permission a link can carry is on the page", () => {
  const known = listFrom("KNOWN");
  const missing = known.filter((p) => !PAGE.includes(`\`${p}\``));
  assert.deepEqual(missing, [], "a permission nobody can find is a permission nobody grants");
  // And nothing invented: the page must not offer one the route would refuse.
  const documented = [...PAGE.matchAll(/`(thread:[a-z:]+|comment:[a-z:]+)`/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(documented)].filter((p) => !known.includes(p)), []);
});

test("the ticked defaults are the ones the route actually applies", () => {
  const defaults = listFrom("DEFAULT_PERMISSIONS");
  for (const p of listFrom("KNOWN")) {
    // The row is "| `perm` | ✅ |" or "| `perm` | — |".
    const row = new RegExp(`\\| \`${p}\` \\| (✅|—) \\|`).exec(PAGE);
    assert.ok(row, `${p} has no row`);
    assert.equal(
      row[1] === "✅",
      defaults.includes(p),
      `${p}: page says ${row[1]}, route says ${defaults.includes(p)}`,
    );
  }
});

test("the three write modes are the three the schema allows", () => {
  const modes = [...(/snag_write_mode\s+AS ENUM \(([^)]+)\)/.exec(SCHEMA)?.[1] ?? "").matchAll(/'([a-z-]+)'/g)]
    .map((m) => m[1]!);
  assert.equal(modes.length, 3);
  for (const m of modes) assert.ok(PAGE.includes(`\`${m}\``), `${m} is not on the page`);
});

test("the numbers on the page are the registry's defaults", () => {
  const def = (name: string) => REGISTRY.find((r) => r.name === name)?.default;
  // "open for 24 hours", "14 days unless you say otherwise", "15 minutes
  // sliding, 12 hours absolute".
  assert.equal(def("SNAGSET_WRITE_MODE_GRACE_HOURS"), "24");
  assert.match(PAGE, /24 hours/);
  assert.equal(def("SNAGSET_REVIEW_LINK_TTL_DAYS"), "14");
  assert.match(PAGE, /14 days/);
  assert.equal(def("SNAGSET_SESSION_TTL_S"), String(15 * 60));
  assert.match(PAGE, /15 minutes sliding/);
  assert.equal(def("SNAGSET_SESSION_ABSOLUTE_TTL_S"), String(12 * 60 * 60));
  assert.match(PAGE, /12\s*\n?\s*hours absolute/);
});

test("the page names the variable that changes the grace window", () => {
  // Otherwise "it closes on its own" reads as something you cannot control.
  assert.match(PAGE, /SNAGSET_WRITE_MODE_GRACE_HOURS/);
});

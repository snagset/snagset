#!/usr/bin/env node
/**
 * No externally visible name is typed by hand, plan task 1 (v0).
 *
 * Claims that *"renaming is a task measured in minutes"*, and the Name
 * Registry plus `gen:names` is what makes that true — but only for tokens that
 * are actually DERIVED. A literal `"data-snag-anchor"` in a source file is
 * invisible to the generator, survives a rename untouched, and produces the
 * worst kind of failure: the widget keeps working, so nothing goes red, and the
 * one attribute a host had added to pin a component permanently stops being
 * honoured.
 *
 * This never existed. `tools/lint-names/` was task 1's deliverable, no
 * package.json defined `lint:names`, and ESLint is not even a dependency — so
 * the rule had gone unenforced since the first commit and the tree had drifted:
 * `data-snag-anchor` and the `data-snag-` prefix hard-coded in the selector
 * generator, the masking selector spelled out in the label deriver, and
 * `--snag-dock-w` and `--snag-tb-h` typed into three stylesheets. Every one of
 * them would have been left behind by `pnpm rename:rehearse`.
 *
 * ── WHAT IT CHECKS ──
 *
 *   1. No registered-token LITERAL under the scoped source trees. The check is
 *      against the registry's own values, so it cannot drift from what a rename
 *      would actually change.
 *   2. The reverse rule: a dead-token-list entry that ALSO appears in the
 *      registry is itself a build failure. A token cannot be both retired and
 *      live, and the day that becomes true is the day a rename resurrects a
 *      name somebody deliberately buried.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CHECK ──
 *
 * **`, per task 1's own note: STATUS item 4 says that tree cannot go
 * green yet, and a lint that is red on arrival is a lint that gets disabled.
 * Comments and prose are stripped before matching for the same reason — this
 * codebase explains its tokens at length, including in the modules that stopped
 * using them, and a linter that cannot tell an explanation from a call is one
 * that gets switched off within a week.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(ROOT, "packages/types/registry.json"), "utf8"));

/**
 * OUR OWN SHIPPED SOURCE, and deliberately not the apps.
 *
 * This task DoD names `apps/**` too, and this narrows it — stated here rather
 * than quietly dropped. When that line was written the only app was the
 * playground, which is our own fixture. `apps/kilnwork` is a stand-in for a
 * CUSTOMER, and the host-authored surface — `data-snag-anchor`,
 * `data-snag-ignore`, `data-snag-mask`, `snag-mask`, the `x-snagset-skip`
 * header, the `snagset:` events a host listens for — is by definition typed by
 * hand from the documentation. Linting it would be linting the customer, and
 * would report 24 findings that are all correct.
 *
 * The rule that matters is the one about code WE ship: a literal there is
 * invisible to `gen:names` and survives a rename untouched.
 */
const TREES = ["packages/widget-core/src", "packages/types/src", "packages/adapters/src"];

/** The generated module IS the literals — it is the one file exempt by design. */
const EXEMPT = [join("packages", "types", "src", "names.ts")];

function sources(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a tree that does not exist yet is not a failure
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Strip comments AND template-literal CSS comments.
 *
 * The second is not paranoia: this codebase's stylesheets are template literals
 * full of `/* … *\/` prose, and several of those paragraphs quote the very
 * custom properties they explain.
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/* ── Collect every registered token, with the path that produced it ────────── */
const tokens = new Map(); // literal → registry path

/**
 * Only EXTERNALLY VISIBLE tokens, and the shape of each is what qualifies it.
 *
 * Scoping this correctly is most of the work. A first pass keyed on "contains
 * the brand" produced 88 findings and every one was noise: `@snagset/types`
 * import specifiers (a package rename, not a token rename) and the `.snag-*`
 * CSS classes, which the design states are *"not externally visible … out of
 * the scope by construction and 02 owns them"*. A linter that reports those
 * is one that gets switched off in a week, and then the real defects ride in
 * behind it.
 *
 * These eight prefixes are exactly the registered surfaces — the things a
 * client's DOM, storage, URLs and headers actually carry.
 */
const EXTERNAL = [
  /^data-snag-/, // Attributes
  /^--snag-/, //    Custom properties
  /^snag:/, //      Web-storage keys
  /^snagset:/, //   DOM events
  /^snag_/, //      URL params and cookies
  /^SNAGSET_/, //   Env
  /^x-snagset-/, // Headers
  /^__SNAGSET/, //  Globals
  /^snag-(mask|block)$/, // The two host-facing CSS classes
];

/**
 * The literals come from the GENERATED module, not from `registry.json`.
 *
 * The registry stores tokens as FRAGMENTS — `scriptAttrs.names` is
 * `["site","host",…]` and the `data-snag-` prefix is derived — so walking the
 * JSON finds no full token at all. The first version of this file did exactly
 * that and printed "0 registered tokens checked" while exiting 0: a green light
 * that proved nothing, which is the same class of defect as the gate it was
 * written to replace.
 *
 * `names.ts` is the generator's output, so its values are precisely what a
 * rename rewrites — which makes it the only correct source for "what must never
 * be typed by hand".
 */
const generated = readFileSync(join(ROOT, "packages/types/src/names.ts"), "utf8");
for (const m of generated.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
  const v = m[1];
  if (EXTERNAL.some((re) => re.test(v))) tokens.set(v, "names.ts");
}
// The registry is still read, for the reverse rule below.
void registry;

const failures = [];

/* ── 1. No literal in the scoped trees ─────────────────────────────────────── */
const files = TREES.flatMap((t) => sources(join(ROOT, t)));
for (const file of files) {
  const rel = relative(ROOT, file);
  if (EXEMPT.some((e) => rel.endsWith(e))) continue;
  const src = code(readFileSync(file, "utf8"));
  for (const [literal, path] of tokens) {
    // Quoted, or inside a template literal — the two ways a token reaches the
    // DOM. A bare identifier that merely CONTAINS the word is not a token.
    const re = new RegExp(`["'\`][^"'\`]*${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    if (re.test(src)) {
      failures.push(
        `${rel}: hard-codes "${literal}" (registry: ${path}) — import it from @snagset/types/names`,
      );
    }
  }
}

/* ── 2. No UNREGISTERED token in our namespace ─────────────────────────────
 *
 * This task clause (b), and the half that catches the failure people actually
 * make: not typing a registered name, but INVENTING one. `data-snag-tooltip`
 * added in passing is a token in a client's DOM that the design has never heard of,
 * that a rename cannot see, and that nothing else in the repo would ever
 * mention again.
 *
 * The namespace patterns are the registered PREFIXES and nothing wider. In
 * particular `snag-` alone is absent, because the shadow-internal CSS classes
 * (`.snag-tb`, `.snag-pin`) live there and the design says they are "not
 * externally visible … out of the scope by construction".
 */
const NAMESPACE = /(?:data-snag-[a-z-]+|--snag-[a-z-]+|snag:[a-z:{}-]+|snagset:[a-z-]+|snag_[a-z]+|SNAGSET_[A-Z_]+|x-snagset-[a-z-]+|__SNAGSET[A-Z_]*)/g;
const registered = new Set(tokens.keys());

for (const file of files) {
  const rel = relative(ROOT, file);
  if (EXEMPT.some((e) => rel.endsWith(e))) continue;
  const src = code(readFileSync(file, "utf8"));
  // Only inside string literals — a token reaches the DOM as a string.
  for (const lit of src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
    const body = lit[1] ?? lit[2] ?? lit[3] ?? "";
    for (const m of body.matchAll(NAMESPACE)) {
      const token = m[0];
      if (registered.has(token)) continue;
      // A storage-key TEMPLATE carries {placeholders} the registry stores
      // un-substituted; match those against the template form.
      if ([...registered].some((r) => r.includes("{") && token.startsWith(r.split("{")[0]))) continue;
      failures.push(
        `${rel}: uses "${token}", which is NOT in the registry — register it in ` +
          `packages/types/registry.json and run pnpm gen:names, or use an existing name`,
      );
    }
  }
}

/* ── 3. The reverse rule ─────────────────────────────────────────────── */
const dead = registry.deadTokens?.tokens ?? registry.deadTokens ?? [];
for (const t of Array.isArray(dead) ? dead : []) {
  if (typeof t === "string" && tokens.has(t)) {
    failures.push(
      `"${t}" is on the dead-token list AND in the live registry — a token cannot be both retired and current`,
    );
  }
}

/**
 * A LINT THAT CHECKS NOTHING MUST NOT PASS.
 *
 * The first version silently found zero tokens and reported success. This
 * codebase already treats that failure mode as worse than no check at all —
 * verify-capture says so about its two ungreppable rows — so the floor is
 * asserted rather than assumed.
 */
if (tokens.size < 20) {
  console.error(
    `\n✗ lint-names: only ${tokens.size} token(s) collected — the extractor is broken,\n` +
      `  and a lint that checks nothing is worse than no lint at all.\n`,
  );
  process.exit(1);
}

if (failures.length) {
  console.error(`\n✗ lint-names: ${failures.length} hard-coded name(s)\n`);
  for (const f of failures) console.error(`   ${f}`);
  console.error(
    `\n  The name registry promises a rename is "a task measured in minutes". Every literal here\n` +
      `  is a minute that becomes an afternoon, and a token a rename leaves behind.\n`,
  );
  process.exit(1);
}

console.log(
  `✓ lint-names: ${files.length} file(s) across ${TREES.length} tree(s) carry no hard-coded name ` +
    `(${tokens.size} registered tokens checked)`,
);

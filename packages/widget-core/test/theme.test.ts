import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CSS_VAR, CSS_VAR_GROUPS, scriptAttr } from "@snagset/types/names";
import { TOKENS_CSS, t, themePref } from "../src/runtime/theme.ts";
import { STATUS } from "../src/storage/types.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

/**
 * Source with comments removed.
 *
 * These scans look for CSS declarations, and the files explaining WHY a
 * declaration must not appear are otherwise indistinguishable from the
 * declaration itself — the first version of this test failed on its own
 * comments in toolbar.ts and dock.tsx.
 */
const code = (file: string): string =>
  readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Rule bodies of the token block, in order, with CSS comments stripped first —
 * an explanatory comment before a rule would otherwise be parsed as part of its
 * selector.
 */
function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.trim(),
    body: m[2]!.trim(),
  }));
}

/** The `:host` rules specifically, found by SELECTOR rather than by position. */
const hostRules = (css: string) => rules(css).filter((r) => r.selector === ":host");

test("`all: initial` is its OWN rule, and the tokens are in a later one", () => {
  // Task 29 makes this a DoD on the CSS STRING, not a rendering
  // test, because the failure is silent: `all` resets everything declared
  // before it IN THE SAME RULE, so a merged block defines custom properties
  // and then wipes them, and the widget renders unstyled with no error.
  const [first, second] = hostRules(TOKENS_CSS);
  assert.match(first!.body, /^all:\s*initial;?$/, "rule 1 is `all:initial` and NOTHING else");
  assert.ok(second!.body.includes(CSS_VAR.bg), "the tokens live in a LATER rule of the same selector");
  // Order is the whole mechanism: same specificity, so the later one wins.
  // Compared on the SOURCE, by landmark — the parsed bodies have had comments
  // stripped and no longer appear verbatim in it.
  assert.ok(
    TOKENS_CSS.indexOf("all:initial") < TOKENS_CSS.indexOf(CSS_VAR.bg),
    "`all:initial` must come BEFORE the tokens, or it wipes them",
  );
});

test("no OTHER stylesheet in the widget declares `all: initial`", () => {
  // A second one, in a sheet installed after the token block, resets every
  // custom property the tokens define. theme.ts owns it; nothing else may.
  const offenders = sources()
    .filter((f) => !f.endsWith(join("runtime", "theme.ts")))
    .filter((f) => /all\s*:\s*initial/.test(code(f)));
  assert.deepEqual(offenders, []);
});

test("every registered theme token is actually declared, with a light value", () => {
  for (const name of CSS_VAR_GROUPS.theme) {
    const token = CSS_VAR[name];
    assert.ok(
      new RegExp(`${token}\\s*:`).test(TOKENS_CSS),
      `${token} is registered but never declared`,
    );
  }
});

test("the dark block overrides theme tokens ONLY — never status, never derived", () => {
  const dark = rules(TOKENS_CSS).find((r) => r.selector.includes('="dark"'));
  assert.ok(dark, "there is a dark override, keyed on the registered attribute");
  assert.ok(dark.selector.includes(scriptAttr("theme")), "and it reuses the registered token");

  const overridden = [...dark.body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!);
  const themeTokens = CSS_VAR_GROUPS.theme.map((n) => CSS_VAR[n]);
  for (const token of overridden) {
    assert.ok(themeTokens.includes(token as never), `${token} must not be re-themed`);
  }

  // The four status colours are the case that matters: The design forbids a
  // per-surface palette, and a theme is a surface. Active must be the same
  // blue in both, or the round trip through the dashboard stops agreeing.
  for (const name of CSS_VAR_GROUPS.status) {
    assert.ok(!overridden.includes(CSS_VAR[name]), `${CSS_VAR[name]} must not be theme-overridable`);
  }
});

test("the derived tokens are computed from the theme tokens, so dark comes free", () => {
  // This is why there is one palette and not two: `--snag-surface` resolves
  // against whatever `--snag-bg`/`--snag-fg` are on the element, so the dark
  // block flipping four values re-derives every surface, hover and focus.
  const block = hostRules(TOKENS_CSS)[1]!.body;
  for (const name of CSS_VAR_GROUPS.derived) {
    const decl = block.match(new RegExp(`${CSS_VAR[name]}\\s*:([^;]+)`))?.[1] ?? "";
    if (name === "onAccent") continue; // deliberately a literal: white on accent, both themes
    assert.match(decl, /var\(--snag-(bg|fg|accent|muted)\)/, `${CSS_VAR[name]} must derive`);
  }
});

test("the four status colours are GENERATED from the one STATUS table", () => {
  for (const [key, s] of Object.entries(STATUS)) {
    const token = CSS_VAR[`status${key[0]!.toUpperCase()}${key.slice(1)}` as keyof typeof CSS_VAR];
    assert.match(TOKENS_CSS, new RegExp(`${token}\\s*:\\s*${s.colour}`));
  }
});

test("Each status colour literal occurs EXACTLY ONCE in the source", () => {
  // The acceptance criterion, as a real check rather than a promise.
  // It caught a genuine problem: the accent was the same blue as STATUS.open,
  // so one literal appeared six times and no test could tell a shared palette
  // from a leaked one. The accent is now its own token with its own value.
  const all = sources().map((f) => readFileSync(f, "utf8")).join("\n");
  for (const s of Object.values(STATUS)) {
    const hits = all.match(new RegExp(s.colour, "gi")) ?? [];
    assert.equal(hits.length, 1, `${s.colour} occurs ${hits.length}× — status has ONE source`);
  }
});

test("reduced motion is carried by one token, not by per-component media queries", () => {
  assert.match(TOKENS_CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(TOKENS_CSS, new RegExp(`${CSS_VAR.motion}\\s*:\\s*0ms`));
  // Wants an empty getAnimations() under reduce. That holds by
  // construction only if every transition reads the token — a component that
  // hard-codes `.18s` keeps animating for someone who asked it not to.
  // Matched in SOURCE, where the token appears as the `t.motion` interpolation
  // it is written as, not as the string it becomes.
  const durations = sources()
    .flatMap((f) => [...code(f).matchAll(/transition:[^;}`]+/g)].map((m) => m[0]!))
    .filter((d) => !/t\.motion|--snag-motion/.test(d));
  assert.deepEqual(durations, [], "every transition must be driven by --snag-motion");
});

test("[hidden] is reset ONCE, for everything", () => {
  // `el.hidden = true` is a no-op the moment a class sets an author `display`,
  // because that beats the UA stylesheet's `[hidden]{display:none}`. The
  // degraded-state notice shipped that way — display:flex, so it sat on a
  // client's page permanently and empty, on pages where nothing had failed.
  // Every DOM assertion passed, because they all read the PROPERTY.
  //
  // Asserted as ONE universal rule rather than a companion selector per
  // component: a per-component rule is one the next component forgets.
  assert.match(TOKENS_CSS, /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*\}/);
});

test("themePref accepts the closed set and treats anything else as auto", () => {
  assert.equal(themePref("light"), "light");
  assert.equal(themePref("dark"), "dark");
  assert.equal(themePref("auto"), "auto");
  assert.equal(themePref(undefined), "auto");
  assert.equal(themePref("Dark"), "auto", "the value set is closed and case-sensitive");
  assert.equal(themePref("system"), "auto");
});

test("`t` resolves to var() references, so a rename moves the theming API too", () => {
  assert.equal(t.bg, `var(${CSS_VAR.bg})`);
  // The design makes every --snag-* property public SemVer surface. Interpolating
  // rather than typing the spelling is what keeps that surface derived: two
  // tokens had already been minted by hand before they were registered.
  assert.ok(CSS_VAR.tbH.startsWith("--snag-"));
  assert.ok(CSS_VAR.dockW.startsWith("--snag-"));
});

test("layout uses LOGICAL properties, so RTL is not a rewrite", () => {
  // The design requires logical properties "from v0" and names the dock specifically
  // `inset-inline-end` rather than `right`. It also calls this the single most
  // expensive thing to flip later, and it gets more expensive every commit,
  // which is why it is a test rather than a habit. Physical INLINE properties
  // are banned; block-direction ones (border-bottom, padding-top) are not,
  // because v0 does not support vertical writing modes and pretending otherwise
  // would be ceremony.
  const banned = /(?:margin|padding|border|inset)-(?:left|right)\s*:|text-align\s*:\s*(?:left|right)\b/g;
  const offenders = sources().flatMap((f) =>
    [...code(f).matchAll(banned)].map((m) => `${f.replace(SRC, "src")}: ${m[0]}`),
  );
  assert.deepEqual(offenders, []);
});

test("the two PHYSICAL survivors are the ones that must be", () => {
  // Not everything physical is a mistake, and a blanket ban would have produced
  // two silent bugs. Documented here so the next sweep does not "fix" them:
  //
  //   host.ts / pins.ts `left:0`  — a document coordinate ORIGIN. Pin positions
  //     come from getBoundingClientRect, which reports physical pixels in every
  //     writing mode; a logical origin would place pins by one convention and
  //     measure them by another.
  //   notice.ts / highlight.ts `left:50%` — centring. 50% in from either edge is
  //     the same point, so there is nothing to flip.
  // Scanned inside CSS TEMPLATE LITERALS only. A whole-file regex caught
  // `left: number` in a DOMRect-shaped interface and reported the type system
  // as a styling bug — the kind of false positive that gets a test deleted.
  const css = sources()
    .flatMap((f) => [...code(f).matchAll(/`([^`]*)`/gs)].map((m) => m[1]!))
    .filter((s) => /\{[^}]*:/.test(s))
    .join("\n");

  const bare = [...css.matchAll(/(?<![\w-])(?:left|right)\s*:\s*([^;}\s]+)/g)].map((m) => m[1]!);
  const unexpected = bare.filter((v) => v !== "0" && v !== "0!important" && v !== "50%");
  assert.deepEqual(
    unexpected,
    [],
    "a new physical left/right appeared — make it logical, or document it here",
  );
  assert.ok(bare.length > 0, "…and the scan is actually finding CSS, not silently matching nothing");
});

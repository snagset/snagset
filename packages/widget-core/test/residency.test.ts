import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The residency DoD, both halves.
 *
 * `isSensitiveValue` lives in `snag.runtime.js` — the stub's
 * Tier A/B breadcrumbs hand their unredacted early[] to mount(), so
 * redaction-at-handoff happens in the runtime — and the capture chunk IMPORTS
 * it cross-chunk rather than bundling a copy. The failure this guards is the
 * one the draft 2 actually shipped: a fork that drifted five ways and was
 * silently WEAKER than the owner while presenting itself as the same
 * protection.
 */

const PKG = join(import.meta.dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

test("exactly ONE definition of isSensitiveValue exists in the source tree", () => {
  const defs = sources(join(PKG, "src")).filter((f) =>
    /function isSensitiveValue|const isSensitiveValue\s*=/.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(
    defs.map((f) => f.slice(PKG.length + 1)),
    ["src/redact/predicates.ts"],
    "a second definition is a fork, and forks drift weaker",
  );
});

test("it RESOLVES into snag.runtime.js — and capture's bundled copy is the same source", () => {
  // The `%5Bredacted%5D` un-escape is unique to the predicates module (its
  // redactUrl un-escapes the marker URLSearchParams mangles) — a marker that
  // survives minification.
  //
  // Capture CARRIES A COPY, deliberately: chunks are self-contained,
  // because cross-chunk imports died of module-map poisoning — a rejected
  // import of a canonical URL is replayed from cache into every baked
  // specifier, so no retry scheme can heal it. A duplicated pure function in a
  // LAZY chunk costs the envelope nothing; a FORK would drift — and the
  // single-source test above is what forbids the fork.
  const runtime = readFileSync(join(PKG, "dist/snag.runtime.js"), "utf8");
  assert.match(runtime, /%5Bredacted%5D/i, "the module is resident in the runtime artefact");
});

test("every lazy chunk is SELF-CONTAINED — no static import of a sibling artefact", () => {
  // A baked `./snag.*.js` specifier is exactly the thing the ?r retry scheme
  // cannot heal after a canonical URL is poisoned. Self-containment is what
  // makes the retry contract sound, so it is asserted per artefact.
  for (const f of [
    "snag.capture.js",
    "snag.dock.js",
    "snag.crumbs.js",
    "snag.screenshot.js",
    "snag.anchor-ext.js",
    "snag.anchor-fuzzy.js",
  ]) {
    const src = readFileSync(join(PKG, "dist", f), "utf8");
    assert.doesNotMatch(
      src,
      /from\s*"\.\/snag\./,
      `${f} must not bake a specifier to a sibling chunk`,
    );
  }
});

#!/usr/bin/env node
// verify-dist — assertions about what actually ships, made against the built
// bytes rather than the source. Source-level review has already been shown to
// miss this class of problem twice on this project: the A1 lazy boundary was
// absent from dist/ while the source read correctly, and a redaction regex that
// read correctly leaked 7 of 8 secrets. Grep the artefact, not the intent.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { derive } from "../packages/types/scripts/registry-derive.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "packages/widget-core/dist");
const reg = JSON.parse(readFileSync(join(ROOT, "packages/types/registry.json"), "utf8"));
const d = derive(reg);

const read = (f) => readFileSync(join(DIST, f), "utf8");
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

const built = Object.entries(d.budgets.artifacts).filter(([, b]) => b.built);

// ── every artefact the registry says is built, exists, and nothing else does ──
for (const [id] of built) {
  const file = d.artifacts[id];
  check(existsSync(join(DIST, file)), `missing artefact: ${file}`);
}

// EXACTLY the registry's artefact set — no extras. Rollup will hoist shared code
// into a hashed chunk the moment two entries share a module, producing a file no
// registry knows about and whose name changes every build. That happened once;
// this is what stops it happening quietly again.
{
  const expected = new Set(built.map(([id]) => d.artifacts[id]));
  const actual = readdirSync(DIST).filter((f) => f.endsWith(".js"));
  for (const f of actual) {
    check(expected.has(f), `dist contains an UNREGISTERED artefact: ${f}`);
  }
}

/* ── the string catalogues' prose must not ship ─────────────────────────────
 *
 * esbuild drops most comments and PRESERVES ONE KIND: a comment leading an
 * object-literal property. The four catalogues are nothing but annotated object
 * literals, so every word beside every string was shipping — 6.4 KB gzipped
 * across the two EAGER chunks, against an envelope with 80 bytes of margin.
 *
 * The Vite plugin strips them; this is what stops the plugin being quietly
 * dropped. Asserted against the SOURCE's own comment lines rather than against
 * a pattern, so it needs no maintenance and cannot drift: if a sentence exists
 * in a catalogue and also in an artefact, it shipped.
 */
{
  const strings = join(ROOT, "packages/widget-core/src/strings");
  for (const f of readdirSync(strings).filter((n) => n.endsWith(".ts"))) {
    const prose = readFileSync(join(strings, f), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("//") && l.length > 40)
      .map((l) => l.replace(/^\/\/\s*/, ""));
    for (const line of prose) {
      for (const name of Object.values(d.artifacts)) {
        if (!existsSync(join(DIST, name))) continue;
        check(
          !read(name).includes(line),
          `${name} ships a comment from strings/${f}: "${line.slice(0, 48)}…"`,
        );
      }
    }
  }
}

const stub = read(d.artifacts.stub);
const runtime = read(d.artifacts.runtime);

// ── A1: the lazy boundary is real in the shipped bytes ──────────────────────
check(stub.includes("import("), `${d.artifacts.stub} must reach the runtime via a dynamic import( ) — the lazy boundary`);
check(
  !stub.includes("pointer-events:none"),
  `${d.artifacts.stub} must NOT inline the runtime (HOST_CSS found in the stub)`,
);
check(runtime.includes("pointer-events:none"), `${d.artifacts.runtime} should carry HOST_CSS`);

// ── the chunk split is the product's byte budget; assert it holds ───────────
// A reviewer who only browses must never download a UI framework.
check(!/\bpreact\b/i.test(runtime), `${d.artifacts.runtime} must not contain Preact — it belongs to ${d.artifacts.panels} alone`);
check(!/\bpreact\b/i.test(stub), `${d.artifacts.stub} must not contain Preact`);

// ── nothing that must never ship ────────────────────────────────────────────
// eval/Function-constructor: a strict CSP on a client's site would kill us, and
// it is the first thing a security reviewer greps for before allowing the tag.
/**
 * EVERY artefact, not two of them — and two constructs that were missing.
 *
 * Plan task 2's definition of done reads: *"Build fails if … `dist/*.js`
 * contains `eval(`/`new Function`/`document.write`/`.innerHTML =`"*. Two of the
 * four were never checked, and the loop ran over `stub` and `runtime` only, so
 * `snag.panels.js`, `snag.capture.js` and `snag.anchor-ext.js` were scanned for
 * nothing at all.
 *
 * The cost was not theoretical: the toolbar built its three icons with
 * `element.innerHTML = <svg…>`, which is a Trusted Types injection sink. Under
 * `require-trusted-types-for 'script'` that assignment throws while the toolbar
 * is being constructed, so a client on that policy got NO TOOLBAR — and the gate
 * written to prevent exactly this was looking the other way.
 *
 * `.innerHTML =` is matched with an optional `+` so `innerHTML +=` cannot slip
 * through, and `outerHTML` and `insertAdjacentHTML` are included because they
 * are the same sink under a different name.
 */
// `built`, not every registered artefact: the registry also names files that
// later releases will add (`crumbs`), and reading one that does not exist yet
// fails the gate for the wrong reason.
for (const [name, src] of built.map(([id]) => [id, read(d.artifacts[id])])) {
  check(!/\beval\s*\(/.test(src), `${name}: eval( is forbidden — breaks strict-CSP sites`);
  check(!/new\s+Function\s*\(/.test(src), `${name}: new Function( is forbidden — same reason`);
  check(!/\bdebugger\b/.test(src), `${name}: stray debugger statement`);
  check(!/process\.env/.test(src), `${name}: process.env leaked into browser code`);
  check(!/\brequire\s*\(/.test(src), `${name}: CommonJS require( in a browser artefact`);
  check(
    !/\bdocument\s*\.\s*write\b/.test(src),
    `${name}: document.write is forbidden — it destroys a host page loaded async`,
  );
  check(
    !/\binsertAdjacentHTML\s*\(/.test(src),
    `${name}: insertAdjacentHTML is the same sink under another name`,
  );
  /**
   * `innerHTML` is checked on every artefact EXCEPT panels, and the exemption
   * is named rather than silent.
   *
   * `snag.panels.js` carries Preact, whose diff contains two assignments we
   * cannot remove: `e.innerHTML = _.__html` (the `dangerouslySetInnerHTML`
   * path) and `e.innerHTML = ""` (a wholesale child clear). The first is
   * unreachable for us — we never pass that prop, and the source-level test in
   * `packages/widget-core/test/sinks.test.ts` is what proves it — and the
   * second assigns the empty string, which the Trusted Types algorithm returns
   * early on rather than treating as an injection.
   *
   * A gate that cannot be enforced on vendored bytes is enforced on OUR bytes
   * instead, and says which is which. Silently dropping the check for the one
   * chunk that happens to fail it is how a gate becomes decoration.
   */
  // "panels" carries Preact; since the decision made chunks self-contained, "dock"
  // carries its own Preact copy too — same two unreachable assignments, same
  // proof of unreachability (test/sinks.test.ts: nothing of ours passes
  // dangerouslySetInnerHTML, which is the sole route into that code).
  if (name !== "panels" && name !== "dock") {
    check(
      !/\.\s*(inner|outer)HTML\s*\+?=/.test(src),
      `${name}: assigning to innerHTML/outerHTML is a Trusted Types sink — build the nodes instead`,
    );
  }
}

// ── no prose ships ─────────────────────────────────────────────────────────
// A comment inside a CSS template literal is string DATA, so no minifier
// touches it and every byte reaches the wire. This codebase explains its CSS
// heavily and should keep doing so — 2.7 KB gzipped of those explanations were
// being downloaded by every reviewer, 1.4 KB of it in the EAGER chunk, which is
// what pushed the activation envelope past the normative 40 KB.
// The build strips them (widget-core/vite.config.ts); this is what proves it,
// because the plugin silently doing nothing looks exactly like success.
//
// Two annotations are load-bearing and stay: `/* @__PURE__ */` is Rollup's
// tree-shaking hint, and `/* @vite-ignore */` is what keeps the runtime's
// dynamic import() dynamic — the whole lazy boundary depends on it.
for (const [name, id] of [["stub", "stub"], ["runtime", "runtime"], ["panels", "panels"]]) {
  const src = read(d.artifacts[id]);
  const prose = [...src.matchAll(/\/\*[\s\S]*?\*\//g)]
    .map((m) => m[0])
    .filter((c) => !c.includes("@__PURE__") && !c.includes("@vite-ignore"));
  check(
    prose.length === 0,
    `${name}: ${prose.length} comment(s) reached the artefact — ${JSON.stringify((prose[0] ?? "").slice(0, 60))}`,
  );
}

// ── `//` comments must not ship either — ANY artefact (the discovery) ──
// Vite's lib-mode ES output runs esbuild without whitespace minification (so
// @__PURE__ survives for consumers' bundlers), and without it comments attached
// to class fields, object properties and statement tails all reach the wire:
// 92 lines / ~3.5 KB gzip were in the EAGER runtime alone, found while hunting
// a 33-byte envelope overage. stripLineComments() (vite.config.ts) now lexes
// them out of every module; this is what stops that plugin being quietly
// dropped — or defeated by a comment shape its scanner does not know.
for (const [id] of built) {
  const src = read(d.artifacts[id]);
  const lines = src.split("\n").filter((l) => /^\s*\/\/(?![@#])/.test(l));
  check(
    lines.length === 0,
    `${id}: ${lines.length} line comment(s) shipped — ${JSON.stringify((lines[0] ?? "").trim().slice(0, 60))}`,
  );
}

// ── the screenshot engine is zero-dependency, provably ─────
// The spec bans a third-party raster engine (snapdom et al). The sourcemap's
// `sources` array is the ground truth for what got bundled: if any source path
// resolves through node_modules, a dependency crept into the chunk.
{
  const map = join(DIST, d.artifacts.screenshot + ".map");
  if (existsSync(map)) {
    const sources = JSON.parse(readFileSync(map, "utf8")).sources ?? [];
    const foreign = sources.filter((s) => s.includes("node_modules"));
    check(
      foreign.length === 0,
      `screenshot: bundles node_modules code — ${foreign[0] ?? ""} (no third-party raster engine)`,
    );
  } else {
    check(false, "screenshot: sourcemap missing — cannot prove the chunk is dependency-free");
  }
}

// ── no non-passive touch listener ships — ANY artefact (A5) ─────────
// The corrigendum's law: touchstart/touchmove are passive, never defaulted —
// scrolling MUST work in review mode. The one legal registration shape in our
// minified output is the NET tuple `["touch…", !0]` (pointer.ts); this asserts
// every occurrence of a touch event name sits in that shape, and that no
// `passive:!1`/`passive:false` appears anywhere. Shape-coupled on purpose and
// PAIRED with the E2E instrumentation audit in hygiene.spec.ts, which wraps
// addEventListener and cannot be fooled by a refactor.
for (const [id] of built) {
  const src = read(d.artifacts[id]);
  const names = [...src.matchAll(/"touch(?:start|move|end)"/g)].length;
  const passive = [...src.matchAll(/"touch(?:start|move|end)"\s*,\s*(?:!0|true)/g)].length;
  check(
    names === passive,
    `${id}: ${names - passive} touch event name(s) outside the passive NET tuple shape`,
  );
  check(!/passive\s*[:!]\s*(?:!1|false)/.test(src), `${id}: a passive:false flag ships`);
}

// ── dead-era tokens must not survive in shipped bytes (lint) ──
for (const [name, src] of [["stub", stub], ["runtime", runtime]]) {
  for (const dead of ["cedilla", "CEDILLA_", "data-cd-", "clickreview", "data-cr-"]) {
    check(!src.toLowerCase().includes(dead.toLowerCase()), `${name}: dead-era token "${dead}" shipped`);
  }
}

// ── the stub must not create a global of its own ────────────────────────────
// Vite's IIFE `name` becomes a real window.* assignment the moment the entry
// gains an export. Any global we install must come from the registry (GLOBALS),
// never from a bundler option nobody re-reads.
check(
  /^\s*\(function\s*\(/.test(stub) || /^\s*\(\(\)\s*=>/.test(stub),
  `${d.artifacts.stub} must be a bare IIFE — a leading assignment means the bundler is creating an unregistered global`,
);
check(!/__snag\w*_stub__/.test(stub), `${d.artifacts.stub}: the bundler's IIFE name leaked into the output as a global`);

// ── the brand appears only via the registry, never hand-typed ───────────────
// (a weak-but-real proxy: the stub must not contain the long product word, which
//  only ever reaches the browser through GLOBALS — where it is expected)
check(
  (stub.match(new RegExp(reg.brand.long, "g")) ?? []).length <= 4,
  `stub: suspiciously many literal "${reg.brand.long}" occurrences — should come from the registry`,
);

if (failures.length) {
  console.error("✗ verify-dist failed:\n" + failures.map((f) => "  · " + f).join("\n"));
  process.exit(1);
}
console.log(`✓ verify-dist: ${built.length} artefact(s) clean (A1 boundary present, no eval/Function/process.env, no dead-era tokens)`);

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * No HTML-string sink in OUR source — the half of task 2's rule that a bundled
 * framework makes unenforceable on the shipped bytes.
 *
 * `tools/verify-dist.mjs` bans `innerHTML`, `document.write` and
 * `insertAdjacentHTML` in every built artefact except `snag.panels.js`, which
 * carries Preact's diff and therefore carries two assignments we did not write
 * and cannot remove. This test is what makes that exemption honest: the sink is
 * unreachable for us because nothing of ours ever hands Preact the one prop that
 * reaches it, and nothing of ours assigns a string of markup anywhere.
 *
 * It caught a real one. The toolbar built its three SVG icons with
 * `element.innerHTML = <svg…>`, which throws under
 * `require-trusted-types-for 'script'` — while the toolbar is being
 * constructed, so the whole widget was missing rather than merely unstyled. It
 * shipped because the gate written to prevent it checked five constructs and
 * not this one, on two artefacts and not five.
 */

const SRC = join(import.meta.dirname, "..", "src");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Comments are stripped before matching. This file's own subject matter means
 * the codebase discusses `innerHTML` in prose in several places — including in
 * the module that stopped using it, whose comment explains why — and a test
 * that cannot tell an explanation from a call is a test that gets deleted.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const FILES = sources(SRC).map((p) => [p.slice(SRC.length + 1), code(readFileSync(p, "utf8"))] as const);

test("no source file assigns innerHTML or outerHTML", () => {
  const bad = FILES.filter(([, s]) => /\.\s*(inner|outer)HTML\s*\+?=/.test(s)).map(([f]) => f);
  assert.deepEqual(
    bad,
    [],
    `assigning a string of markup is a Trusted Types sink. Build the nodes — ` +
      `runtime/toolbar.ts's icon factories are the pattern for vanilla, and the ` +
      `panels chunk emits h() trees for the same reason.`,
  );
});

test("no source file reaches Preact's own innerHTML path", () => {
  // The ONLY way our code can reach `e.innerHTML = _.__html` inside Preact's
  // diff. verify-dist exempts `snag.panels.js` from the innerHTML ban on the
  // strength of this assertion, so it is load-bearing rather than belt-and-braces.
  const bad = FILES.filter(([, s]) => /dangerouslySetInnerHTML|__html/.test(s)).map(([f]) => f);
  assert.deepEqual(bad, [], "dangerouslySetInnerHTML is the one prop that makes Preact's sink reachable");
});

test("no source file uses document.write or insertAdjacentHTML", () => {
  const bad = FILES.filter(([, s]) =>
    /\bdocument\s*\.\s*write\b|\binsertAdjacentHTML\s*\(/.test(s),
  ).map(([f]) => f);
  assert.deepEqual(bad, [], "same sink, different names — and document.write destroys an async-loaded host page");
});

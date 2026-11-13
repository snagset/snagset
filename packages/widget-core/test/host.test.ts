import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOST_CSS } from "../src/runtime/host.ts";

// The no-containment rule is a LITERAL-STRING assertion,
// not a rendering test — a rendering test passes on the popover path regardless
// and fails only on the z-index fallback, on some browsers, sometimes.
test("HOST_CSS never sets containment (A3)", () => {
  assert.ok(!/\bcontain\b/.test(HOST_CSS), "the shadow host must never set `contain` — it collapses fixed UI to a 0×0 box");
});

test("HOST_CSS provides the isolation A3 does require", () => {
  assert.match(HOST_CSS, /position:\s*absolute/);
  assert.match(HOST_CSS, /width:\s*0/);
  assert.match(HOST_CSS, /height:\s*0/);
  assert.match(HOST_CSS, /pointer-events:\s*none/);
});

/**
 * The notice's live region is populated AFTER it is in the tree.
 *
 * `role="alert"` is a live region, and the two ways of filling one are not
 * equivalent: a region inserted with its text already in it is announced by
 * most screen readers and not by all, while a mutation inside a region that is
 * already in the document is announced by every one of them.
 *
 * That became load-bearing when the notice started DETACHING whenever it has
 * nothing to say (the rule, applied to the one surface the criterion does
 * not name). Attaching it pre-filled is the obvious way to write that, and it
 * would have traded an accessibility guarantee for a node count silently.
 *
 * A SOURCE ASSERTION, deliberately, for the same reason HOST_CSS above is one.
 * The behaviour lives in a one-frame window: catching it in a browser means
 * either racing a MutationObserver or stubbing rAF by stack-sniffing a minified
 * bundle, and both are tests that pass for the wrong reasons and flake for
 * worse ones. What actually needs protecting is the ORDER of three statements,
 * so the order of three statements is what is checked.
 */
test("the notice attaches empty, then fills inside a frame (announcement order)", () => {
  const src = readFileSync(
    new URL("../src/runtime/notice.ts", import.meta.url),
    "utf8",
  );
  // Anchored on the signature's PREFIX, not its exact text: this test asserts
  // the ORDER of three statements, and pinning it to `show(key, next)` made it
  // fail the day the method gained a third parameter — a green ordering rule
  // reported as a broken ordering rule, which is the worst kind of red.
  const at = src.indexOf("show(key, next");
  const show = src.slice(at, src.indexOf("},", at));

  const emptied = show.indexOf('text.textContent = ""');
  // The notice mounts into the vv-glued chrome layer when one exists.
  const attached = show.indexOf("(parent ?? root).appendChild(el)");
  const filled = show.indexOf("requestAnimationFrame");

  assert.ok(emptied >= 0, "show() must clear the region before attaching it");
  assert.ok(attached >= 0, "show() must attach the notice");
  assert.ok(filled >= 0, "show() must fill the region in a later frame");
  assert.ok(emptied < attached, "the region is emptied BEFORE it is attached");
  assert.ok(attached < filled, "and filled only once it is in the tree");
  // The reverse of the whole point: text set on the way in. The VALUE is
  // captured rather than excluded with a lookahead — `\s*` backtracks, so
  // `=\s*(?!"")` happily matches at the space and the assertion passes on the
  // very code it exists to reject.
  const before = [...show.slice(0, attached).matchAll(/text\.textContent\s*=\s*([^;]+);/g)];
  for (const [, value] of before) {
    assert.equal(
      value.trim(),
      '""',
      "no text may be written into the live region before the node is in the document",
    );
  }
});

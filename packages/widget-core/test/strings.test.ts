import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, PRODUCT, TERM_ITEM } from "@snagset/types/names";
import { count, when } from "../src/strings/format.ts";
import { en as core } from "../src/strings/en.ts";
import { runtimeStrings } from "../src/strings/runtime.ts";
import { captureStrings, captureOnly } from "../src/strings/capture.ts";
import { panelStrings } from "../src/strings/panels.ts";
import { dockStrings } from "../src/strings/dock.ts";
import { textStrings } from "../src/strings/text.ts";
import { make } from "../src/strings/format.ts";

/** The union of all five catalogues — what "every user-visible string" means,
 *  and what every rule below is about. No chunk ever holds this object. */
const en = { ...core, ...runtimeStrings, ...captureStrings, ...captureOnly, ...panelStrings, ...dockStrings, ...textStrings };
type StringKey = keyof typeof en;
const format = make(en);

/**
 * The catalogue is split FOUR ways — en.ts holds what more than one chunk can
 * render, and runtime.ts / capture.ts / panels.ts hold what exactly one can —
 * because a bundler cannot tree-shake object properties, so every string in a
 * shared object ships inside every chunk that touches it. Measured: the
 * catalogues were 16.6% of `snag.panels.js`, most of it toolbar and notice copy
 * no panel can draw.
 *
 * Every assertion below is about the UNION. Which file a key lives in is a
 * packaging decision, and none of these rules should care — but one of them
 * now does, deliberately: see the placement test at the bottom.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}
const CATALOGUES = ["en.ts", "runtime.ts", "capture.ts", "panels.ts", "text.ts"].map((f) => join("strings", f));
const consumers = () => sources().filter((f) => !CATALOGUES.some((c) => f.endsWith(c)));

/**
 * Task 30's DoD: "Every user-visible string in the widget
 * resolves through it; a snapshot test of the key set makes a missing key
 * loud."
 */
test("the key set is stable — adding or removing one is a deliberate act", () => {
  // Not a golden file: the point is that the diff shows up in review. A key
  // silently disappearing takes a sentence off screen with it.
  assert.deepEqual(Object.keys(en).sort(), [
    "action.cancel", "action.delete", "action.discard", "action.dismiss", "action.edit",
    "action.export", "action.exportclear", "action.more", "action.post", "action.retry", "action.save",
    "action.sure", "announce.created", "announce.status", "assignee.none", "author.unknown", "badge.anchored", "badge.approximate",
    "badge.hidden", "badge.orphaned", "capture.agent", "capture.agent.noos", "capture.device",
    "capture.device.at1x", "capture.label", "capture.page", "chip.comment", "chip.notext",
    "cluster.aria", "comment.delete",
    "comment.edit", "composer.aria", "composer.body", "composer.body.placeholder",
    "composer.chars", "composer.child", "composer.discard.sure", "composer.email", "composer.email.bad",
    "composer.member", "composer.name", "composer.parent", "composer.round.closed", "composer.shot", "composer.signin", "composer.signin.blocked", "composer.signout", "cursor.at", "cursor.here", "cursor.proxy", "detail.approximate", "detail.details", "detail.filedat", "detail.hidden", "detail.hidden.show", "detail.openquery", "detail.orphaned", "detail.unavailable", "device.Desktop",
    "device.Mobile", "disclosure.ack", "disclosure.always", "disclosure.crumbs.off",
    "disclosure.crumbs.on", "disclosure.retention", "disclosure.retention.server", "disclosure.screenshot.off", "disclosure.screenshot.on", "disclosure.title",
    "dock.aria", "dock.back", "dock.back.aria", "dock.clear",
    "dock.clear.aria", "dock.close", "dock.cluster", "dock.cluster.clear", "dock.empty", "dock.empty.filter", "dock.empty.orphans", "dock.empty.page", "dock.goto",
    "dock.hiddenrow", "dock.hiddenrow.show", "dock.next", "dock.position", "dock.prev", "dock.replies",
    "dock.row.empty", "dock.title.detail", "dock.title.list", "dock.unread", "error.capture",
    "error.linkrevoked", "error.nostorage", "error.origin", "error.panels", "error.panels.add", "error.quota",
    "error.sendfailed", "error.sessionended", "export.button", "export.by",
    "export.device", "export.heading", "export.json", "export.md", "export.nobody",
    "export.on", "export.screenshot", "export.selector", "export.summary.many", "export.summary.one", "export.title",
    "field.assignee", "field.status", "field.status.locked",
    "filter.button", "filter.button.n", "filter.by", "filter.by.anyone", "filter.clear", "filter.new", "filter.new.markread", "filter.new.none", "filter.new.on", "filter.pageonly", "filter.pages", "filter.pages.all", "filter.read", "filter.read.all", "filter.read.read", "filter.read.unread", "filter.selectall", "filter.status", "highlight.chip", "highlight.chip.unnamed", "hint.coarse", "hint.fine",
    "label.button", "label.image", "label.link", "label.tag", "label.text",
    "nav.announce",
    // Detection and the pause were built and the
    // sentence was not, so a host modal stopped the toolbar dead and said
    // nothing — reported twice from real use before this key existed.
    "paused.close", "paused.dialog", "permalink.copied", "permalink.copy", "permalink.unknown", "pin.aria", "pin.aria.moved", "pin.aria.none", "pin.aria.one",
    "pin.target", "reply.add", "reply.aria", "reply.delete", "reply.placeholder",
    "reply.send",
    // T10/ — the dock's round selector.
    "round.closed", "round.label",
    "search.aria", "search.placeholder", "shot.aria", "shot.close", "shot.open", "sort.button", "sort.newest", "sort.oldest", "sort.page", "status.open", "status.progress", "status.resolved", "status.review", "time.now",
    "toolbar.add", "toolbar.add.draft", "toolbar.aria", "toolbar.browse",
    // The decision removed "toolbar.pick.element" and "toolbar.pick.text" with the
    // picker sub-segment they named.
    "toolbar.comments", "toolbar.comments.unresolved", "toolbar.group", "toolbar.panel",
    "where.anchored", "where.approximate", "where.orphaned",
    // The reply box asks who is writing, as the composer does.
    "who.email", "who.email.bad", "who.member", "who.name", "who.signin", "who.signin.blocked", "who.signout",
  ]);
});

test("NO BRAND LITERAL lives in the catalogue — not the product, not the item noun", () => {
  // The rename proof in packages/types only checks that the REGISTRY derives
  // cleanly; it never opens a source file, and its own preamble records that an
  // audit once flipped the brand and found 64 survivors. This is the source-side
  // half, and the catalogue is where prose survivors would hide: the composer's
  // placeholder read "What's the snag?" as a plain literal, so flipping the
  // brand to Gasket left it silently saying "snag".
  const body = JSON.stringify(en);
  for (const token of [BRAND.long, BRAND.short, BRAND.pkg]) {
    assert.doesNotMatch(
      body,
      new RegExp(token, "i"),
      `"${token}" is a brand token — use {product} / {item} and let format() fill it`,
    );
  }
});

test("format merges the brand in, so entries never carry it", () => {
  assert.equal(format("toolbar.aria"), `${PRODUCT} review toolbar`);
  assert.equal(format("composer.body.placeholder"), `What's the ${TERM_ITEM}?`);
});

test("format interpolates params, and leaves an unknown placeholder VISIBLE", () => {
  assert.equal(format("dock.position", { n: 2, total: 3 }), "2 of 3");
  // A missing param should look wrong in review, not read as a typo in
  // production — blanking it silently is how "of 3" ships.
  assert.equal(format("dock.position", { n: 2 }), "2 of {total}");
});

test("every format() key in the source exists in the catalogue", () => {
  const dynamic = ["where.", "badge.", "status.", "detail.", "device.", "toolbar."]; // built from a union at the call site
  const missing: string[] = [];
  for (const f of consumers()) {
    for (const m of readFileSync(f, "utf8").matchAll(/format\(\s*["'`]([\w.]+)["'`]/g)) {
      const key = m[1]!;
      if (!(key in en)) missing.push(`${f}: ${key}`);
    }
    // Template-literal keys: assert the PREFIX is one we know builds real keys.
    for (const m of readFileSync(f, "utf8").matchAll(/format\(\s*`([\w.]+)\$\{/g)) {
      if (!dynamic.includes(m[1]!)) missing.push(`${f}: dynamic key \`${m[1]}\${…}\``);
    }
  }
  assert.deepEqual(missing, []);
});

test("every catalogue key is USED — a dead string is a string nobody maintains", () => {
  const all = consumers().map((f) => readFileSync(f, "utf8")).join("\n");
  const dynamic = /^(where|badge|status|detail|device|toolbar)\./; // resolved from a union, never spelled out
  const unused = (Object.keys(en) as StringKey[]).filter(
    (k) => !dynamic.test(k) && !all.includes(`"${k}"`),
  );
  assert.deepEqual(unused, []);
});

test("counts are locale-formatted; identifiers and pin numbers are not", () => {
  assert.equal(count(1234), new Intl.NumberFormat().format(1234));
  // `SN-14` and the round number stay Latin digits in every locale — they are
  // identifiers people quote aloud, not quantities. (Asked of the pin's
  // accessible name now collapsed the tooltip into it.)
  assert.match(
    format("pin.aria.none", { key: "SN-14", target: "button “x”", status: "Active" }),
    /Comment SN-14 on/,
  );
});

test("dates shown to a person are formatted; an unparseable one is passed through", () => {
  assert.notEqual(when("2026-08-10T09:30:00.000Z"), "2026-08-10T09:30:00.000Z");
  assert.equal(when("not a date"), "not a date");
});

test("the empty state matches the normative copy", () => {
  assert.equal(format("dock.empty"), "No comments yet. Press +, then click anything on the page.");
});

test("no error string blames the reviewer, and each says what to do next", () => {
  const errors = (Object.keys(en) as StringKey[]).filter((k) => k.startsWith("error."));
  assert.ok(errors.length > 0);
  for (const k of errors) {
    const s = format(k);
    assert.doesNotMatch(s, /\byou (did|caused|should have)\b/i, `${k} blames the reviewer`);
    assert.match(s, /\.\s|\./, `${k} must be a sentence`);
    // Internal ids and stack traces go to console behind the [Snagset] prefix,
    // never into copy a reviewer reads.
    assert.doesNotMatch(s, /_[a-z]+_|Error:|\bstack\b/i, `${k} leaks an internal detail`);
  }
});

/**
 * EVERY KEY LIVES IN THE NARROWEST CATALOGUE THAT CAN STILL REACH IT.
 *
 * This has now gone wrong in both directions on the same day. `badge.*` sat in
 * the shared file while only the dock could draw it; then twenty-two toolbar,
 * hint and notice strings sat there while no panel could draw any of them —
 * 16.6% of `snag.panels.js`, measured from a source map. A rule that is only
 * written down is a rule that regresses, so it is checked here instead.
 *
 * The rule: a key belongs in `en.ts` if and only if MORE THAN ONE chunk can
 * render it. Otherwise it belongs in that chunk's own catalogue.
 *
 * The reachability walk is what makes this honest rather than a filename match:
 * `status.*` and `where.*` are rendered from `storage/types.ts` and
 * `runtime/pins.ts`, which live under runtime/ but are imported by the dock and
 * by the Markdown serialiser — so they are shared, and a naive by-directory
 * check would have moved them and broken both.
 */
test("a key lives in the narrowest catalogue that can still reach it", () => {
  const read = (f: string): string => readFileSync(f, "utf8");
  // `import type` is ERASED, so following it would put the whole dock in the
  // runtime's graph — runtime/index.ts imports DockProps for its types alone.
  // That is not a technicality: it is the difference between "this chunk can
  // render the string" and "this chunk mentions the file that can".
  const imports = (f: string): string[] =>
    // `export … from` counts too — the chunk entries are barrels, and matching
    // only `import` left every panel file out of the panels graph.
    [...read(f).matchAll(/(?:import|export)\s+(type\s+)?[^;]*?from\s+"(\.[^"]+)"/g)]
      .filter((m) => !m[1])
      .map((m) => join(dirname(f), m[2]!))
      .filter((p) => !p.includes(join("strings", "")));

  /** Every source file a chunk entry can reach, transitively. */
  function reach(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f) || !f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
      try {
        read(f);
      } catch {
        continue;
      }
      seen.add(f);
      stack.push(...imports(f));
    }
    return seen;
  }

  const ENTRIES = {
    runtime: join(SRC, "runtime", "index.ts"),
    capture: join(SRC, "capture", "index.ts"),
    panels: join(SRC, "panels", "index.ts"),
    // The dock is its own chunk. Its SOURCE graph still includes the
    // panels catalogue (at build time the copy is externalised to the panels
    // artefact — one table, reached cross-chunk), so for placement purposes it
    // is a fourth renderer, not a fifth catalogue.
    dock: join(SRC, "dock", "index.ts"),
  };
  const graphs = Object.fromEntries(
    Object.entries(ENTRIES).map(([k, e]) => [k, [...reach(e)].map(read).join("\n")]),
  );

  const renders = (chunkSrc: string, key: string): boolean =>
    chunkSrc.includes(`"${key}"`) ||
    chunkSrc.includes(`\`${key}`) ||
    chunkSrc.includes(`${key.split(".").slice(0, -1).join(".")}.\${`);

  /**
   * WHERE EACH CATALOGUE ACTUALLY LANDS. This is a hierarchy, not a flat
   * shared/specific split, and the test has to know the real shape or it gives
   * confident wrong answers: `capture.ts` is merged by BOTH the capture chunk
   * and panels (the dock's capture block and the Markdown export render the
   * same sentences), while `chromeStrings` in the same file is merged by
   * capture alone.
   */
  const HOMES: { file: string; table: Record<string, string>; lands: string[] }[] = [
    { file: "runtime.ts", table: runtimeStrings, lands: ["runtime"] },
    { file: "panels.ts", table: panelStrings, lands: ["panels", "dock"] },
    { file: "dock.ts", table: dockStrings, lands: ["dock"] },
    { file: "capture.ts (captureOnly)", table: captureOnly, lands: ["capture"] },
    { file: "capture.ts", table: captureStrings, lands: ["capture", "panels", "dock"] },
    { file: "en.ts", table: core, lands: ["runtime", "capture", "panels", "dock"] },
  ];

  for (const { file, table, lands } of HOMES) {
    for (const key of Object.keys(table)) {
      const by = Object.entries(graphs)
        .filter(([, srcText]) => renders(srcText, key))
        .map(([chunk]) => chunk)
        .sort();
      assert.ok(by.length > 0, `"${key}" is in ${file} and no chunk renders it`);

      // Every chunk that renders it must actually receive it…
      for (const chunk of by) {
        assert.ok(lands.includes(chunk), `"${key}" is in ${file}, which ${chunk} never merges`);
      }
      // …and no NARROWER home would also have covered it, or the string is
      // shipping to chunks that cannot draw it. This is the half that costs
      // bytes, and the half that regressed twice.
      const narrower = HOMES.filter(
        (h) => h.lands.length < lands.length && by.every((c) => h.lands.includes(c)),
      );
      assert.equal(
        narrower.length,
        0,
        `"${key}" is in ${file} but only ${by.join(", ")} renders it — move it to ${narrower[0]?.file}`,
      );
    }
  }
});

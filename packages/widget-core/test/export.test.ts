import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION } from "@snagset/types/names";
import { toMarkdown, toJSON, buildExport } from "../src/export/serialize.ts";
import type { Snag, Status } from "../src/storage/types.ts";
import type { AnchorState } from "../src/anchor/types.ts";

/**
 * v0 has no backend, so export is the only way a round of comments leaves the
 * browser it was made in. That makes these assertions about data survival, not
 * about formatting.
 */

const META = { origin: "https://example.com", exportedAt: "2026-08-10T09:30:00.000Z" };

function snag(over: Partial<Snag> = {}): Snag {
  const who = { id: "rev_local", name: "Edith", kind: "guest" as const };
  return {
    id: "thr_1",
    key: "SN-1",
    route: "/pricing",
    anchor: { label: 'Button "Get started"', breakpoint: "lg", path: ["body", "main", "button"] },
    anchorState: "anchored" as AnchorState,
    status: "open" as Status,
    comments: [
      {
        id: "cmt_1",
        snagId: "thr_1",
        body: "This label should say Continue",
        author: who,
        createdAt: "2026-08-10T09:00:00.000Z",
      },
    ],
    createdBy: who,
    createdAt: "2026-08-10T09:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    ...over,
  };
}

test("Markdown carries what a developer needs to act without the page open", () => {
  const md = toMarkdown([snag()], META);
  assert.match(md, /### 1 · SN-1 — Active/, "the pin number, the key and the status");
  assert.match(md, /\/pricing/, "the route");
  assert.match(md, /Button "Get started"/, "and what was actually pointed at");
  assert.match(md, /This label should say Continue/);
  assert.match(md, /Edith/);
});

test("the pin number in an export is the number on the pin", () => {
  const md = toMarkdown([snag(), snag({ id: "thr_2", key: "SN-7" })], META);
  // Both surfaces number by position, so "snag 2" means one thing.
  assert.match(md, /### 1 · SN-1/);
  assert.match(md, /### 2 · SN-7/);
});

test("a moved or dead anchor SAYS SO — an export must not launder uncertainty", () => {
  // The whole product rests on never presenting a guess as a fact. An export
  // read a week later is exactly where that lie would go unnoticed.
  //
  // The sentence is the DETAIL VIEW's, shared with the dock rather than written
  // separately here — it used to be phrased three different ways in three
  // files. A developer opening this needs to know the pin is a best guess
  // before they go hunting for the element.
  const gone = toMarkdown([snag({ anchorState: "orphaned" })], META);
  assert.match(gone, /has moved or gone/);

  const moved = toMarkdown([snag({ anchorState: "approximate" })], META);
  assert.match(moved, /close rather than exact/);

  // …and a settled anchor says nothing at all. An unconditional caveat trains
  // people to ignore it, which costs the two above their whole value.
  assert.doesNotMatch(toMarkdown([snag()], META), /moved or gone|close rather than exact/);
});

test("replies are carried, in order, with their authors", () => {
  const s = snag();
  s.comments.push({
    id: "cmt_2",
    snagId: "thr_1",
    body: "agreed, changing it",
    author: { id: "rev_local", name: "Ana", kind: "guest" },
    createdAt: "2026-08-10T09:15:00.000Z",
  });
  const md = toMarkdown([s], META);
  assert.match(md, /\*\*Ana\*\* — agreed, changing it/);
  assert.ok(
    md.indexOf("This label should say Continue") < md.indexOf("agreed, changing it"),
    "a thread out of order is a thread that reads wrong",
  );
});

test("an empty round still exports a valid, honest file", () => {
  const md = toMarkdown([], META);
  assert.match(md, /0 comments, 0 unresolved/);
});

test("JSON stamps the FROZEN schema version, not the product name", () => {
  const parsed = JSON.parse(toJSON([snag()], META));
  // SCHEMA_VERSION is the one token deliberately exempt from the rename
  // property test: a file exported today must stay readable by a build that
  // has since renamed itself.
  // `schemaVersion` and `threads` — the two key names, and
  // plan task 39 all print identically. This asserted `schema`/`snags`, which
  // is the runtime's own vocabulary leaking into the file format, and which
  // validated against nothing: The evidence is schema validation in CI, and
  // the CLI and the M2 importer both read the spec's names.
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
  assert.equal(parsed.origin, META.origin);
  assert.equal(parsed.threads[0].anchor.label, 'Button "Get started"');
  assert.equal(parsed.threads[0].comments[0].body, "This label should say Continue");
});

test("JSON round-trips the anchor whole, so a v1 import can re-resolve it", () => {
  const before = snag();
  const after = JSON.parse(toJSON([before], META)).threads[0];
  assert.deepEqual(after.anchor, before.anchor);
  assert.equal(after.anchorState, "anchored");
});

test("filenames are derived from the brand and dated", () => {
  assert.equal(buildExport("md", [], META).name, "snagset-2026-08-10.md");
  assert.equal(buildExport("json", [], META).mime, "application/json");
});

test("EVERY page is exported, grouped by route", () => {
  // Exporting only the current route trapped a week of review work per page:
  // twenty comments across three routes meant visiting each one and exporting
  // separately, with no all-pages view to notice that from.
  const md = toMarkdown(
    [
      snag({ id: "a", key: "SN-1", route: "/pricing" }),
      snag({ id: "b", key: "SN-2", route: "/about" }),
      snag({ id: "c", key: "SN-3", route: "/pricing" }),
    ],
    META,
  );
  assert.match(md, /^## \/pricing$/m);
  assert.match(md, /^## \/about$/m);
  assert.match(md, /3 comments/);
});

test("numbering restarts per page, because that is the number on the pin", () => {
  const md = toMarkdown(
    [
      snag({ id: "a", key: "SN-1", route: "/pricing" }),
      snag({ id: "b", key: "SN-2", route: "/pricing" }),
      snag({ id: "c", key: "SN-3", route: "/about" }),
    ],
    META,
  );
  assert.match(md, /### 1 · SN-1/);
  assert.match(md, /### 2 · SN-2/);
  // Not "3" — /about starts again at 1, matching what is on screen there.
  assert.match(md, /### 1 · SN-3/);
});

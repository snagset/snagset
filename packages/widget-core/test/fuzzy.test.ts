import { test } from "node:test";
import assert from "node:assert/strict";
import { matchQuote, maxErrorsFor, FUZZY_WINDOW } from "../src/anchor/fuzzy.ts";
import type { TextIndex } from "../src/anchor/textindex.ts";

/**
 * `matchQuote` against synthetic indexes — every bound .5 that
 * has an exact numeric contract. The DOM half (element mapping, the engine's
 * pass budgets on a live page) is E2E; what lives here is the part Hypothesis
 * got years of production evidence for and we transcribed.
 */

const idx = (text: string, truncated = false): TextIndex => ({
  text,
  segments: [],
  truncated,
  epoch: 0,
  builtAt: 0,
});

test("The edit-distance ceiling as a function of quote length", () => {
  assert.equal(maxErrorsFor(4), 0, "under 8: never searched");
  assert.equal(maxErrorsFor(8), 2, "8–31: floor(len/4), min 2 — the corpus's tightening");
  assert.equal(maxErrorsFor(13), 3, "five edits on thirteen chars is a different button");
  assert.equal(maxErrorsFor(100), 50, "32–511: Hypothesis's rule");
  assert.equal(maxErrorsFor(1000), 256, "hard ceiling — the search-cost bound");
});

test("guards: short and punctuation-only quotes are never searched", async () => {
  const i = idx("some ordinary text to search in");
  assert.equal(await matchQuote(i, { exact: "ordi" }), null, "< 8 chars");
  assert.equal(await matchQuote(i, { exact: "!!! --- ???" }), null, "punctuation-only");
});

test("exact first: an unedited quote scores 1.0 and reports zero errors", async () => {
  const i = idx("The kiln schedule shows a cone six soak on Thursday afternoon.");
  const m = await matchQuote(i, { exact: "cone six soak" });
  assert.ok(m);
  assert.equal(m!.errors, 0);
  assert.equal(m!.score, 1);
  assert.equal(i.text.slice(m!.start, m!.end), "cone six soak");
});

test("fuzzy: an edited quote is found with a visible penalty, not lost", async () => {
  // The C2 shape: 'Save' → 'Save changes' is the page; the record quotes the old copy.
  const i = idx("Press the button labelled Save changes when you are done editing.");
  const m = await matchQuote(i, { exact: "button labeled Save" }); // one edit + drift
  assert.ok(m, "an edit within maxErrors must still match");
  assert.ok(m!.errors > 0);
  assert.ok(m!.score >= 0.5 && m!.score < 1);
});

test("a rewrite past the threshold returns NULL — the orphan is the honest answer", async () => {
  const i = idx("Completely different words now live in this sentence about pottery.");
  assert.equal(await matchQuote(i, { exact: "the quarterly revenue dashboard" }), null);
});

test("prefix and suffix pick the RIGHT occurrence of a repeated quote (weights)", async () => {
  const i = idx(
    "In the morning the kiln runs hot. Later, near the cooling racks, the kiln runs hot again by design.",
  );
  const first = await matchQuote(i, { exact: "the kiln runs hot", prefix: "In the morning " });
  const second = await matchQuote(i, { exact: "the kiln runs hot", prefix: "the cooling racks, " });
  assert.ok(first && second);
  assert.ok(first!.start < second!.start, "context discriminates identical quotes");
});

test("the position hint is a tie-break, never a decider (2 points against 50)", async () => {
  const i = idx("alpha beta gamma delta. And far away: alpha beta gamma delta.");
  const late = await matchQuote(i, { exact: "alpha beta gamma delta" }, { hint: i.text.length });
  assert.ok(late);
  assert.equal(late!.start, i.text.indexOf("alpha beta gamma delta", 10), "hint breaks the tie toward itself");
});

test("windowing: a match beyond the first window is still found", async () => {
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do ".repeat(400);
  assert.ok(filler.length > FUZZY_WINDOW, "the fixture actually crosses a window");
  const target = "an unmistakably specific sentence about glaze chemistry";
  const i = idx(filler + target + " " + filler.slice(0, 500));
  const m = await matchQuote(i, { exact: "an unmistakably specifc sentence about glaze chemistry" }); // 1 edit
  assert.ok(m, "the window walk reaches past 20 K chars");
  assert.ok(m!.start > FUZZY_WINDOW);
});

test("a spent budget abandons the search rather than blocking", async () => {
  const filler = "words words words and more of the same words go here endlessly ".repeat(2000);
  const i = idx(filler);
  const m = await matchQuote(i, { exact: "a quote that is nowhere in that text at all" }, { budget: () => false });
  assert.equal(m, null, "budget-exhausted means abandon, not freeze");
});

test("normalisation applies to the QUOTE side too — a smart-quote record still exact-matches", async () => {
  const i = idx("It's fine - ship it, said the reviewer.");
  const m = await matchQuote(i, { exact: "It’s fine — ship it" });
  assert.ok(m);
  assert.equal(m!.errors, 0, "The fold makes typography churn a non-event");
});

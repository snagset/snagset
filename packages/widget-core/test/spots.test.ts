import { test } from "node:test";
import assert from "node:assert/strict";
import { spotLines } from "../src/screenshot/spots.ts";

/**
 * The blind-spot sentences, one per KIND (spots.ts).
 *
 * The bug this pins: a client page with six hotlinked images produced the
 * identical "1 image may appear as a placeholder" line six times, in the
 * widget's capture block and in the dashboard's brief. The rasteriser now
 * counts and this function words — so the count, the plural and the
 * one-line-per-kind rule are all asserted here, where no DOM is needed.
 */

test("six CORS-less images are ONE line, counted and pluralised — the own example row", () => {
  assert.deepEqual(spotLines({ corsImages: 6 }), [
    "6 images may appear as placeholders (served without CORS headers)",
  ]);
  assert.deepEqual(spotLines({ corsImages: 2 }), [
    "2 images may appear as placeholders (served without CORS headers)",
  ]);
});

test("the singular is the verbatim sentence, unchanged by the aggregation", () => {
  assert.deepEqual(spotLines({ corsImages: 1 }), [
    "1 image may appear as a placeholder (served without CORS headers)",
  ]);
  assert.deepEqual(spotLines({ failedImages: 1 }), ["1 image could not be included in the screenshot"]);
  assert.deepEqual(spotLines({ shadowRoots: 1 }), [
    "1 web component could not be captured (its contents are in a shadow root)",
  ]);
  assert.deepEqual(spotLines({ iframeHosts: ["js.stripe.com"] }), ["1 cross-origin iframe not captured: js.stripe.com"]);
  assert.deepEqual(spotLines({ taintedCanvases: 1 }), ["1 canvas could not be read (tainted by a cross-origin image)"]);
  assert.deepEqual(spotLines({ blankCanvases: 1 }), ["1 canvas may appear blank"]);
});

test("every kind aggregates — none of them repeats per element", () => {
  const lines = spotLines({
    failedImages: 3,
    shadowRoots: 2,
    iframeHosts: ["www.youtube.com", "www.youtube.com", "js.stripe.com"],
    taintedCanvases: 2,
    blankCanvases: 4,
    videos: 5,
    failedOverlays: 2,
  });
  assert.deepEqual(lines, [
    "3 images could not be included in the screenshot",
    "2 web components could not be captured (their contents are in shadow roots)",
    // Each host once: three embeds from two providers are two names.
    "3 cross-origin iframes not captured: www.youtube.com, js.stripe.com",
    "2 canvases could not be read (tainted by cross-origin images)",
    "4 canvases may appear blank",
    // The video sentence has no count, so it is said exactly once.
    "Video frames are not captured",
    "2 overlay elements could not be captured",
  ]);
  assert.equal(new Set(lines).size, lines.length);
});

test("an iframe whose host could not be parsed is counted but not named", () => {
  assert.deepEqual(spotLines({ iframeHosts: [""] }), ["1 cross-origin iframe not captured"]);
  assert.deepEqual(spotLines({ iframeHosts: ["", "js.stripe.com"] }), ["2 cross-origin iframes not captured: js.stripe.com"]);
});

test("nothing counted is nothing said — an empty array, never a zero line", () => {
  assert.deepEqual(spotLines({}), []);
  assert.deepEqual(spotLines({ corsImages: 0, videos: 0, iframeHosts: [] }), []);
});

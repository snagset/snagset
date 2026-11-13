import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAnchorLabel } from "../src/capture/label.ts";
import { deriveDisplay } from "../src/capture/derive.ts";

/**
 * `deriveAnchorLabel` and `deriveDisplay`.
 *
 * The label is what an ORPHANED PIN SAYS. At v0 there is no screenshot, so when
 * the element goes it is the only thing left explaining what the comment was
 * about — which is why its two suppression gates matter more than they look.
 */

/** A minimal Element stand-in. `closest` is what the mask gate reads. */
function el(
  tag: string,
  text: string,
  opts: { masked?: boolean; noInnerText?: boolean } = {},
): Element {
  const node = {
    tagName: tag.toUpperCase(),
    textContent: text,
    closest: (sel: string) => (opts.masked && sel.includes("mask") ? node : null),
  } as unknown as Element;
  if (!opts.noInnerText) (node as unknown as { innerText: string }).innerText = text;
  return node;
}

test("The label is the text, in typographic quotes", () => {
  assert.equal(deriveAnchorLabel(el("button", "Browse the autumn range")), "“Browse the autumn range”");
});

test("whitespace is collapsed before the cap, so the cap counts real characters", () => {
  assert.equal(deriveAnchorLabel(el("p", "  Book   a\n walkthrough ")), "“Book a walkthrough”");
});

test("52 characters, then a real ellipsis", () => {
  const long = "x".repeat(80);
  const out = deriveAnchorLabel(el("p", long));
  assert.equal(out, "“" + "x".repeat(52) + "…”");
  assert.ok(out.includes("…"), "U+2026, not three dots");
});

test("SENSITIVE TEXT NEVER BECOMES A LABEL", () => {
  // The gate the anchor core's fork did not have. An element whose text is a
  // customer's email went into the label, and from the label into the export —
  // which is exactly the path exists to close.
  const out = deriveAnchorLabel(el("p", "jane.doe@example.com"));
  assert.ok(!out.includes("jane.doe"), out);
  assert.equal(out, "the p", "it falls through to the tag, saying nothing it should not");
});

test("MASKED SUBTREES NEVER BECOME A LABEL", () => {
  // The other gate the fork did not have. Masking is a promise about a region
  // of the page, and quoting that region breaks it just as thoroughly as
  // screenshotting it would.
  const out = deriveAnchorLabel(el("div", "Account balance £12,480.22", { masked: true }));
  assert.ok(!out.includes("12,480"), out);
  assert.equal(out, "the div");
});

test("with no usable text, the tag is named the way a person would", () => {
  assert.equal(deriveAnchorLabel(el("img", "")), "an image");
  assert.equal(deriveAnchorLabel(el("a", "   ")), "a link");
  assert.equal(deriveAnchorLabel(el("button", "")), "a button");
  assert.equal(deriveAnchorLabel(el("section", "")), "the section");
});

test("textContent is the fallback when innerText is absent", () => {
  // innerText is an HTMLElement property; SVG and XML elements do not have it.
  assert.equal(deriveAnchorLabel(el("title", "Kiln", { noInnerText: true })), "“Kiln”");
});

test("the READ is bounded, not just the result", () => {
  // innerText forces layout and allocates the whole string first. Capping only
  // the output still pays for a megabyte on a section-sized element.
  const huge = "a".repeat(200_000);
  const t0 = performance.now();
  deriveAnchorLabel(el("section", huge));
  assert.ok(performance.now() - t0 < 50);
});

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

test("deriveDisplay: most specific browser first — Edge is not Chrome", () => {
  // The classic bug in this five-line function: Edge and Opera both carry
  // "Chrome/", and Chrome carries "Safari/".
  assert.equal(deriveDisplay(CHROME_MAC).browser, "Chrome");
  assert.equal(deriveDisplay(CHROME_MAC + " Edg/126.0.0.0").browser, "Edge");
  assert.equal(deriveDisplay(CHROME_MAC + " OPR/110.0.0.0").browser, "Opera");
  assert.equal(
    deriveDisplay("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15").browser,
    "Safari",
  );
});

test("deriveDisplay: an unknown browser reads as Unknown, and os may be empty", () => {
  // Not the prototype's "Browser" — the capture block renders
  // "browser · os", and "Browser · macOS" reads as an unfinished placeholder.
  const d = deriveDisplay("SomeCrawler/1.0");
  assert.equal(d.browser, "Unknown");
  assert.equal(d.os, "", "empty is the specified fallback — NOT the word Unknown");
  assert.equal(d.device, "Desktop");
});

test("deriveDisplay: client hints beat UA sniffing, and mobile is trusted first", () => {
  const hints = { brands: [{ brand: "Not/A)Brand", version: "8" }, { brand: "Brave", version: "126" }], platform: "Linux", mobile: false };
  const d = deriveDisplay(CHROME_MAC, hints);
  assert.equal(d.browser, "Brave", "the placeholder brand is skipped");
  assert.equal(d.os, "Linux");
  // A touchscreen laptop reports a coarse pointer and would be called Mobile by
  // pointer alone — which is why the hint is consulted first.
  assert.equal(d.device, "Desktop");
});

test("deriveDisplay survives an environment with no matchMedia", () => {
  // The listing calls it unguarded inside a ?? chain; there it throws and
  // takes the whole CaptureContext with it. The failure table has a row for
  // absent userAgentData and none for this.
  assert.equal(typeof (globalThis as { matchMedia?: unknown }).matchMedia, "undefined");
  assert.doesNotThrow(() => deriveDisplay(CHROME_MAC));
  assert.equal(deriveDisplay("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5)").device, "Mobile");
});

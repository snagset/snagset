// The CAPTURE catalogue, not the core one: this module ships in
// `snag.capture.js` and `label.text` moved there with it. `captureStrings`
// merges `en`, so every other key it renders still resolves.
import { hostAttr, cssClass } from "@snagset/types/names";
import { format } from "../strings/capture.ts";

/** The masking hooks — the attribute form and both class forms. */
const MASK_SELECTOR = [`[${hostAttr("mask")}]`, `.${cssClass("mask")}`, `.${cssClass("block")}`].join(", ");
import { isSensitiveValue } from "../redact/predicates.ts";

/**
 * `deriveAnchorLabel` — what was pinned, in words.
 *
 * This is what an ORPHANED PIN SAYS when there is no screenshot, which at v0 is
 * always: it is the entire fallback story in annotation mode (R5).
 * Written for a person reading a comment weeks later, so it names the thing the
 * way they would.
 *
 * ── Why it lives in src/capture/ and not in the anchor core ──
 *
 * The design owns it and exports it to 03, exactly like `isSensitiveValue`, and
 * AC C1e greps for "any 52-capped innerText slice outside src/capture/". The
 * anchor core carried its own fork, and the fork was not merely a duplicate —
 * it had NO SENSITIVITY GATE and NO MASK GATE, so an element whose text was a
 * customer's email address, or one the host page had explicitly marked
 * `data-snag-mask`, went straight into the label and from there into the
 * export. The `createElementAnchor` now calls this one.
 */

/**
 * Text that must not become a label.
 *
 * Two independent reasons, and both have to be checked here rather than at the
 * call site: the text may BE a secret, or the host page may have
 * declared this subtree off-limits with the masking hooks registers.
 * Masking is a promise about a region of the page, and a label is a way of
 * quoting that region.
 */
function suppressLabelText(el: Element, t: string): boolean {
  return (
    isSensitiveValue(t) ||
    // Built from the registry, never typed: The design forbids a literal token in
    // src/, and a rename that left this selector behind would silently stop
    // honouring a host's masking hooks — failing OPEN, which is the direction
    // that leaks.
    !!el.closest?.(MASK_SELECTOR)
  );
}

export function deriveAnchorLabel(el: Element): string {
  // BOUNDED READ. `innerText` forces layout and, on a section-sized element,
  // allocates a very large string before anything gets to cap it — so the cap
  // is on the read, not just on the result. Same principle as the pre-cap.
  const raw = ((el as HTMLElement).innerText ?? el.textContent ?? "").slice(0, 512);
  const t = raw.trim().replace(/\s+/g, " ");
  if (t && !suppressLabelText(el, t)) {
    // Typographic quotes, U+201C/U+201D, and a real ellipsis — carried by the
    // catalogue entry, because quotation marks are a translator's decision.
    // Asserts the English result byte-for-byte and still passes.
    return format("label.text", { text: t.length > 52 ? t.slice(0, 52) + "…" : t });
  }
  const tag = el.tagName.toLowerCase();
  return tag === "img"
    ? format("label.image")
    : tag === "a"
      ? format("label.link")
      : tag === "button"
        ? format("label.button")
        : format("label.tag", { tag });
}

/**
 * The label for a TEXT anchor: the quoted words, 52
 * capped, through the SAME two gates as an element label — the reviewer chose
 * this text, but choosing a secret does not license exporting it, and a
 * masked subtree's promise binds every way of quoting it.
 */
export function deriveQuoteLabel(el: Element, exact: string): string {
  const t = exact.trim().replace(/\s+/g, " ");
  if (t && !suppressLabelText(el, t)) {
    return format("label.text", { text: t.length > 52 ? t.slice(0, 52) + "…" : t });
  }
  return deriveAnchorLabel(el);
}

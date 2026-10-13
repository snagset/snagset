import { en } from "./en.ts";
import { make } from "./format.ts";

/**
 * The strings the CAPTURE chunk renders — the detail's capture block, the
 * anchor note, the device glyph, and the Markdown export.
 *
 * A third catalogue for the same packaging reason as the second: a bundler
 * cannot tree-shake object properties, so importing the whole panel catalogue
 * to render an export line dragged every dock and composer string into
 * `snag.capture.js` and pushed it 717 B past its budget. These are the keys
 * shared by the dock and the serialiser, so they live one level down and both
 * chunks reach them.
 *
 * en.ts's two rules still apply and are not restated: no brand literal, and no
 * sentence assembled from fragments.
 */
export const captureStrings = {


  // ── The detail's anchor note. Shown only when the anchor did
  // not settle. The studio copy, extended with the label because at v0 there
  // is no screenshot — the label is the entire remaining answer to "what was
  // this about". One sentence with a placeholder, never two joined.
  //
  // The design gives a client wording too; roles are v1, and v0 is studio-first.
  // The Details disclosure — an orphan's only route to its own record.
  "detail.details": "Anchor details",
  // Verbatim: the hidden-anchor note and its override. In
  // the detail.* family, so it lives in the SHARED half — the dock and the
  // serialiser both format `detail.${…}` templates, and the family must be
  // whole wherever either lands.
  "detail.hidden":
    "This element isn't visible right now — it may be inside a closed menu, tab, or accordion.",
  "detail.orphaned": "The element this was pinned to has moved or gone — it was {label}.",
  "detail.approximate": "The page changed since this was written, so the pin is close rather than exact — it points at {label}.",
  // F-04b: an orphan that never got its extension rungs says so
  // "the matcher didn't load" is a different fact from "the element is gone",
  // and a reviewer deciding whether to re-pin deserves to know which.
  "detail.unavailable": "Some of the matching steps couldn't load, so this was judged with the basic ones only.",
  // The query page identity discarded, with a way back
  // to the exact URL. In the CAPTURE catalogue because every detail.* key
  // lives here: the dock and the serialiser both reach this family.
  "detail.filedat": "Filed at {query}.",
  "detail.openquery": "Open with original query",

  "capture.agent": "{browser} · {os}",
  // An empty `os` drops the separator with it. `os` is legitimately ""
  // on an unrecognised platform, and "Chrome · " is worse than "Chrome".
  "capture.agent.noos": "{browser}",
  "capture.device": "{device} · {w}×{h} @{dpr}x",
  // Again: "@1x is suppressed entirely — a dpr line that says @1x is
  // noise on the majority of desktops."
  "capture.device.at1x": "{device} · {w}×{h}",

} as const;

/** Core plus these. What `snag.capture.js` renders with, and nothing more. */
/**
 * Rendered by THIS chunk and nothing else — named for its audience, not its
 * contents, because that is what decides where a string goes.
 *
 * A second export rather than more keys in `captureStrings`, because panels.ts
 * merges that one to draw the detail's capture block, and these would have
 * ridden along into a chunk with no hint pill and no highlight chip to put them
 * in. The rule from en.ts, one level down: which chunks can render it?
 */
export const captureOnly = {
  // ── Export.
  "export.title": "{product} — {origin}",
  "export.summary.one": "1 comment, {unresolved} unresolved · exported {date}",
  "export.summary.many": "{total} comments, {unresolved} unresolved · exported {date}",
  "export.heading": "{n} · {key} — {status}",
  // The design names it verbatim: On “<AnchorRecord.label>”. The label already
  // carries its own typographic quotes, so this key must NOT add a
  // second pair — AC G3 asserts the exported label equals the stored one
  // byte-for-byte.
  "export.on": "On {label}",
  "export.device": "Device",
  // Labelled "Selector" rather than "CSS", because the reader
  // is a developer about to paste it into a querySelector or a grep.
  "export.selector": "Selector",
  "export.by": "By",
  "export.nobody": "_(no comment)_",

  // The virtual-cursor announcements. Whole sentences: the
  // live region reads exactly what it is handed. `cursor.here` covers the
  // unnamed element and the [ / ] excursion, which is outside the ordered
  // set and therefore has no "n of m" to give.
  // The proxy button IS the control, as far as a screen reader is concerned:
  // it holds real focus for all of `add` and takes every key. So it is named
  // for what it does, not hidden — an unnamed focusable button is an axe
  // violation and, worse, announces as nothing at all.
  "cursor.proxy": "Pick an element — Tab to move, Enter to comment",
  "cursor.at": "{role}, {name}, {i} of {n}",
  "cursor.here": "{role} {name}",
  // The reference-image alt text. The definition itself is a data:
  // URI at the file's foot — reference-style so the body stays readable in
  // the paste-into-a-ticket case the export exists for.
  "export.screenshot": "Screenshot {key}",
  // The quoted element text an anchor label is built from. `deriveAnchorLabel`
  // ships in this chunk and is its only caller — the runtime's own fallback
  // names the tag and reads no text at all — so keeping it in en.ts put a
  // string in the eager chunk that nothing eager could reach.
  "label.text": "“{text}”",

  // ── Add mode's redundant signals, which ship in THIS chunk because
  // the chrome that draws them does. The hint copy is the
  // prototype's, validated by use — it replaced a toolbar status line that was
  // invisible at the moment of the click, because the reviewer was looking at
  // the element rather than at the toolbar.
  "hint.fine": "Click anything to comment — Esc when done",
  "hint.coarse": "Tap anything to comment",
  "highlight.chip": "{tag} · {name} · {w}×{h}",
  "highlight.chip.unnamed": "{tag} · {w}×{h}",
} as const;

export const format = make({ ...en, ...captureStrings, ...captureOnly });
export { count, when } from "./format.ts";

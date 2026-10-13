import { make } from "./format.ts";

/**
 * Every user-visible string in the widget, in one module (the v0 row).
 *
 * A flat `Record<string, string>` and one `format(key, params)` helper — no
 * catalogue loader, no negotiation chain, no plural machinery, no CI lint.
 * Those are all v1, and the shape here is chosen so that adding them is
 * additive: a flat map of `{placeholder}` templates dumps straight to
 * `locales/<lang>.json`, which a map of FUNCTIONS could never do.
 *
 * ── Two rules that are easy to break and expensive to fix ──
 *
 * **No brand literal may appear below.** Not "Snagset", and — the subtler one —
 * not "snag" either: the item noun is `TERM_ITEM`, derived from the brand's
 * short form. The composer's placeholder used to read "What's the snag?" as a
 * plain literal, so flipping the brand to Gasket left it silently saying
 * "snag". `format()` merges the brand into every call as standing params, so
 * entries say `{item}` and a translator never sees the product name at all.
 *
 * **No sentence is assembled from fragments.** A key holds a whole sentence
 * with its placeholders; word order and punctuation belong to the translator,
 * not to whichever `.join(" · ")` happened to be nearest. Several strings here
 * were previously built by concatenation in three different files, which is
 * why the same fact was phrased three different ways.
 *
 * Numbers go through `Intl.NumberFormat` at the call site, and dates through
 * `Intl.DateTimeFormat` — but `SN-14` and the round numbers stay Latin
 * digits in every locale, because they are identifiers people quote aloud.
 *
 * ── This file is the SHARED half, and only the shared half ──
 *
 * There are four catalogues, and each holds what exactly one audience renders:
 *
 *   en.ts       strings MORE THAN ONE chunk renders — this file
 *   runtime.ts  the toolbar, pins, add-mode chrome, notices
 *   capture.ts  the detail's capture block and the Markdown export
 *   panels.ts   the dock and the composer
 *
 * Each of the last three merges this one, so a component never has to know
 * which file a key lives in. The split exists because a bundler cannot
 * tree-shake properties out of an object literal: every string in a shared
 * object ships inside EVERY chunk that touches the object, whether or not
 * anything there can draw it. Measured, not assumed — a source-map breakdown
 * put the catalogues at 16.6% of `snag.panels.js`, most of it toolbar and
 * notice copy no panel will ever render.
 *
 * ONE QUESTION decides where a key goes: can more than one chunk render it?
 * `status.*` and `where.*` look like runtime concerns and are not — the dock
 * and the Markdown export reach them through `statusLabel()` and `whereText()`,
 * so they are shared. `error.panels` can only ever reach the vanilla notice, so
 * it is not.
 */
export const en = {
  // ── What an anchor points at, in words. ONE key set for the three states,
  // taking the label as a param, rather than the three separate phrasings that
  // used to live in pins.ts, dock.tsx and serialize.ts and disagree with each
  // other — which is exactly why these are shared rather than runtime-only.
  "where.anchored": "{label}",
  "where.approximate": "position approximate — the page changed",
  "where.orphaned": "moved — the element is gone",

  // ── The four statuses. The LABELS live here and the colours do not: The
  // v0 row is explicit that translating *In progress* must never require
  // touching a colour.
  "status.open": "Active",
  "status.progress": "In progress",
  "status.review": "In review",
  "status.resolved": "Resolved",

  // ── People. "You" is wrong the moment anybody else reads the round, which is
  // the entire point of the product.
  "author.unknown": "Someone",

  // ── What an anchor points at, in words. This is the WHOLE fallback story in
  // annotation mode (R5) — with no bucket there is no screenshot, so
  // this sentence is all an orphaned comment has left to explain itself.
  //
  // The design gives these as bare English literals inside the redaction module,
  // and asserts the quoted form byte-for-byte. They live here instead
  // because the design requires translation from v0 and this file forbids building
  // a sentence out of fragments — `"the " + tag` is exactly that. The English
  // values are unchanged, so A14 still holds.
  "label.image": "an image",
  "label.link": "a link",
  "label.button": "a button",
  "label.tag": "the {tag}",
} as const;

export type StringKey = keyof typeof en;

/** `format("pin.title", { key: "SN-4", where: "the header" })`. See format.ts. */
export const format = make(en);

export { count, when } from "./format.ts";

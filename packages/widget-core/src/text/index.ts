/**
 * snag.text.js — creation-side text picking, the TENTH artefact.
 *
 * Loaded when the reviewer enters the TEXT sub-mode of `add`, and
 * never before: a session that only ever pins elements pays nothing for any
 * of this. It exists as its own chunk because the machinery outgrew every
 * home it was tried in — the capture chunk's 14 KB is metadata + redaction +
 * the anchor recorder and went 2 KB over with this inside; anchor-ext's 4 KB
 * is resolution steps with no room for a creation index.
 *
 * Contents: the selection watcher (highlight + Comment chip), the TextIndex
 * build and boundary mapping (the creation half), the quote
 * policies, and `createTextAnchor` composing them into a full record. All of
 * it SELF-CONTAINED: the labels, selectors and index it needs are
 * bundled from the same source files the other chunks bundle theirs from.
 */
export { createTextAnchor, type TextAnchorResult } from "./create.ts";
export { createSelectionWatcher, type SelectionWatcher } from "./select.ts";

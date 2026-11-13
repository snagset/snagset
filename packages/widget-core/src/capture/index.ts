// snag.capture.js — the metadata snapshot and the redaction rules.
//
// Specified this home from the start and it is finally the right one.
// Inverted the dependency — "one copy, in snag.runtime.js"
// on the grounds that 03's selector guard needs `isSensitiveValue` at pin time
// in the eager chunk. That premise turned out to be false: anchor CREATION only
// ever happens with the composer open, so everything here is reachable only
// once a panel is loading. Anchor RESOLUTION, which does run eagerly at load,
// needs none of it.
//
// LAZY, which is what keeps it out of the activation envelope
// the sum the design makes normative is the EAGER chunks. A reviewer who activates and
// only reads a round never downloads a redaction rule. Preloaded by the runtime
// on entering `add`, so the composer never waits on it.
export { captureContext, derivePageRef } from "./context.ts";
export { deriveAnchorLabel, deriveQuoteLabel } from "./label.ts";
export { isSensitiveValue, redactText, redactUrl } from "../redact/predicates.ts";
export type { CaptureContext, PageRef, UaData } from "./types.ts";

// The export serialiser lives here too, and AC G5 is why rather than bytes:
// it requires "a v0 Markdown/JSON export produced with snag.panels.js NEVER
// LOADED" to still carry a correct capture.reasons[]. In the Preact chunk that
// is impossible. Does assign the export to snag.panels.js, and the
// AC G5 contradicts it — this follows the acceptance criterion, because the
// criterion states a behaviour and the table states a filename.
//
// It also belongs here on the merits: what it serialises is captured data, and
// every line it renders about the device and the viewport comes from this
// module. Same chunk, same lifetime, no Preact.
export { buildExport, download } from "../export/serialize.ts";
// The async halves — blob-store refs to data: URIs and back.
export { importArchive, resolveAttachmentUris } from "../export/attachments.ts";
// The blob store's write half, handed to the local adapter by the runtime —
// this chunk already carries the module (export/attachments.ts imports it),
// so the EAGER runtime does not have to (the injection, the boundary).
export { deleteBlob, getBlob, putBlob } from "../storage/blobs.ts";
// The widen/narrow primitive (the steppers, the virtual cursor). Both
// callers live behind `add`, which cannot be entered without this chunk — so
// it is lazy by the same argument as the add chrome beside it.
export { narrow, widen } from "../runtime/cursor.ts";
// The keyboard virtual cursor. Not exported as a separate
// entry point: `createAddChrome` owns it, because `setActive` already fires
// on every mode change and a second handle in the runtime is eager bytes for
// nothing. `candidates` is exported for the unit test alone.
export { candidates } from "./cursor.ts";

// Add mode's on-page chrome — the highlight, its chip and the hint pill. Same
// argument as the recorder below: F-04 disables `+` without the panels chunk,
// so none of it can be reached unless a composer is on its way.
export { createAddChrome, type AddChrome } from "./highlight.ts";

// Anchor RECORDING. It sat in the eager runtime, which contradicted
// this file's own opening paragraph: creation only ever happens with the
// composer open, and `add()` already reaches in here for the other two
// creation-time judgements — the label and the selector. Resolution, which runs
// on every page load for every pin, imports `resolve.ts` and none of this.
//
// `accessibleNameOf` stays exported from `anchor/record.ts` as well, because
// the add-mode highlight chip names the element under the cursor and that is
// eager by nature. One small function duplicated into a lazy chunk is the right
// side of the trade.
export { createElementAnchor } from "../anchor/record.ts";

// Selector generation. Creation-time only — RESOLUTION, which runs on
// every page load, needs none of it — so the runtime injects the result rather
// than importing the generator.
export { describeElement, generateCss, isStableId, isUsableAttrValue } from "./selector.ts";
// The runtime rebuilds `context.capture` when the screenshot outcome
// lands (the shot finishes AFTER the T0 snapshot), through the same
// table the spec-extraction test pins.
export { applyShotOutcome, captureReport, type ScreenshotSituation } from "./report.ts";

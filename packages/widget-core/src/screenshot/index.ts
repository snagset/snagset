/**
 * snag.screenshot.js — the zero-dependency screenshot engine.
 *
 * In full: the foreignObject rasteriser (the prototype's ~40
 * lines with the fidelity work bought one disclosed blind spot at a time),
 * scope and crop, self-exclusion by removal, overlay
 * suppress-and-composite, two-stage masking that fails CLOSED,
 * the byte-budgeted encode ladder (shared machinery for
 * the attachments later), named blind spots and the degradation
 * ladder (by option and scope reduction, NEVER by engine swap; stage
 * 4 deleted, the widget never records).
 *
 * Loaded on FIRST CAPTURE only, never on activation.: no
 * third-party engine exists to pin — verify-dist asserts no node_modules
 * module resolves into this artefact.
 */

export const CHUNK = "screenshot" as const;

export { captureScreenshot, type CaptureOptions, type CaptureOutcome } from "./capture.ts";
export { probeDataImages, rasterise, type RasterOptions, type RasterResult } from "./raster.ts";
export { encodeToBudget, canEncodeWebp, TARGET_BYTES, MAX_LONGEST_SIDE } from "./encode.ts";

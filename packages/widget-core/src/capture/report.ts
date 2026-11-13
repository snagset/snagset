import type { CaptureContext } from "./types.ts";

/**
 * `CaptureContext.capture` — honest degradation reporting.
 *
 * One table, ALL .5's rows, including the ones whose producers do not
 * exist yet: the screenshot engine is, per-category config is the
 * attribute work, and the reviewer-removed row needs the detail's toggle. The
 * table ships complete anyway, because the alternative is inventing
 * sentences under deadline — and the sentences are NORMATIVE: renders
 * `reasons[]` verbatim to the reviewer, so wording drift is a product bug.
 *
 * test/report.test.ts extracts the markdown table FROM THE SPEC FILE and
 * asserts every (status, sentence) pair below against it — the same
 * spec-is-the-source mechanism as the redaction corpus, and for the same
 * reason: a table restated by hand in two places is two tables.
 */

export type ScreenshotSituation =
  | "ok"
  | "release" // v0/v0.1 — the engine is not in this release
  | "config-off" // `screenshot: false` in any config source
  | "feature-off" // v1: server advertises features.screenshots false — same sentence, config state not failure
  | "reviewer-removed"
  | "csp-blocked" // img-src probe failed
  | "engine-load-failed" // the chunk's import() failed
  | "engine-failed" // ladder exhausted after a throw
  | "timeout"
  | "tainted"
  | "scope-forced" // raster budget exceeded — still 'ok', with an explanation
  | "masking-failed" // Fails CLOSED: no verified mask, no screenshot
  | "navigated"; // the page changed mid-capture

type ScreenshotStatus = NonNullable<NonNullable<CaptureContext["capture"]>["screenshot"]>;

export const SCREENSHOT_REPORT: Record<ScreenshotSituation, { status: ScreenshotStatus; reason?: string }> = {
  ok: { status: "ok" },
  release: { status: "disabled", reason: "Screenshots are not available in this release." },
  "config-off": { status: "disabled", reason: "Screenshots are switched off for this project." },
  "feature-off": { status: "disabled", reason: "Screenshots are switched off for this project." },
  "reviewer-removed": { status: "disabled", reason: "You removed the screenshot before sending." },
  "csp-blocked": {
    status: "failed",
    reason: "Your Content-Security-Policy blocks data: images, so no screenshot could be taken.",
  },
  "engine-load-failed": { status: "failed", reason: "The screenshot engine could not be loaded." },
  "engine-failed": { status: "failed", reason: "The screenshot engine failed on this page." },
  timeout: { status: "timeout", reason: "The screenshot timed out." },
  tainted: { status: "tainted", reason: "A cross-origin image made the page canvas unreadable." },
  "scope-forced": {
    status: "ok",
    reason: "The page was too large to capture in full; captured the area around your pin.",
  },
  "masking-failed": { status: "failed", reason: "Masking could not be verified, so the screenshot was discarded." },
  navigated: { status: "failed", reason: "The page changed while the screenshot was being taken." },
};

/** The breadcrumb sentences are the obligation but not the table — the
 *  category has three states and only the two degraded ones get a sentence,
 *  because reasons explain what DIDN'T happen. */
const BREADCRUMB_REASON: Record<"disabled" | "truncated", string> = {
  disabled: "Console and network capture is off for this project.",
  truncated: "Earlier console and network entries were dropped to fit the buffer.",
};

export interface CaptureReportInput {
  screenshot?: ScreenshotSituation; // default "release" until wires the engine
  breadcrumbs?: "ok" | "disabled" | "truncated";
  /** The detected blind spots, disclosure text verbatim — producer is. */
  blindSpots?: string[];
  /** The shed categories, in drop order — producer is the assembly. */
  droppedCategories?: string[];
  /** Stage 2's count of painted mask rects — producer is. */
  maskedCount?: number;
}

export function captureReport(input: CaptureReportInput = {}): NonNullable<CaptureContext["capture"]> {
  const shot = SCREENSHOT_REPORT[input.screenshot ?? "release"];
  const bc = input.breadcrumbs ?? "disabled";
  const reasons: string[] = [];
  if (shot.reason) reasons.push(shot.reason);
  if (bc !== "ok") reasons.push(BREADCRUMB_REASON[bc]);

  const out: NonNullable<CaptureContext["capture"]> = {
    screenshot: shot.status,
    breadcrumbs: bc,
    reasons,
  };
  // Omitted, never empty — the design is a closed type and checks "no extra
  // keys"; an empty array claims the producer ran and found nothing, which is
  // a different statement from "the producer does not exist yet".
  if (input.blindSpots?.length) out.blindSpots = input.blindSpots;
  if (input.droppedCategories?.length) out.droppedCategories = input.droppedCategories;
  if (input.maskedCount !== undefined && input.maskedCount > 0) out.maskedCount = input.maskedCount;
  return out;
}

/**
 * Rebuild a context's `capture` from a finished shot. Lives in the
 * CAPTURE chunk so the runtime's eager surface stays a function call: the
 * shot finishes after the T0 snapshot, and this is the one place the
 * table is applied to it.
 */
export function applyShotOutcome(
  context: CaptureContext,
  shot: { situation: ScreenshotSituation; blindSpots: string[]; maskedCount: number } | null,
  configOff: boolean,
  /** The mobile opt-in was left unticked. The nearest
   *  row is reviewer-removed — it IS the reviewer's-choice row, though its
   *  sentence says "removed" for a screenshot never taken; flagged for an
   *  A-series wording amendment rather than a new unregistered sentence. */
  declined = false,
): void {
  const bc = context.capture?.breadcrumbs ?? "disabled";
  if (configOff) {
    context.capture = captureReport({ screenshot: "config-off", breadcrumbs: bc });
    return;
  }
  if (declined && !shot) {
    context.capture = captureReport({ screenshot: "reviewer-removed", breadcrumbs: bc });
    return;
  }
  if (!shot) return;
  context.capture = captureReport({
    screenshot: shot.situation,
    breadcrumbs: bc,
    ...(shot.blindSpots.length ? { blindSpots: shot.blindSpots } : {}),
    ...(shot.maskedCount > 0 ? { maskedCount: shot.maskedCount } : {}),
  });
}
